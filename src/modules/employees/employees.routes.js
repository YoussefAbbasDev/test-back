const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, listQuery, str } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, dayjs, fmtDate } = require('../../utils/dates');
const { assertEmployeeAccess } = require('../../services/scope');
const { empName } = require('../../services/common');
const files = require('../../services/files');
const audit = require('../../services/audit');
const exporter = require('../../services/exporter');
const s = require('./employees.schemas');
const service = require('./employees.service');

const idParam = validate({ params: z.object({ id: z.string().uuid() }) });

router.get('/', authorize('employees.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const result = await service.list(req.ctx, q);
  if (!q.format || q.format === 'json') return res.json(result);
  if (!hasPermission(req.ctx, 'employees.export')) throw forbidden('PERMISSION_DENIED', { permission: 'employees.export' });
  await audit.record(req.ctx, { action: 'EXPORT', entityType: 'Employee', newValue: { format: q.format, count: result.rows.length } });
  return exporter.send(res, q.format, {
    title: 'Employees', filename: 'employees', rows: result.rows,
    columns: [
      { header: 'Employee ID', key: 'employeeNumber' }, { header: 'Name', value: (r) => empName(r) }, { header: 'Arabic Name', key: 'fullNameAr' },
      { header: 'Job Title', value: (r) => r.position?.titleEn }, { header: 'Department', value: (r) => r.department?.nameEn },
      { header: 'Branch', value: (r) => r.branch?.nameEn }, { header: 'Manager', value: (r) => empName(r.manager) },
      { header: 'Employment Type', key: 'employmentType' }, { header: 'Hire Date', value: (r) => fmtDate(r.hireDate) },
      { header: 'Contract Expiry', value: (r) => fmtDate(r.contractEnd) }, { header: 'Status', key: 'status' }, { header: 'Phone', key: 'mobile' },
    ],
  });
}));

router.post('/', authorize('employees.create'), validate({ body: s.createSchema }), ah(async (req, res) => {
  res.status(201).json(await service.create(req.ctx, req.body));
}));

router.post('/bulk', authorize('employees.edit'),
  validate({ body: z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['suspend', 'reactivate', 'archive']), effectiveDate: z.string(), reason: str(500) }) }),
  ah(async (req, res) => {
    const results = [];
    for (const id of req.body.ids) {
      try {
        await service.changeStatus(req.ctx, id, req.body.action, req.body);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, code: e.code || 'ERROR' });
      }
    }
    res.json({ results });
  }));

router.get('/:id', authorize('employees.view'), idParam, ah(async (req, res) => res.json(await service.get(req.ctx, req.params.id))));
router.get('/:id/overview', authorize('employees.view'), idParam, ah(async (req, res) => res.json(await service.overview(req.ctx, req.params.id))));
router.put('/:id', authorize('employees.edit'), idParam, validate({ body: s.updateSchema }), ah(async (req, res) => res.json(await service.update(req.ctx, req.params.id, req.body))));
router.delete('/:id', authorize('employees.delete'), idParam, ah(async (req, res) => { await service.remove(req.ctx, req.params.id); res.status(204).end(); }));

router.post('/:id/transfer', authorize('employees.edit'), idParam, validate({ body: s.transferSchema }), ah(async (req, res) => res.json(await service.transfer(req.ctx, req.params.id, req.body))));
for (const action of Object.keys(service.STATUS_ACTIONS)) {
  router.post(`/:id/${action}`, authorize('employees.edit'), idParam, validate({ body: s.statusActionSchema }), ah(async (req, res) => res.json(await service.changeStatus(req.ctx, req.params.id, action, req.body))));
}

router.get('/:id/history', authorize('employees.view'), idParam, ah(async (req, res) => res.json({ items: await service.history(req.ctx, req.params.id) })));
router.get('/:id/activity', authorize('employees.view'), idParam, ah(async (req, res) => res.json({ items: await service.activity(req.ctx, req.params.id) })));
router.get('/:id/salary', authorize('employees.view'), idParam, ah(async (req, res) => res.json(await service.salaryHistory(req.ctx, req.params.id))));
router.post('/:id/salary', authorize(['employees.financial']), idParam, validate({ body: s.salaryRevisionSchema }), ah(async (req, res) => res.status(201).json(await service.requestSalaryChange(req.ctx, req.params.id, req.body))));
router.put('/:id/emergency-contacts', authorize('employees.edit'), idParam,
  validate({ body: z.object({ contacts: z.array(z.object({ name: str(200), relationship: str(60), phone: str(30) })).max(5) }) }),
  ah(async (req, res) => res.json({ items: await service.setEmergencyContacts(req.ctx, req.params.id, req.body.contacts) })));

// Kiosk PIN (hashed) set by HR
router.put('/:id/kiosk-pin', authorize('attendance.manual'), idParam, validate({ body: z.object({ pin: z.string().regex(/^\d{4,8}$/) }) }), ah(async (req, res) => {
  await assertEmployeeAccess(req.ctx, req.params.id, 'employees.edit');
  const bcrypt = require('bcryptjs');
  await prisma.employee.update({ where: { id: req.params.id }, data: { kioskPinHash: await bcrypt.hash(req.body.pin, 10) } });
  await audit.record(req.ctx, { action: 'SET_KIOSK_PIN', entityType: 'Employee', entityId: req.params.id, employeeId: req.params.id });
  res.status(204).end();
}));

