// Mounted twice: /advances (kind=advance) and /loans (kind=loan)
const express = require('express');
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, optDate, positiveMoney, optMoney, listQuery } = require('../../utils/validate');
const { authorize, hasPermission, requireCompany } = require('../../middleware/auth');
const { forbidden, notFound } = require('../../utils/errors');
const { fmtDate } = require('../../utils/dates');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere } = require('../../services/scope');
const { empName } = require('../../services/common');
const approvals = require('../../services/approvals');
const exporter = require('../../services/exporter');
const service = require('./loans.service');
const settlement = require('./settlement.service');

const build = (kind) => {
  const router = express.Router();
  const k = service.KIND[kind];
  const p = (a) => `${k.perm}.${a}`;
  const model = prisma[k.model];

  router.get('/', authorize(p('view')), validate({ query: listQuery }), ah(async (req, res) => {
    const q = req.validQuery;
    const where = { companyId: req.ctx.companyId, ...(q.mine === 'true' ? { employeeId: req.ctx.employeeId || '-' } : { employee: await employeeWhere(req.ctx, p('view')) }), ...(q.status ? { status: { in: q.status.split(',') } } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search } }, { employee: { OR: [{ firstName: { contains: q.search } }, { lastName: { contains: q.search } }, { employeeNumber: { contains: q.search } }] } }];
    const include = { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } }, installments: { select: { amount: true, paidAmount: true, status: true } } };
    if (q.format && q.format !== 'json') {
      if (!hasPermission(req.ctx, p('export'))) throw forbidden('PERMISSION_DENIED');
      const rows = await model.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 20000 });
      return exporter.send(res, q.format, {
        title: kind === 'loan' ? 'Loans' : 'Advances', filename: `${kind}s`, rows,
        columns: [{ header: 'Number', key: 'number' }, { header: 'Employee', value: (r) => empName(r.employee) }, { header: 'Amount', value: (r) => Number(r.amount) }, { header: 'Installments', key: 'installmentCount' }, { header: 'Paid', value: (r) => r.installments.reduce((s, i) => s + Number(i.paidAmount), 0) }, { header: 'Status', key: 'status' }, { header: 'Requested', value: (r) => fmtDate(r.requestDate) }],
      });
    }
    const paging = parsePaging(q);
    const [items, total] = await Promise.all([model.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }), model.count({ where })]);
    res.json(paged(items.map((r) => ({ ...r, paid: r.installments.reduce((s, i) => s + Number(i.paidAmount), 0).toFixed(2), installments: undefined })), total, paging));
  }));

  const createSchema = kind === 'advance'
    ? z.object({ employeeId: optId, amount: positiveMoney, reason: optStr(1000), requestedPaymentDate: optDate, repaymentMethod: z.enum(['PAYROLL', 'MANUAL']).optional(), installmentCount: z.coerce.number().int().min(1).max(24).default(1), firstDeductionDate: optDate, attachmentId: optId, notes: optStr(1000) })
    : z.object({ employeeId: optId, amount: positiveMoney, loanType: z.enum(['PERSONAL', 'HOUSING', 'EDUCATION', 'MEDICAL', 'OTHER']).optional(), reason: optStr(1000), installmentCount: z.coerce.number().int().min(1).max(120), monthlyInstallment: optMoney, firstDeductionDate: optDate, repaymentMethod: z.enum(['PAYROLL', 'MANUAL']).optional(), feeAmount: optMoney, attachmentId: optId });

  router.post('/', authorize(p('create')), validate({ body: createSchema }), ah(async (req, res) => res.status(201).json(await service.create(req.ctx, kind, req.body))));
  router.get('/:id', requireCompany, ah(async (req, res) => {
    // assigned approvers may open the request they must decide even without module access
    const isApprover = await prisma.approvalTask.count({ where: { approverUserId: req.ctx.userId, instance: { companyId: req.ctx.companyId, entityType: k.entity, entityId: req.params.id } } });
    if (!isApprover && !hasPermission(req.ctx, p('view'))) throw forbidden('PERMISSION_DENIED', { permission: p('view') });
    res.json(await service.detail(isApprover ? { ...req.ctx, isSuperAdmin: true } : req.ctx, kind, req.params.id));
  }));

  const decide = (decision) => ah(async (req, res) => {
    const task = await prisma.approvalTask.findFirst({ where: { approverUserId: req.ctx.userId, status: 'PENDING', instance: { companyId: req.ctx.companyId, entityType: k.entity, entityId: req.params.id, status: 'PENDING' } } });
    if (!task) throw forbidden('NOT_YOUR_APPROVAL');
    res.json(await approvals.act(req.ctx, task.id, decision, req.body?.comment));
  });
  // The workflow decides who approves (e.g. the direct manager); being the assigned approver is the authorization.
  router.post('/:id/approve', requireCompany, validate({ body: z.object({ comment: optStr(1000) }) }), decide('APPROVE'));
  router.post('/:id/reject', requireCompany, validate({ body: z.object({ comment: str(1000) }) }), decide('REJECT'));
  router.post('/:id/disburse', authorize(p('edit')), validate({ body: z.object({ disbursedAt: z.string().datetime().optional(), note: optStr(500) }) }), ah(async (req, res) => res.json(await service.disburse(req.ctx, kind, req.params.id, req.body))));
  router.post('/:id/repay', authorize(p('edit')), validate({ body: z.object({ amount: positiveMoney, note: str(500) }) }), ah(async (req, res) => res.json(await service.repay(req.ctx, kind, req.params.id, req.body))));
  router.post('/:id/installments/:installmentId/defer', authorize(p('approve')), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => res.json(await service.deferInstallment(req.ctx, kind, req.params.id, req.params.installmentId, req.body.reason))));
  router.post('/:id/cancel', authorize(p('view')), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => { await service.cancel(req.ctx, kind, req.params.id, req.body.reason); res.status(204).end(); }));
  return router;
};

