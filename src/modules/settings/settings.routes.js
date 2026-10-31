// Company settings, users, roles & permissions, approval workflows, system settings, companies (super admin)
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, listQuery } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');
const { parsePaging, paged } = require('../../utils/pagination');
const { SCOPES, SCOPE_RANK, ALL_PERMISSIONS } = require('../../config/permissions');
const { passwordPolicy } = require('../auth/auth.service');
const { provisionCompany } = require('../../services/provision');
const files = require('../../services/files');
const audit = require('../../services/audit');

// ── Company ──
router.get('/company', ah(async (req, res) => res.json(req.ctx.company)));
router.put('/company', authorize('settings.settings'), validate({
  body: z.object({
    nameAr: str(200).optional(), nameEn: str(200).optional(), defaultLanguage: z.enum(['ar', 'en']).optional(), currency: z.string().length(3).optional(),
    timezone: z.string().max(64).refine((tz) => { try { Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Invalid timezone').optional(),
    country: z.string().length(2).optional(), weekendDays: z.array(z.number().int().min(0).max(6)).max(3).optional(), workWeekStartsOn: z.number().int().min(0).max(6).optional(),
    documentAlertDays: z.coerce.number().int().min(1).max(365).optional(), contractAlertDays: z.coerce.number().int().min(1).max(365).optional(),
  }),
}), ah(async (req, res) => {
  const before = req.ctx.company;
  const updated = await prisma.company.update({ where: { id: req.ctx.companyId }, data: req.body });
  await audit.record(req.ctx, { action: 'UPDATE', entityType: 'Company', entityId: updated.id, before, after: updated });
  res.json(updated);
}));
router.post('/company/logo', authorize('settings.settings'), files.upload.single('file'), ah(async (req, res) => {
  if (!req.file?.mimetype.startsWith('image/')) throw badRequest('FILE_TYPE_NOT_ALLOWED');
  const f = await files.save(req.ctx, req.file, { entityType: 'CompanyLogo', entityId: req.ctx.companyId });
  await prisma.company.update({ where: { id: req.ctx.companyId }, data: { logoFileId: f.id } });
  res.json({ logoFileId: f.id });
}));

// Whitelisted key/value settings (scheduling limits, advance limits…)
const SETTING_KEYS = {
  'scheduling.maxWeeklyHours': z.coerce.number().min(1).max(168).nullable(),
  'advances.maxAmount': z.coerce.number().min(0).nullable(),
  'advances.maxInstallments': z.coerce.number().int().min(1).max(60).nullable(),
  'loans.maxAmount': z.coerce.number().min(0).nullable(),
  'loans.maxInstallments': z.coerce.number().int().min(1).max(240).nullable(),
  'loans.feesEnabled': z.boolean().nullable(),
  'attendance.qrTtlSeconds': z.coerce.number().int().min(15).max(600).nullable(),
};
router.get('/system', authorize('settings.view'), ah(async (req, res) => {
  const rows = await prisma.systemSetting.findMany({ where: { companyId: req.ctx.companyId } });
  res.json(Object.fromEntries(Object.keys(SETTING_KEYS).map((k) => [k, rows.find((r) => r.key === k)?.value ?? null])));
}));
router.put('/system', authorize('settings.settings'), ah(async (req, res) => {
  const out = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!SETTING_KEYS[k]) throw badRequest('VALIDATION_FAILED');
    const parsed = SETTING_KEYS[k].safeParse(v);
    if (!parsed.success) throw badRequest('VALIDATION_FAILED');
    await prisma.systemSetting.upsert({ where: { companyId_key: { companyId: req.ctx.companyId, key: k } }, create: { companyId: req.ctx.companyId, key: k, value: parsed.data }, update: { value: parsed.data } });
    out[k] = parsed.data;
  }
  await audit.record(req.ctx, { action: 'UPDATE', entityType: 'SystemSetting', newValue: out });
  res.json(out);
}));

// ── Roles & permissions ──
router.get('/permissions', authorize('users.view'), ah(async (req, res) => res.json({ items: ALL_PERMISSIONS, scopes: SCOPES })));
router.get('/roles', authorize('users.view'), ah(async (req, res) => {
  const roles = await prisma.role.findMany({ where: { companyId: req.ctx.companyId }, include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } }, orderBy: { isSystem: 'desc' } });
  res.json({ items: roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission.code) })) });
}));

