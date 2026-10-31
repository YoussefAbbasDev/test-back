const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, date, time, listQuery } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { badRequest, forbidden, notFound } = require('../../utils/errors');
const { toDateOnly, fmtDate } = require('../../utils/dates');
const { employeeWhere } = require('../../services/scope');
const { empName } = require('../../services/common');
const { parsePaging, paged } = require('../../utils/pagination');
const engine = require('../../engines/attendance');
const exporter = require('../../services/exporter');
const service = require('./shifts.service');

const perm = { view: 'shifts.view', create: 'shifts.settings', edit: 'shifts.settings', delete: 'shifts.settings' };
const weekdays = z.array(z.coerce.number().int().min(0).max(6)).min(1);

const shiftSchema = z.object({
  code: z.string().trim().min(1).max(40), nameAr: str(150), nameEn: str(150), type: z.enum(['FIXED', 'FLEXIBLE', 'NIGHT', 'ROTATING']).default('FIXED'),
  startTime: time, endTime: time, breakMinutes: z.coerce.number().int().min(0).max(480).default(60), graceMinutes: z.coerce.number().int().min(0).max(240).nullable().optional(),
  expectedMinutes: z.coerce.number().int().min(1).max(1440).optional(), workingDays: weekdays, overtimeAfterMinutes: z.coerce.number().int().min(0).nullable().optional(),
  branchId: optId, departmentIds: z.array(z.string().uuid()).nullable().optional(), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.use('/definitions', crudRouter({
  model: 'shift', entity: 'Shift', perm, softDelete: true, searchFields: ['code', 'nameAr', 'nameEn'], orderBy: { startTime: 'asc' }, sortable: ['code', 'startTime'],
  filters: { branchId: (v) => ({ OR: [{ branchId: v }, { branchId: null }] }), status: (v) => ({ status: v }) },
  createSchema: shiftSchema,
  updateSchema: shiftSchema.partial(),
  toData: (b, ctx, mode, before) => {
    const start = b.startTime || before?.startTime;
    const end = b.endTime || before?.endTime;
    if (start === end) throw badRequest('INVALID_SHIFT_TIMES');
    const duration = engine.shiftDurationMinutes(start, end);
    const brk = b.breakMinutes ?? before?.breakMinutes ?? 0;
    if (brk >= duration) throw badRequest('INVALID_SHIFT_TIMES');
    return { ...b, crossesMidnight: engine.crossesMidnight(start, end), expectedMinutes: b.expectedMinutes ?? (b.startTime || b.endTime || b.breakMinutes != null ? duration - brk : undefined) };
  },
  beforeDelete: async (row, ctx) => {
    const future = await prisma.shiftAssignment.count({ where: { companyId: ctx.companyId, shiftId: row.id, status: 'SCHEDULED', date: { gte: toDateOnly(new Date()) } } });
    if (future) throw require('../../utils/errors').conflict('RELATED_RECORDS_EXIST');
  },
}));

router.get('/schedule', authorize('shifts.view'), validate({ query: z.object({ from: date, to: date, branchId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), employeeId: z.string().uuid().optional() }) }),
  ah(async (req, res) => res.json(await service.schedule(req.ctx, req.validQuery))));

router.get('/my', authorize('shifts.view'), validate({ query: z.object({ from: date, to: date }) }), ah(async (req, res) => {
  if (!req.ctx.employeeId) return res.json({ items: [] });
  const items = await prisma.shiftAssignment.findMany({ where: { employeeId: req.ctx.employeeId, status: 'SCHEDULED', date: { gte: toDateOnly(req.validQuery.from), lte: toDateOnly(req.validQuery.to) } }, include: { shift: true }, orderBy: { startAt: 'asc' } });
  res.json({ items });
}));

const assignSchema = z.object({
  employeeIds: z.array(z.string().uuid()).max(500).optional(), teamId: optId, shiftId: z.string().uuid(), from: date, to: date,
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional(), branchId: optId, managerId: optId, notes: optStr(500), dryRun: z.boolean().optional(),
}).refine((v) => v.from <= v.to, { message: 'from must be before to', path: ['to'] })
  .refine((v) => (new Date(v.to) - new Date(v.from)) / 86400000 <= 92, { message: 'Range limited to 92 days', path: ['to'] });

router.post('/assignments', authorize('shifts.create'), validate({ body: assignSchema }), ah(async (req, res) => res.status(201).json(await service.assign(req.ctx, req.body))));
router.post('/assignments/copy-week', authorize('shifts.create'),
  validate({ body: z.object({ fromWeekStart: date, toWeekStart: date, branchId: optId, employeeIds: z.array(z.string().uuid()).optional() }) }),
  ah(async (req, res) => res.status(201).json(await service.copyWeek(req.ctx, req.body))));
router.put('/assignments/:id', authorize('shifts.edit'), validate({ body: z.object({ shiftId: optId, date: date.optional(), notes: optStr(500), reason: optStr(500) }) }),
  ah(async (req, res) => res.json(await service.updateAssignment(req.ctx, req.params.id, req.body))));
router.delete('/assignments/:id', authorize('shifts.edit'), ah(async (req, res) => { await service.cancelAssignment(req.ctx, req.params.id, req.query.reason); res.status(204).end(); }));

// Rotations
router.use('/rotations', crudRouter({
  model: 'shiftRotation', entity: 'ShiftRotation', perm, searchFields: ['name'], orderBy: { name: 'asc' },
  createSchema: z.object({
    name: str(150), type: z.enum(['WEEKLY', 'MONTHLY', 'CUSTOM']), blockDays: z.coerce.number().int().min(1).max(31).default(7), startDate: date,
    pattern: z.array(z.object({ shiftId: z.string().uuid().nullable() })).min(1).max(12), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  }),
  toData: async (b, ctx) => {
    const ids = (b.pattern || []).map((p) => p.shiftId).filter(Boolean);
    if (ids.length) {
      const n = await prisma.shift.count({ where: { id: { in: ids }, companyId: ctx.companyId } });
      if (n !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', { field: 'pattern' });
    }
    return { ...b, ...(b.startDate ? { startDate: toDateOnly(b.startDate) } : {}), ...(b.type === 'WEEKLY' ? { blockDays: 7 } : {}) };
  },
}));
router.post('/rotations/:id/apply', authorize('shifts.create'),
  validate({ body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(200), from: date, to: date }) }),
  ah(async (req, res) => res.status(201).json(await service.applyRotation(req.ctx, req.params.id, req.body))));