// Employee financial statement + settlements
const extra = express.Router();
extra.get('/statement/:employeeId', authorize(['advances.view', 'loans.view']), ah(async (req, res) => res.json(await service.statement(req.ctx, req.params.employeeId))));
extra.get('/settlements', authorize(['loans.view', 'payroll.view']), ah(async (req, res) => {
  const items = await prisma.employeeSettlement.findMany({ where: { companyId: req.ctx.companyId, employee: await employeeWhere(req.ctx, ['loans.view', 'payroll.view']) }, include: { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } } }, orderBy: { createdAt: 'desc' } });
  res.json({ items });
}));
extra.get('/settlements/:id', authorize(['loans.view', 'payroll.view']), ah(async (req, res) => {
  const s = await prisma.employeeSettlement.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { employee: true } });
  if (!s) throw notFound();
  res.json(s);
}));
extra.post('/settlements/:id/refresh', authorize('loans.edit'), ah(async (req, res) => res.json(await settlement.refresh(req.ctx, req.params.id))));
extra.put('/settlements/:id', authorize('loans.edit'),
  validate({ body: z.object({ eosAmount: optMoney, leaveEncashment: optMoney, otherDues: optMoney, agreedDeduction: optMoney, notes: optStr(1000) }) }),
  ah(async (req, res) => res.json(await settlement.update(req.ctx, req.params.id, req.body))));
extra.post('/settlements/:id/review', authorize('loans.edit'), ah(async (req, res) => res.json(await settlement.transition(req.ctx, req.params.id, 'REVIEWED'))));
extra.post('/settlements/:id/approve', authorize('loans.approve'), ah(async (req, res) => res.json(await settlement.transition(req.ctx, req.params.id, 'APPROVED'))));
extra.post('/settlements/:id/close', authorize('loans.approve'), ah(async (req, res) => res.json(await settlement.transition(req.ctx, req.params.id, 'CLOSED'))));

module.exports = { advances: build('advance'), loans: build('loan'), finance: extra };