// Anti-escalation: a user can only grant permissions (and a scope) they hold themselves
const assertNoEscalation = (ctx, permissions, dataScope) => {
  if (ctx.isSuperAdmin) return;
  for (const p of permissions) if (!ctx.permissions.has(p)) throw forbidden('CANNOT_ESCALATE');
  const maxRank = Math.max(...permissions.map((p) => ctx.permissions.get(p) || 0), 0);
  if (permissions.length && SCOPE_RANK[dataScope] > maxRank) throw forbidden('CANNOT_ESCALATE');
};

const roleSchema = z.object({ code: z.string().trim().min(2).max(60).regex(/^[A-Z0-9_]+$/), nameAr: str(120), nameEn: str(120), description: optStr(500), dataScope: z.enum(SCOPES), permissions: z.array(z.enum(ALL_PERMISSIONS)).max(ALL_PERMISSIONS.length) });
router.post('/roles', authorize('users.settings'), validate({ body: roleSchema }), ah(async (req, res) => {
  assertNoEscalation(req.ctx, req.body.permissions, req.body.dataScope);
  const { permissions, ...data } = req.body;
  const perms = await prisma.permission.findMany({ where: { code: { in: permissions } } });
  const role = await prisma.role.create({ data: { ...data, companyId: req.ctx.companyId, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  await audit.record(req.ctx, { action: 'CREATE', entityType: 'Role', entityId: role.id, newValue: req.body });
  res.status(201).json(role);
}));
router.put('/roles/:id', authorize('users.settings'), validate({ body: roleSchema.partial() }), ah(async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { permissions: { include: { permission: true } } } });
  if (!role) throw notFound();
  if (role.code === 'COMPANY_OWNER' && !req.ctx.roleCodes.includes('COMPANY_OWNER') && !req.ctx.isSuperAdmin) throw forbidden('CANNOT_ESCALATE');
  const { permissions, code, ...data } = req.body;
  if (permissions) assertNoEscalation(req.ctx, permissions, data.dataScope || role.dataScope);
  await prisma.$transaction(async (tx) => {
    await tx.role.update({ where: { id: role.id }, data: role.isSystem ? { nameAr: data.nameAr, nameEn: data.nameEn, description: data.description, dataScope: data.dataScope } : { ...data, ...(code ? { code } : {}) } });
    if (permissions) {
      const perms = await tx.permission.findMany({ where: { code: { in: permissions } } });
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
    await audit.record(req.ctx, { action: 'UPDATE', entityType: 'Role', entityId: role.id, oldValue: { permissions: role.permissions.map((p) => p.permission.code), dataScope: role.dataScope }, newValue: req.body }, tx);
  });
  res.json({ ok: true });
}));
router.delete('/roles/:id', authorize('users.settings'), ah(async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { _count: { select: { users: true } } } });
  if (!role) throw notFound();
  if (role.isSystem) throw badRequest('SYSTEM_ROLE');
  if (role._count.users) throw conflict('ROLE_IN_USE');
  await prisma.role.delete({ where: { id: role.id } });
  await audit.record(req.ctx, { action: 'DELETE', entityType: 'Role', entityId: role.id, before: role });
  res.status(204).end();
}));

// ── Users ──
const userSelect = { id: true, email: true, displayName: true, language: true, status: true, lastLoginAt: true, employeeId: true, createdAt: true, employee: { select: { employeeNumber: true, firstName: true, lastName: true } }, roles: { include: { role: { select: { id: true, code: true, nameAr: true, nameEn: true } } } } };
router.get('/users', authorize('users.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, deletedAt: null, ...(q.search ? { OR: [{ email: { contains: q.search } }, { displayName: { contains: q.search } }] } : {}) };
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }), prisma.user.count({ where })]);
  res.json(paged(items, total, paging));
}));

const assertRolesGrantable = async (ctx, roleIds) => {
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds }, companyId: ctx.companyId }, include: { permissions: { include: { permission: true } } } });
  if (roles.length !== new Set(roleIds).size) throw badRequest('INVALID_REFERENCE', { field: 'roleIds' });
  for (const r of roles) assertNoEscalation(ctx, r.permissions.map((p) => p.permission.code), r.dataScope);
  return roles;
};