// Coverage requirements
router.use('/coverage', crudRouter({
  model: 'shiftCoverageRequirement', entity: 'ShiftCoverageRequirement', perm: { view: 'shifts.view', create: 'shifts.create', edit: 'shifts.edit', delete: 'shifts.edit' },
  include: { shift: { select: { code: true, nameAr: true, nameEn: true } } }, filters: { branchId: (v) => ({ branchId: v }) },
  createSchema: z.object({ branchId: z.string().uuid(), shiftId: z.string().uuid(), dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(), minEmployees: z.coerce.number().int().min(1).max(1000) }),
}));

// Exchange requests
router.get('/exchanges', authorize('shifts.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const scope = await employeeWhere(req.ctx, 'shifts.view');
  const where = { companyId: req.ctx.companyId, OR: [{ requester: scope }, { replacementId: req.ctx.employeeId || undefined }], ...(req.validQuery.status ? { status: req.validQuery.status } : {}) };
  const paging = parsePaging(req.validQuery);
  const sel = { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } };
  const [items, total] = await Promise.all([
    prisma.shiftExchangeRequest.findMany({ where, include: { requester: sel, replacement: sel }, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.shiftExchangeRequest.count({ where }),
  ]);
  const assignmentIds = items.flatMap((i) => [i.requesterAssignmentId, i.replacementAssignmentId]).filter(Boolean);
  const assignments = await prisma.shiftAssignment.findMany({ where: { id: { in: assignmentIds } }, include: { shift: { select: { code: true, nameAr: true, nameEn: true, startTime: true, endTime: true } } } });
  const byId = new Map(assignments.map((a) => [a.id, a]));
  res.json(paged(items.map((i) => ({ ...i, requesterAssignment: byId.get(i.requesterAssignmentId), replacementAssignment: byId.get(i.replacementAssignmentId) || null })), total, paging));
}));
router.post('/exchanges', authorize('shifts.create'),
  validate({ body: z.object({ requesterAssignmentId: z.string().uuid(), replacementId: z.string().uuid(), replacementAssignmentId: optId, reason: optStr(1000) }) }),
  ah(async (req, res) => res.status(201).json(await service.requestExchange(req.ctx, req.body))));
