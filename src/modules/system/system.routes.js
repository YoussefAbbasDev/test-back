// Approvals inbox, notifications, files, audit log
const router = require('express').Router();
const fs = require('fs');
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, listQuery } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { notFound, forbidden } = require('../../utils/errors');
const { parsePaging, paged } = require('../../utils/pagination');
const { assertEmployeeAccess } = require('../../services/scope');
const approvals = require('../../services/approvals');
const files = require('../../services/files');
const exporter = require('../../services/exporter');
const { TYPES } = require('../../services/notifications');

// ── Approvals inbox ──
router.get('/approvals/tasks', ah(async (req, res) => {
  const status = req.query.status === 'done' ? { in: ['APPROVED', 'REJECTED'] } : 'PENDING';
  const tasks = await prisma.approvalTask.findMany({
    where: { approverUserId: req.ctx.userId, status, instance: { companyId: req.ctx.companyId } },
    include: { instance: true }, orderBy: { createdAt: 'desc' }, take: 200,
  });
  const empIds = [...new Set(tasks.map((t) => t.instance.requesterEmployeeId).filter(Boolean))];
  const emps = await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true } });
  const byId = new Map(emps.map((e) => [e.id, e]));
  res.json({ items: tasks.map((t) => ({ ...t, requester: byId.get(t.instance.requesterEmployeeId) || null })) });
}));
router.get('/approvals/count', ah(async (req, res) => {
  res.json({ pending: await prisma.approvalTask.count({ where: { approverUserId: req.ctx.userId, status: 'PENDING', instance: { companyId: req.ctx.companyId, status: 'PENDING' } } }) });
}));
router.post('/approvals/tasks/:id/:decision', validate({ body: z.object({ comment: optStr(1000) }) }), ah(async (req, res) => {
  const decision = { approve: 'APPROVE', reject: 'REJECT' }[req.params.decision];
  if (!decision) throw notFound();
  res.json(await approvals.act(req.ctx, req.params.id, decision, req.body.comment));
}));
router.get('/approvals/timeline/:entityType/:entityId', ah(async (req, res) => {
  const items = await approvals.timeline(req.ctx.companyId, req.params.entityType, req.params.entityId);
  const inst = items[0];
  // visible to the requester, any approver of it, or users with the module's view permission
  const involved = inst && (inst.requesterUserId === req.ctx.userId || inst.tasks.some((t) => t.approverUserId === req.ctx.userId));
  const modulePerm = { LEAVE: 'leaves.view', LEAVE_CANCELLATION: 'leaves.view', ATTENDANCE_CORRECTION: 'attendance.view', SHIFT_EXCHANGE: 'shifts.view', ADVANCE: 'advances.view', LOAN: 'loans.view', PAYROLL: 'payroll.view', SALARY_CHANGE: 'employees.financial' }[req.params.entityType];
  if (inst && !involved && !(modulePerm && hasPermission(req.ctx, modulePerm))) throw forbidden();
  if (inst?.requesterEmployeeId && !involved) await assertEmployeeAccess(req.ctx, inst.requesterEmployeeId, modulePerm);
  res.json({ items });
}));