router.post('/users', authorize('users.create'), validate({
  body: z.object({ email: z.string().email().max(191), displayName: str(200), password: z.string().min(1).max(200), employeeId: optId, roleIds: z.array(z.string().uuid()).min(1), language: z.enum(['ar', 'en']).optional(), roleBranchId: optId }),
}), ah(async (req, res) => {
  if (!passwordPolicy(req.body.password)) throw badRequest('WEAK_PASSWORD');
  await assertRolesGrantable(req.ctx, req.body.roleIds);
  if (req.body.employeeId && !(await prisma.employee.count({ where: { id: req.body.employeeId, companyId: req.ctx.companyId } }))) throw badRequest('INVALID_REFERENCE', { field: 'employeeId' });
  const user = await prisma.user.create({
    data: {
      companyId: req.ctx.companyId, email: req.body.email.toLowerCase(), displayName: req.body.displayName, passwordHash: await bcrypt.hash(req.body.password, 12),
      employeeId: req.body.employeeId || null, language: req.body.language || req.ctx.company.defaultLanguage,
      roles: { create: req.body.roleIds.map((roleId) => ({ roleId, branchId: req.body.roleBranchId || null })) },
    },
    select: userSelect,
  });
  await audit.record(req.ctx, { action: 'CREATE', entityType: 'User', entityId: user.id, employeeId: user.employeeId, newValue: { email: user.email, roles: req.body.roleIds } });
  res.status(201).json(user);
}));
router.put('/users/:id', authorize('users.edit'), validate({
  body: z.object({ displayName: str(200).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), roleIds: z.array(z.string().uuid()).min(1).optional(), employeeId: optId, roleBranchId: optId }),
}), ah(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId, deletedAt: null }, include: { roles: true } });
  if (!user) throw notFound();
  if (user.id === req.ctx.userId && (req.body.status === 'DISABLED' || req.body.roleIds)) throw forbidden('CANNOT_ESCALATE');
  if (req.body.roleIds) await assertRolesGrantable(req.ctx, req.body.roleIds);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { displayName: req.body.displayName, status: req.body.status, ...('employeeId' in req.body ? { employeeId: req.body.employeeId } : {}) } });
    if (req.body.roleIds) {
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.createMany({ data: req.body.roleIds.map((roleId) => ({ userId: user.id, roleId, branchId: req.body.roleBranchId || null })) });
    }
    if (req.body.status === 'DISABLED') await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit.record(req.ctx, { action: 'UPDATE', entityType: 'User', entityId: user.id, oldValue: { status: user.status, roles: user.roles.map((r) => r.roleId) }, newValue: req.body }, tx);
  });
  res.json(await prisma.user.findUnique({ where: { id: user.id }, select: userSelect }));
}));
router.post('/users/:id/reset-password', authorize('users.edit'), validate({ body: z.object({ password: z.string().min(1).max(200) }) }), ah(async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId, deletedAt: null } });
  if (!user) throw notFound();
  if (!passwordPolicy(req.body.password)) throw badRequest('WEAK_PASSWORD');
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(req.body.password, 12), failedLogins: 0, lockedUntil: null, passwordChangedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit.record(req.ctx, { action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id });
  res.status(204).end();
}));

