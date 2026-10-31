const router = require('express').Router();
const PDFDocument = require('pdfkit');
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, listQuery } = require('../../utils/validate');
const { authorize } = require('../../middleware/auth');
const { notFound } = require('../../utils/errors');
const { fmtDate } = require('../../utils/dates');
const { D } = require('../../utils/money');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere, assertEmployeeAccess } = require('../../services/scope');
const { BRAND, LOGO } = require('../../services/exporter');
const audit = require('../../services/audit');

// Payslips are only visible to the employee or to users whose payslips.view scope covers that employee.
const load = async (ctx, id) => {
  const p = await prisma.payslip.findFirst({
    where: { id, companyId: ctx.companyId, status: { not: 'VOID' } },
    include: { runEmployee: { include: { lines: { orderBy: { sortOrder: 'asc' } }, run: { select: { runNumber: true, period: { select: { name: true } } } } } } },
  });
  if (!p) throw notFound();
  await assertEmployeeAccess(ctx, p.employeeId, 'payslips.view');
  const { iban, ...snapshot } = p.runEmployee.snapshot || {};
  return { ...p, runEmployee: { ...p.runEmployee, snapshot } };
};

router.get('/', authorize('payslips.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, status: { not: 'VOID' } };
  if (q.mine === 'true') where.employeeId = req.ctx.employeeId || '-';
  else where.employee = await employeeWhere(req.ctx, 'payslips.view');
  if (q.year) where.periodStart = { gte: new Date(Date.UTC(Number(q.year), 0, 1)), lte: new Date(Date.UTC(Number(q.year), 11, 31)) };
  if (q.month && q.year) where.periodStart = { gte: new Date(Date.UTC(Number(q.year), Number(q.month) - 1, 1)), lt: new Date(Date.UTC(Number(q.year), Number(q.month), 1)) };
  if (q.employeeId) where.employeeId = q.employeeId;
  if (q.runId) where.runId = q.runId;
  if (q.search) where.OR = [{ number: { contains: q.search } }, { employee: { OR: [{ firstName: { contains: q.search } }, { lastName: { contains: q.search } }, { employeeNumber: { contains: q.search } }] } }];
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.payslip.findMany({ where, include: { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } } }, orderBy: { periodStart: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.payslip.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));

router.get('/:id', authorize('payslips.view'), ah(async (req, res) => {
  const p = await load(req.ctx, req.params.id);
  await prisma.payslipDownloadLog.create({ data: { payslipId: p.id, userId: req.ctx.userId, format: 'VIEW', ip: req.ip } });
  res.json({ ...p, company: { nameAr: req.ctx.company.nameAr, nameEn: req.ctx.company.nameEn, logoFileId: req.ctx.company.logoFileId } });
}));

const money = (v, cur) => `${D(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${cur}`;

router.get('/:id/pdf', authorize(['payslips.print', 'payslips.view']), ah(async (req, res) => {
  const p = await load(req.ctx, req.params.id);
  await prisma.payslipDownloadLog.create({ data: { payslipId: p.id, userId: req.ctx.userId, format: 'PDF', ip: req.ip } });
  await audit.record(req.ctx, { action: 'PAYSLIP_DOWNLOADED', entityType: 'Payslip', entityId: p.id, employeeId: p.employeeId });
  const s = p.runEmployee.snapshot;
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.number}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  doc.pipe(res);
  const W = doc.page.width;
  const H = doc.page.height;
  // letterhead style (from SEEDA stationery): left purple/navy bar, bottom wave bars
  doc.rect(0, 0, 18, 260).fill(BRAND.purple);
  doc.rect(0, 260, 14, 200).fill(BRAND.navy);
  doc.rect(0, H - 22, W * 0.45, 22).fill(BRAND.purple);
  doc.rect(W * 0.45, H - 18, W * 0.25, 18).fill(BRAND.navy);
  doc.rect(W * 0.7, H - 12, W * 0.3, 12).fill(BRAND.gray);
  try { doc.image(LOGO, W - 200, 36, { height: 46 }); } catch { /* optional */ }
  doc.fillColor(BRAND.navy).fontSize(20).text('PAYSLIP', 50, 44);
  doc.fillColor('#666').fontSize(9).text(req.ctx.company.nameEn, 50, 70).text(`Payslip No. ${p.number}`, 50, 84).text(`Period: ${fmtDate(p.periodStart)} to ${fmtDate(p.periodEnd)}   Payment date: ${fmtDate(p.paymentDate)}`, 50, 98);

  let y = 130;
  doc.roundedRect(50, y, W - 100, 78, 6).fill('#F4F2F9');
  const info = [['Employee', s.nameEn], ['Employee ID', s.employeeNumber], ['Job title', s.titleEn || '-'], ['Department', s.departmentEn || '-'], ['Branch', s.branchEn || '-'], ['Bank account', s.ibanMasked || s.paymentMethod]];
  info.forEach(([k, v], i) => {
    const col = i % 2; const row = Math.floor(i / 2);
    doc.fillColor('#888').fontSize(8).text(k, 64 + col * 250, y + 12 + row * 21);
    doc.fillColor('#222').fontSize(10).text(String(v ?? '-'), 140 + col * 250, y + 11 + row * 21, { width: 160, ellipsis: true, lineBreak: false });
  });

  y += 100;
  const lines = p.runEmployee.lines;
  const colW = (W - 110) / 2;
  const table = (title, items, x) => {
    let yy = y;
    doc.rect(x, yy, colW, 22).fill(BRAND.purple);
    doc.fillColor('#fff').fontSize(10).text(title, x + 10, yy + 6);
    yy += 26;
    items.forEach((l, i) => {
      if (i % 2) doc.rect(x, yy - 3, colW, 18).fill('#FAFAFC');
      doc.fillColor('#333').fontSize(9).text(l.nameEn, x + 10, yy, { width: colW - 110, ellipsis: true, lineBreak: false });
      doc.text(money(l.amount, p.currency), x + colW - 110, yy, { width: 100, align: 'right' });
      yy += 18;
    });
    return yy;
  };
  // one display row per component (e.g. many commission entries → one "Commissions" row)
  const grouped = (type) => {
    const m = new Map();
    for (const l of lines.filter((x) => x.type === type)) {
      const acc = m.get(l.code) || { ...l, amount: D(0) };
      acc.amount = acc.amount.plus(l.amount);
      m.set(l.code, acc);
    }
    return [...m.values()];
  };
  const e = grouped('EARNING');
  const d = grouped('DEDUCTION');
  const endY = Math.max(table('Earnings', e, 50), table('Deductions', d, 60 + colW));
  y = endY + 10;
  doc.moveTo(50, y).lineTo(W - 50, y).strokeColor(BRAND.gray).stroke();
  y += 12;
  doc.fillColor('#555').fontSize(10).text('Total earnings', 60, y).text(money(p.grossEarnings, p.currency), 60 + colW - 120, y, { width: 100, align: 'right' });
  doc.text('Total deductions', 70 + colW, y).text(money(p.totalDeductions, p.currency), 60 + 2 * colW - 110, y, { width: 100, align: 'right' });
  y += 34;
  doc.roundedRect(50, y, W - 100, 46, 6).fill(BRAND.navy);
  doc.fillColor('#fff').fontSize(12).text('NET SALARY', 66, y + 16);
  doc.fontSize(18).text(money(p.netSalary, p.currency), W - 300, y + 12, { width: 234, align: 'right' });
  y += 62;
  doc.fillColor('#666').fontSize(9).text(`Payment status: ${p.status === 'PAID' ? 'Paid' : 'Issued (awaiting payment)'}`, 50, y);
  doc.fillColor('#999').fontSize(7).text('This payslip is generated from a locked payroll run in SEEDA HRMS. Arabic version: open the payslip in the portal and use Print.', 50, H - 60, { width: W - 100 });
  doc.end();
}));

router.get('/:id/downloads', authorize('payslips.settings'), ah(async (req, res) => {
  await load(req.ctx, req.params.id);
  res.json({ items: await prisma.payslipDownloadLog.findMany({ where: { payslipId: req.params.id }, orderBy: { createdAt: 'desc' } }) });
}));

module.exports = router;