// ── Notifications ──
router.get('/notifications', validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { userId: req.ctx.userId, ...(q.unread === 'true' ? { readAt: null } : {}) };
  const paging = parsePaging(q);
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: req.ctx.userId, readAt: null } }),
  ]);
  res.json({ ...paged(items, total, paging), unread });
}));
router.post('/notifications/read', validate({ body: z.object({ ids: z.array(z.string().uuid()).optional() }) }), ah(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.ctx.userId, readAt: null, ...(req.body.ids?.length ? { id: { in: req.body.ids } } : {}) }, data: { readAt: new Date() } });
  res.status(204).end();
}));
router.get('/notifications/preferences', ah(async (req, res) => {
  const prefs = await prisma.notificationPreference.findMany({ where: { userId: req.ctx.userId } });
  const by = new Map(prefs.map((p) => [p.type, p]));
  res.json({ items: TYPES.map((type) => ({ type, inApp: by.get(type)?.inApp ?? true, email: by.get(type)?.email ?? false, sms: by.get(type)?.sms ?? false, whatsapp: by.get(type)?.whatsapp ?? false, push: by.get(type)?.push ?? false })), providers: { email: !!process.env.SMTP_URL, sms: !!process.env.SMS_PROVIDER_URL, whatsapp: !!process.env.WHATSAPP_PROVIDER_URL, push: false } });
}));
router.put('/notifications/preferences', validate({ body: z.object({ items: z.array(z.object({ type: z.enum(TYPES), inApp: z.boolean(), email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean(), push: z.boolean() })).max(TYPES.length) }) }), ah(async (req, res) => {
  await prisma.$transaction(req.body.items.map((p) => prisma.notificationPreference.upsert({ where: { userId_type: { userId: req.ctx.userId, type: p.type } }, create: { ...p, userId: req.ctx.userId }, update: p })));
  res.status(204).end();
}));

// ── Files (attachments) ──
router.post('/files', files.upload.single('file'), ah(async (req, res) => {
  const f = await files.save(req.ctx, req.file, { entityType: req.body?.entityType?.slice(0, 60) });
  res.status(201).json({ id: f.id, originalName: f.originalName, mimeType: f.mimeType, size: f.size });
}));
router.get('/files/:id', ah(async (req, res) => {
  const { file, fullPath } = await files.getForCompany(req.ctx.companyId, req.params.id);
  // employee-linked files require access to that employee
  if (['EmployeeDocument', 'EmployeePhoto'].includes(file.entityType) && file.entityId) {
    if (file.entityType === 'EmployeeDocument' && file.entityId !== req.ctx.employeeId && !hasPermission(req.ctx, 'employees.documents')) throw forbidden();
    await assertEmployeeAccess(req.ctx, file.entityId, 'employees.view').catch((e) => { if (file.entityType === 'EmployeePhoto') return; throw e; });
  } else if (file.uploadedById !== req.ctx.userId && !hasPermission(req.ctx, 'employees.view')) {
    throw forbidden();
  }
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.originalName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(fullPath).pipe(res);
}));

// ── Audit log (read-only — there are no update/delete endpoints) ──
router.get('/audit', authorize('audit.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId };
  if (q.entityType) where.entityType = q.entityType;
  if (q.entityId) where.entityId = q.entityId;
  if (q.employeeId) where.employeeId = q.employeeId;
  if (q.userId) where.userId = q.userId;
  if (q.action) where.action = { contains: q.action };
  if (q.from) where.createdAt = { gte: new Date(q.from) };
  if (q.to) where.createdAt = { ...(where.createdAt || {}), lte: new Date(`${q.to}T23:59:59Z`) };
  if (q.search) where.OR = [{ userName: { contains: q.search } }, { action: { contains: q.search } }, { entityType: { contains: q.search } }];
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'audit.export')) throw forbidden('PERMISSION_DENIED');
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50000 });
    return exporter.send(res, q.format, { title: 'Audit log', filename: 'audit-log', rows, columns: [{ header: 'When (UTC)', value: (r) => r.createdAt.toISOString() }, { header: 'User', key: 'userName' }, { header: 'Action', key: 'action' }, { header: 'Entity', key: 'entityType' }, { header: 'Entity ID', key: 'entityId' }, { header: 'Old', value: (r) => JSON.stringify(r.oldValue || '') }, { header: 'New', value: (r) => JSON.stringify(r.newValue || '') }, { header: 'Reason', key: 'reason' }, { header: 'IP', key: 'ip' }] });
  }
  const paging = parsePaging(q, { defaultSize: 50 });
  const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }), prisma.auditLog.count({ where })]);
  res.json(paged(items, total, paging));
}));

module.exports = router;