// ── Approval workflows ──
const ENTITY_TYPES = ['LEAVE', 'LEAVE_CANCELLATION', 'ATTENDANCE_CORRECTION', 'SHIFT_EXCHANGE', 'ADVANCE', 'LOAN', 'PAYROLL', 'SALARY_CHANGE'];
const stepSchema = z.object({
  name: str(150), approverType: z.enum(['DIRECT_MANAGER', 'DEPARTMENT_MANAGER', 'BRANCH_MANAGER', 'ROLE', 'USER']), roleCode: optStr(60), userId: optId,
  mode: z.enum(['ANY', 'ALL']).default('ANY'), condition: z.object({ minAmount: z.coerce.number().optional(), maxAmount: z.coerce.number().optional() }).nullable().optional(), pendingStatus: optStr(30),
}).refine((s) => s.approverType !== 'ROLE' || s.roleCode, { message: 'roleCode required', path: ['roleCode'] }).refine((s) => s.approverType !== 'USER' || s.userId, { message: 'userId required', path: ['userId'] });
const workflowSchema = z.object({
  code: z.string().trim().min(2).max(60), name: str(150), entityType: z.enum(ENTITY_TYPES), isDefault: z.boolean().optional(), priority: z.coerce.number().int().optional(),
  conditions: z.object({ minAmount: z.coerce.number().optional(), maxAmount: z.coerce.number().optional(), branchIds: z.array(z.string().uuid()).optional(), leaveTypeIds: z.array(z.string().uuid()).optional() }).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(), steps: z.array(stepSchema).min(1).max(10),
});
router.get('/workflows', authorize('settings.view'), ah(async (req, res) => {
  res.json({ items: await prisma.approvalWorkflow.findMany({ where: { companyId: req.ctx.companyId }, include: { steps: { orderBy: { stepOrder: 'asc' } } }, orderBy: [{ entityType: 'asc' }, { priority: 'desc' }] }) });
}));
const saveWorkflow = async (ctx, body, id) => {
  if (body.steps.some((s) => s.userId)) {
    const ids = body.steps.map((s) => s.userId).filter(Boolean);
    if ((await prisma.user.count({ where: { id: { in: ids }, companyId: ctx.companyId } })) !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', { field: 'userId' });
  }
  const { steps, ...data } = body;
  return prisma.$transaction(async (tx) => {
    const w = id ? await tx.approvalWorkflow.update({ where: { id }, data }) : await tx.approvalWorkflow.create({ data: { ...data, companyId: ctx.companyId } });
    await tx.approvalStep.deleteMany({ where: { workflowId: w.id } });
    await tx.approvalStep.createMany({ data: steps.map((s, i) => ({ ...s, workflowId: w.id, stepOrder: i + 1, condition: s.condition || undefined })) });
    if (w.isDefault) await tx.approvalWorkflow.updateMany({ where: { companyId: ctx.companyId, entityType: w.entityType, id: { not: w.id } }, data: { isDefault: false } });
    await audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'ApprovalWorkflow', entityId: w.id, newValue: body }, tx);
    return w;
  });
};
router.post('/workflows', authorize('settings.settings'), validate({ body: workflowSchema }), ah(async (req, res) => res.status(201).json(await saveWorkflow(req.ctx, req.body))));
router.put('/workflows/:id', authorize('settings.settings'), validate({ body: workflowSchema }), ah(async (req, res) => {
  if (!(await prisma.approvalWorkflow.count({ where: { id: req.params.id, companyId: req.ctx.companyId } }))) throw notFound();
  res.json(await saveWorkflow(req.ctx, req.body, req.params.id));
}));
router.delete('/workflows/:id', authorize('settings.settings'), ah(async (req, res) => {
  const w = await prisma.approvalWorkflow.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { _count: { select: { instances: true } } } });
  if (!w) throw notFound();
  if (w._count.instances) {
    await prisma.approvalWorkflow.update({ where: { id: w.id }, data: { status: 'INACTIVE' } });
  } else await prisma.approvalWorkflow.delete({ where: { id: w.id } });
  await audit.record(req.ctx, { action: 'DELETE', entityType: 'ApprovalWorkflow', entityId: w.id, before: w });
  res.status(204).end();
}));

// ── Companies (platform super admin only) ──
const superOnly = (req, res, next) => (req.ctx.isSuperAdmin ? next() : next(forbidden()));
router.get('/companies', superOnly, ah(async (req, res) => res.json({ items: await prisma.company.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }) })));
router.post('/companies', superOnly, validate({
  body: z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/), nameAr: str(200), nameEn: str(200), currency: z.string().length(3).default('SAR'), timezone: z.string().default('Asia/Riyadh'), country: z.string().length(2).default('SA'), weekendDays: z.array(z.number().int().min(0).max(6)).default([5, 6]),
    owner: z.object({ email: z.string().email(), displayName: str(200), password: z.string() }) }),
}), ah(async (req, res) => {
  if (!passwordPolicy(req.body.owner.password)) throw badRequest('WEAK_PASSWORD');
  const { owner, ...data } = req.body;
  const company = await prisma.$transaction(async (tx) => {
    const c = await tx.company.create({ data });
    const { roles } = await provisionCompany(tx, c);
    await tx.user.create({ data: { companyId: c.id, email: owner.email.toLowerCase(), displayName: owner.displayName, passwordHash: await bcrypt.hash(owner.password, 12), roles: { create: [{ roleId: roles.COMPANY_OWNER.id }] } } });
    return c;
  }, { timeout: 30000 });
  await audit.record({ ...req.ctx, companyId: company.id }, { action: 'COMPANY_CREATED', entityType: 'Company', entityId: company.id, after: company });
  res.status(201).json(company);
}));

module.exports = router;