router.post('/exchanges/:id/respond', authorize('shifts.view'), validate({ body: z.object({ accept: z.boolean() }) }),
  ah(async (req, res) => res.json(await service.respondExchange(req.ctx, req.params.id, req.body.accept))));

// Reports
router.get('/reports/:type', authorize('shifts.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const from = q.from || fmtDate(new Date());
  const to = q.to || from;
  let rows;
  let columns;
  if (req.params.type === 'coverage' || req.params.type === 'missing-staff') {
    const r = await service.coverageReport(req.ctx, { from, to, branchId: q.branchId });
    rows = req.params.type === 'missing-staff' ? r.items.filter((i) => i.shortage > 0) : r.items;
    columns = [{ header: 'Date', key: 'date' }, { header: 'Branch', value: (x) => x.branch?.nameEn }, { header: 'Shift', value: (x) => x.shift.code }, { header: 'Required', key: 'required' }, { header: 'Scheduled', key: 'scheduled' }, { header: 'Shortage', key: 'shortage' }];
  } else if (req.params.type === 'employee-history' || req.params.type === 'branch') {
    rows = await prisma.shiftAssignment.findMany({
      where: { companyId: req.ctx.companyId, date: { gte: toDateOnly(from), lte: toDateOnly(to) }, employee: await employeeWhere(req.ctx, 'shifts.view'), ...(q.employeeId ? { employeeId: q.employeeId } : {}), ...(q.branchId ? { branchId: q.branchId } : {}) },
      include: { shift: true, employee: true }, orderBy: [{ date: 'asc' }],
    });
    columns = [{ header: 'Date', value: (x) => fmtDate(x.date) }, { header: 'Employee', value: (x) => empName(x.employee) }, { header: 'Shift', value: (x) => x.shift.code }, { header: 'Start', value: (x) => x.shift.startTime }, { header: 'End', value: (x) => x.shift.endTime }, { header: 'Source', key: 'source' }, { header: 'Status', key: 'status' }];
  } else if (req.params.type === 'changes') {
    rows = await prisma.auditLog.findMany({ where: { companyId: req.ctx.companyId, entityType: { in: ['ShiftAssignment', 'ShiftExchangeRequest'] }, createdAt: { gte: toDateOnly(from) } }, orderBy: { createdAt: 'desc' }, take: 2000 });
    columns = [{ header: 'When', value: (x) => x.createdAt.toISOString() }, { header: 'User', key: 'userName' }, { header: 'Action', key: 'action' }, { header: 'Reason', key: 'reason' }];
  } else if (req.params.type === 'overtime') {
    const grouped = await prisma.attendanceRecord.groupBy({ by: ['shiftId'], where: { companyId: req.ctx.companyId, date: { gte: toDateOnly(from), lte: toDateOnly(to) }, overtimeMinutes: { gt: 0 } }, _sum: { overtimeMinutes: true, overtimeApprovedMinutes: true }, _count: true });
    const shifts = await prisma.shift.findMany({ where: { companyId: req.ctx.companyId } });
    rows = grouped.map((g) => ({ shift: shifts.find((s) => s.id === g.shiftId)?.code || '—', records: g._count, overtimeHours: ((g._sum.overtimeMinutes || 0) / 60).toFixed(1), approvedHours: ((g._sum.overtimeApprovedMinutes || 0) / 60).toFixed(1) }));
    columns = [{ header: 'Shift', key: 'shift' }, { header: 'Records', key: 'records' }, { header: 'OT hours', key: 'overtimeHours' }, { header: 'Approved hours', key: 'approvedHours' }];
  } else throw notFound();
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'shifts.export')) throw forbidden('PERMISSION_DENIED');
    return exporter.send(res, q.format, { title: `Shifts — ${req.params.type}`, subtitle: `${from} → ${to}`, filename: `shifts-${req.params.type}`, columns, rows });
  }
  res.json({ from, to, ...exporter.table(columns, rows) });
}));

module.exports = router;