// Photo
router.post('/:id/photo', authorize('employees.edit'), idParam, files.upload.single('file'), ah(async (req, res) => {
  await assertEmployeeAccess(req.ctx, req.params.id, 'employees.edit');
  if (!req.file?.mimetype.startsWith('image/')) throw require('../../utils/errors').badRequest('FILE_TYPE_NOT_ALLOWED');
  const f = await files.save(req.ctx, req.file, { entityType: 'EmployeePhoto', entityId: req.params.id });
  await prisma.employee.update({ where: { id: req.params.id }, data: { photoFileId: f.id } });
  await audit.record(req.ctx, { action: 'UPDATE_PHOTO', entityType: 'Employee', entityId: req.params.id, employeeId: req.params.id });
  res.json({ photoFileId: f.id });
}));

// ── Documents ──
const docStatus = (doc, defaultAlert) => {
  if (doc.status === 'ARCHIVED') return 'ARCHIVED';
  if (!doc.expiryDate) return 'VALID';
  const today = toDateOnly(new Date());
  if (doc.expiryDate < today) return 'EXPIRED';
  const alert = doc.alertDaysBefore ?? defaultAlert;
  return dayjs(doc.expiryDate).diff(dayjs(today), 'day') <= alert ? 'EXPIRING' : 'VALID';
};

const docAccess = async (ctx, employeeId, write = false) => {
  await assertEmployeeAccess(ctx, employeeId, write ? 'employees.edit' : 'employees.view');
  if (ctx.employeeId !== employeeId && !hasPermission(ctx, 'employees.documents')) throw forbidden('PERMISSION_DENIED', { permission: 'employees.documents' });
};

router.get('/:id/documents', authorize('employees.view'), idParam, ah(async (req, res) => {
  await docAccess(req.ctx, req.params.id);
  const docs = await prisma.employeeDocument.findMany({ where: { employeeId: req.params.id, companyId: req.ctx.companyId, deletedAt: null }, include: { file: { select: { id: true, originalName: true, mimeType: true, size: true } } }, orderBy: { expiryDate: 'asc' } });
  res.json({ items: docs.map((d) => ({ ...d, status: docStatus(d, req.ctx.company.documentAlertDays) })) });
}));

router.post('/:id/documents', authorize('employees.edit'), idParam, files.upload.single('file'), ah(async (req, res) => {
  await docAccess(req.ctx, req.params.id, true);
  const parsed = s.documentSchema.safeParse(req.body);
  if (!parsed.success) throw new (require('../../utils/errors').AppError)(422, 'VALIDATION_FAILED', {}, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const d = parsed.data;
  const file = req.file ? await files.save(req.ctx, req.file, { entityType: 'EmployeeDocument', entityId: req.params.id }) : null;
  const doc = await prisma.employeeDocument.create({
    data: {
      ...d, issueDate: d.issueDate ? toDateOnly(d.issueDate) : null, expiryDate: d.expiryDate ? toDateOnly(d.expiryDate) : null,
      companyId: req.ctx.companyId, employeeId: req.params.id, fileId: file?.id || null,
    },
  });
  await prisma.employeeDocument.update({ where: { id: doc.id }, data: { status: docStatus(doc, req.ctx.company.documentAlertDays) } });
  await audit.record(req.ctx, { action: 'UPLOAD_DOCUMENT', entityType: 'EmployeeDocument', entityId: doc.id, employeeId: req.params.id, after: doc });
  res.status(201).json(doc);
}));

const docParams = validate({ params: z.object({ id: z.string().uuid(), docId: z.string().uuid() }) });

router.put('/:id/documents/:docId', authorize('employees.edit'), docParams, ah(async (req, res) => {
  await docAccess(req.ctx, req.params.id, true);
  const before = await prisma.employeeDocument.findFirst({ where: { id: req.params.docId, employeeId: req.params.id, companyId: req.ctx.companyId, deletedAt: null } });
  if (!before) throw notFound();
  const parsed = s.documentSchema.partial().safeParse(req.body);
  if (!parsed.success) throw new (require('../../utils/errors').AppError)(422, 'VALIDATION_FAILED', {}, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const d = parsed.data;
  if ('issueDate' in d) d.issueDate = d.issueDate ? toDateOnly(d.issueDate) : null;
  if ('expiryDate' in d) d.expiryDate = d.expiryDate ? toDateOnly(d.expiryDate) : null;
  const merged = { ...before, ...d };
  const doc = await prisma.employeeDocument.update({ where: { id: before.id }, data: { ...d, status: docStatus(merged, req.ctx.company.documentAlertDays) } });
  await audit.record(req.ctx, { action: 'UPDATE_DOCUMENT', entityType: 'EmployeeDocument', entityId: doc.id, employeeId: req.params.id, before, after: doc });
  res.json(doc);
}));

router.delete('/:id/documents/:docId', authorize('employees.edit'), docParams, ah(async (req, res) => {
  await docAccess(req.ctx, req.params.id, true);
  const before = await prisma.employeeDocument.findFirst({ where: { id: req.params.docId, employeeId: req.params.id, companyId: req.ctx.companyId, deletedAt: null } });
  if (!before) throw notFound();
  await prisma.employeeDocument.update({ where: { id: before.id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
  await audit.record(req.ctx, { action: 'DELETE_DOCUMENT', entityType: 'EmployeeDocument', entityId: before.id, employeeId: req.params.id, before });
  res.status(204).end();
}));

module.exports = router;
module.exports.docStatus = docStatus;
