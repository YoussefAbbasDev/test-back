const router = require('express').Router();
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const prisma = require('../../database/prisma');
const env = require('../../config/env');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, date, optDate, time, listQuery } = require('../../utils/validate');
const { authenticate, authorize, hasPermission } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { notFound, badRequest, unauthorized, AppError } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs, localDate } = require('../../utils/dates');
const { sha256, randomToken } = require('../../utils/crypto');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere, assertEmployeeAccess } = require('../../services/scope');
const { empName } = require('../../services/common');
const audit = require('../../services/audit');
const exporter = require('../../services/exporter');
const service = require('./attendance.service');

const punchLimiter = rateLimit({ windowMs: 60 * 1000, limit: env.isTest ? 1000 : 30, standardHeaders: 'draft-7', legacyHeaders: false });
const METHODS = ['GPS', 'QR', 'KIOSK', 'MANUAL', 'BIOMETRIC', 'NFC', 'FACE'];

// ───── Device-authenticated endpoints (kiosk & hardware adapters) — no user session ─────
const deviceAuth = ah(async (req, res, next) => {
  const { device, ctx } = await service.authenticateDevice(req.get('x-device-key'));
  req.device = device;
  req.ctx = { ...ctx, ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 300) };
  next();
});

router.post('/kiosk/punch', punchLimiter, deviceAuth,
  validate({ body: z.object({ employeeNumber: z.string().trim().min(1).max(40), pin: z.string().regex(/^\d{4,8}$/), type: z.enum(['CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END']) }) }),
  ah(async (req, res) => {
    if (req.device.type !== 'KIOSK') throw unauthorized('DEVICE_UNAUTHORIZED');
    let emp = await prisma.employee.findFirst({ where: { companyId: req.ctx.companyId, employeeNumber: req.body.employeeNumber, deletedAt: null } });
    if (!emp && /^\d+$/.test(req.body.employeeNumber)) {
      // keypad entry of the numeric part only (EMP-0011 → 11 / 0011) — accepted only when unambiguous
      const n = String(Number(req.body.employeeNumber));
      const candidates = await prisma.employee.findMany({ where: { companyId: req.ctx.companyId, deletedAt: null, employeeNumber: { endsWith: n } }, take: 20 });
      const exact = candidates.filter((c) => (c.employeeNumber.match(/(\d+)$/) || [])[1] && String(Number(c.employeeNumber.match(/(\d+)$/)[1])) === n);
      if (exact.length === 1) [emp] = exact;
    }
    // same error for unknown employee / wrong pin (no enumeration)
    if (!emp?.kioskPinHash || !(await bcrypt.compare(req.body.pin, emp.kioskPinHash))) throw unauthorized('KIOSK_PIN_INVALID');
    if (req.device.branchId && emp.branchId !== req.device.branchId) throw badRequest('EMPLOYEE_WRONG_BRANCH');
    const result = await service.punch(req.ctx, emp.id, { type: req.body.type, method: 'KIOSK', deviceId: req.device.id, deviceInfo: `kiosk:${req.device.id}` });
    res.json({ employee: { name: empName(emp), nameAr: emp.fullNameAr, employeeNumber: emp.employeeNumber }, type: req.body.type, at: result.event.occurredAt, status: result.record.status, lateMinutes: result.record.lateMinutes });
  }));

router.get('/kiosk/me', deviceAuth, ah(async (req, res) => {
  const branch = req.device.branchId ? await prisma.branch.findUnique({ where: { id: req.device.branchId }, select: { nameAr: true, nameEn: true } }) : null;
  res.json({ device: { name: req.device.name, type: req.device.type }, branch, company: { nameAr: req.ctx.company.nameAr, nameEn: req.ctx.company.nameEn } });
}));

// Biometric / NFC hardware adapter. Devices push raw punches; the employee is matched by employee number.
router.post('/integrations/events', deviceAuth,
  validate({ body: z.object({ events: z.array(z.object({ employeeNumber: z.string().max(40), type: z.enum(['CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END']), occurredAt: z.string().datetime() })).min(1).max(500) }) }),
  ah(async (req, res) => {
    if (!['BIOMETRIC', 'NFC'].includes(req.device.type)) throw unauthorized('DEVICE_UNAUTHORIZED');
    const results = [];
    for (const ev of req.body.events) {
      const emp = await prisma.employee.findFirst({ where: { companyId: req.ctx.companyId, employeeNumber: ev.employeeNumber, deletedAt: null } });
      if (!emp) { results.push({ ...ev, ok: false, code: 'EMPLOYEE_NOT_FOUND' }); continue; }
      try {
        await service.punch(req.ctx, emp.id, { type: ev.type, method: req.device.type, occurredAt: ev.occurredAt, deviceId: req.device.id, deviceInfo: `device:${req.device.id}` });
        results.push({ ...ev, ok: true });
      } catch (e) {
        results.push({ ...ev, ok: false, code: e.code || 'ERROR' });
      }
    }
    res.json({ results });
  }));

// Face recognition: integration point only. No recognition engine is bundled, so the endpoint refuses honestly.
router.post('/integrations/face', deviceAuth, ah(async () => {
  throw new AppError(501, 'INTEGRATION_NOT_CONFIGURED', { name: 'Face Recognition' });
}));

// ───── Authenticated user endpoints ─────
router.use(authenticate);

router.get('/me/today', authorize('attendance.view'), ah(async (req, res) => res.json(await service.today(req.ctx))));

const punchSchema = z.object({
  method: z.enum(['GPS', 'QR']),
  latitude: z.coerce.number().min(-90).max(90).optional(), longitude: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().min(0).max(100000).optional(), qrToken: z.string().max(200).optional(), deviceInfo: z.string().max(300).optional(),
});
for (const [path, type] of [['check-in', 'CHECK_IN'], ['check-out', 'CHECK_OUT'], ['break-start', 'BREAK_START'], ['break-end', 'BREAK_END']]) {
  router.post(`/${path}`, punchLimiter, authorize('attendance.create'), validate({ body: punchSchema }), ah(async (req, res) => {
    if (!req.ctx.employeeId) throw badRequest('EMPLOYEE_NOT_FOUND');
    const result = await service.punch(req.ctx, req.ctx.employeeId, { ...req.body, type });
    res.status(201).json(result);
  }));
}

const recordInclude = {
  employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true, branch: { select: { nameAr: true, nameEn: true } }, department: { select: { nameAr: true, nameEn: true } } } },
  shift: { select: { id: true, code: true, nameAr: true, nameEn: true, startTime: true, endTime: true } },
};

const recordsWhere = async (ctx, q) => {
  const and = [{ companyId: ctx.companyId, employee: await employeeWhere(ctx, 'attendance.view') }];
  if (q.date) and.push({ date: toDateOnly(q.date) });
  if (q.from) and.push({ date: { gte: toDateOnly(q.from) } });
  if (q.to) and.push({ date: { lte: toDateOnly(q.to) } });
  if (q.employeeId) and.push({ employeeId: q.employeeId });
  if (q.status) and.push({ status: { in: q.status.split(',') } });
  if (q.branchId) and.push({ employee: { branchId: q.branchId } });
  if (q.departmentId) and.push({ employee: { departmentId: q.departmentId } });
  if (q.suspicious === 'true') and.push({ isSuspicious: true });
  if (q.overtime === 'pending') and.push({ overtimeStatus: 'PENDING' });
  if (q.missingCheckout === 'true') and.push({ firstCheckIn: { not: null }, lastCheckOut: null });
  if (q.late === 'true') and.push({ lateMinutes: { gt: 0 } });
  if (q.search) and.push({ employee: { OR: [{ firstName: { contains: q.search } }, { lastName: { contains: q.search } }, { employeeNumber: { contains: q.search } }, { fullNameAr: { contains: q.search } }] } });
  return { AND: and };
};

const recordColumns = [
  { header: 'Date', value: (r) => fmtDate(r.date) }, { header: 'Employee ID', value: (r) => r.employee?.employeeNumber }, { header: 'Employee', value: (r) => empName(r.employee) },
  { header: 'Shift', value: (r) => r.shift?.code }, { header: 'Check-in', value: (r) => (r.firstCheckIn ? r.firstCheckIn.toISOString().slice(11, 16) + ' UTC' : '') },
  { header: 'Check-out', value: (r) => (r.lastCheckOut ? r.lastCheckOut.toISOString().slice(11, 16) + ' UTC' : '') }, { header: 'Method', key: 'checkInMethod' },
  { header: 'Late (min)', key: 'lateMinutes' }, { header: 'Early (min)', key: 'earlyLeaveMinutes' }, { header: 'Worked (min)', key: 'workedMinutes' },
  { header: 'Overtime (min)', key: 'overtimeMinutes' }, { header: 'OT approved', key: 'overtimeApprovedMinutes' }, { header: 'Status', key: 'status' },
];

router.get('/records', authorize('attendance.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = await recordsWhere(req.ctx, q);
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'attendance.export')) throw require('../../utils/errors').forbidden('PERMISSION_DENIED');
    const rows = await prisma.attendanceRecord.findMany({ where, include: recordInclude, orderBy: [{ date: 'desc' }], take: 50000 });
    return exporter.send(res, q.format, { title: 'Attendance', filename: 'attendance', columns: recordColumns, rows });
  }
  const paging = parsePaging(q, { defaultSize: 50 });
  const [items, total] = await Promise.all([
    prisma.attendanceRecord.findMany({ where, include: recordInclude, orderBy: [{ date: 'desc' }, { firstCheckIn: 'asc' }], skip: paging.skip, take: paging.take }),
    prisma.attendanceRecord.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));

router.get('/records/:id', authorize('attendance.view'), ah(async (req, res) => {
  const rec = await prisma.attendanceRecord.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { ...recordInclude, events: { orderBy: { occurredAt: 'asc' } }, corrections: true } });
  if (!rec) throw notFound();
  await assertEmployeeAccess(req.ctx, rec.employeeId, 'attendance.view');
  res.json(rec);
}));

router.post('/records/:id/overtime', authorize('attendance.approve'),
  validate({ body: z.object({ approve: z.boolean(), minutes: z.coerce.number().int().min(0).optional(), reason: optStr(500) }) }),
  ah(async (req, res) => res.json(await service.decideOvertime(req.ctx, req.params.id, req.body))));

router.get('/dashboard', authorize('attendance.view'), ah(async (req, res) => res.json(await service.dashboard(req.ctx, req.query))));

// Corrections
const correctionBody = z.object({
  employeeId: optId, date, checkIn: time.optional(), checkOut: time.optional(), checkOutNextDay: z.boolean().optional(), reason: str(1000), attachmentId: optId,
}).refine((v) => v.checkIn || v.checkOut, { message: 'checkIn or checkOut is required', path: ['checkIn'] });

router.post('/corrections', authorize('attendance.create'), validate({ body: correctionBody }), ah(async (req, res) => res.status(201).json(await service.requestCorrection(req.ctx, req.body))));
router.post('/manual', authorize('attendance.manual'), validate({ body: correctionBody.refine((v) => !!v.employeeId, { message: 'employeeId required', path: ['employeeId'] }) }), ah(async (req, res) => res.status(201).json(await service.requestCorrection(req.ctx, req.body, { manual: true }))));
router.get('/corrections', authorize('attendance.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, employee: await employeeWhere(req.ctx, 'attendance.view'), ...(q.status ? { status: q.status } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) };
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.attendanceCorrection.findMany({ where, include: { employee: recordInclude.employee }, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.attendanceCorrection.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));
router.post('/corrections/:id/cancel', authorize('attendance.create'), ah(async (req, res) => {
  const corr = await prisma.attendanceCorrection.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId, status: 'PENDING' } });
  if (!corr) throw notFound();
  if (corr.employeeId !== req.ctx.employeeId && corr.createdById !== req.ctx.userId) throw require('../../utils/errors').forbidden();
  await prisma.$transaction(async (tx) => {
    await require('../../services/approvals').cancel(tx, corr.approvalInstanceId);
    await tx.attendanceCorrection.update({ where: { id: corr.id }, data: { status: 'CANCELLED' } });
  });
  res.status(204).end();
}));

// QR display for a branch (rotating token)
router.post('/qr/:branchId', authorize(['attendance.settings', 'attendance.manual']), ah(async (req, res) => {
  const ttl = Math.min(600, Math.max(15, Number(req.query.ttl) || 60));
  const qr = await service.issueQr(req.ctx, req.params.branchId, ttl);
  const dataUrl = await QRCode.toDataURL(JSON.stringify({ t: qr.token, b: qr.branch.id }), { margin: 1, width: 360, color: { dark: '#2D3D62' } });
  res.json({ ...qr, dataUrl });
}));

router.post('/finalize', authorize('attendance.settings'), validate({ body: z.object({ date }) }), ah(async (req, res) => {
  const result = await service.finalizeDay(req.ctx.companyId, req.body.date);
  await audit.record(req.ctx, { action: 'ATTENDANCE_FINALIZE', entityType: 'AttendanceRecord', newValue: result });
  res.json(result);
}));

// ───── Settings: policies, geofences, devices, holidays ─────
const settingsPerm = { view: 'attendance.view', create: 'attendance.settings', edit: 'attendance.settings', delete: 'attendance.settings' };

router.use('/policies', crudRouter({
  model: 'attendancePolicy', entity: 'AttendancePolicy', perm: settingsPerm, searchFields: ['name'], orderBy: { name: 'asc' }, sortable: ['name'],
  createSchema: z.object({
    name: str(150), scope: z.enum(['COMPANY', 'BRANCH', 'DEPARTMENT', 'GROUP']).default('COMPANY'), branchId: optId, departmentId: optId, isDefault: z.boolean().optional(),
    graceMinutes: z.coerce.number().int().min(0).max(240).optional(), lateCountFromShiftStart: z.boolean().optional(), halfDayThresholdMinutes: z.coerce.number().int().min(0).nullable().optional(),
    earlyLeaveGraceMinutes: z.coerce.number().int().min(0).max(240).optional(), minWorkingMinutes: z.coerce.number().int().min(0).nullable().optional(), breakMinutes: z.coerce.number().int().min(0).max(480).optional(),
    overtimeEnabled: z.boolean().optional(), overtimeMinMinutes: z.coerce.number().int().min(0).optional(), overtimeRequiresApproval: z.boolean().optional(),
    weekendWorkIsOvertime: z.boolean().optional(), holidayWorkIsOvertime: z.boolean().optional(), missingCheckoutAction: z.enum(['MARK_INCOMPLETE', 'AUTO_SHIFT_END']).optional(),
    allowMultipleSessions: z.boolean().optional(), correctionWindowDays: z.coerce.number().int().min(0).max(365).optional(), correctionRequiresHR: z.boolean().optional(),
    requireGeofence: z.boolean().optional(), maxGpsAccuracyMeters: z.coerce.number().int().min(5).max(5000).optional(), rejectOutsideGeofence: z.boolean().optional(),
    allowedMethods: z.array(z.enum(METHODS)).min(1).default(['GPS', 'QR', 'KIOSK', 'MANUAL']), minMinutesBetweenEvents: z.coerce.number().int().min(0).max(60).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  }),
  afterWrite: async (tx, row) => {
    if (row.isDefault) await tx.attendancePolicy.updateMany({ where: { companyId: row.companyId, id: { not: row.id } }, data: { isDefault: false } });
  },
}));

router.use('/locations', crudRouter({
  model: 'attendanceLocation', entity: 'AttendanceLocation', perm: settingsPerm, searchFields: ['name'], orderBy: { name: 'asc' },
  include: { branch: { select: { id: true, nameAr: true, nameEn: true } } }, filters: { branchId: (v) => ({ branchId: v }) },
  createSchema: z.object({
    name: str(150), branchId: optId, type: z.enum(['BRANCH', 'FIELD', 'CUSTOMER_SITE']).default('BRANCH'),
    latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180), radiusMeters: z.coerce.number().int().min(10).max(50000), isActive: z.boolean().optional(),
  }),
}));

router.use('/holidays', crudRouter({
  model: 'holiday', entity: 'Holiday', perm: { view: 'attendance.view', create: 'leaves.settings', edit: 'leaves.settings', delete: 'leaves.settings' },
  searchFields: ['nameAr', 'nameEn'], orderBy: { date: 'asc' }, sortable: ['date'],
  filters: { year: (v) => ({ date: { gte: new Date(Date.UTC(Number(v), 0, 1)), lte: new Date(Date.UTC(Number(v), 11, 31)) } }) },
  createSchema: z.object({ date, nameAr: str(200), nameEn: str(200), branchId: optId, isPaid: z.boolean().optional() }),
  toData: (b) => ({ ...b, ...(b.date ? { date: toDateOnly(b.date) } : {}) }),
}));

// Devices: the API key is shown once at creation/rotation and only its hash is stored
router.get('/devices', authorize('attendance.settings'), ah(async (req, res) => {
  const items = await prisma.attendanceDevice.findMany({ where: { companyId: req.ctx.companyId }, orderBy: { createdAt: 'desc' }, select: { id: true, branchId: true, type: true, name: true, serial: true, apiKeyPrefix: true, status: true, lastSeenAt: true, createdAt: true } });
  res.json({ items });
}));
router.post('/devices', authorize('attendance.settings'),
  validate({ body: z.object({ name: str(150), type: z.enum(['KIOSK', 'BIOMETRIC', 'NFC', 'FACE']), branchId: optId, serial: optStr(120) }) }),
  ah(async (req, res) => {
    const key = `sdk_${randomToken(32)}`;
    const dev = await prisma.attendanceDevice.create({ data: { ...req.body, companyId: req.ctx.companyId, apiKeyHash: sha256(key), apiKeyPrefix: key.slice(0, 10) } });
    await audit.record(req.ctx, { action: 'CREATE', entityType: 'AttendanceDevice', entityId: dev.id, newValue: { name: dev.name, type: dev.type } });
    res.status(201).json({ id: dev.id, name: dev.name, type: dev.type, apiKey: key });
  }));
router.post('/devices/:id/rotate-key', authorize('attendance.settings'), ah(async (req, res) => {
  const dev = await prisma.attendanceDevice.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId } });
  if (!dev) throw notFound();
  const key = `sdk_${randomToken(32)}`;
  await prisma.attendanceDevice.update({ where: { id: dev.id }, data: { apiKeyHash: sha256(key), apiKeyPrefix: key.slice(0, 10) } });
  await audit.record(req.ctx, { action: 'ROTATE_KEY', entityType: 'AttendanceDevice', entityId: dev.id });
  res.json({ id: dev.id, apiKey: key });
}));
router.patch('/devices/:id', authorize('attendance.settings'), validate({ body: z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }) }), ah(async (req, res) => {
  const dev = await prisma.attendanceDevice.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId } });
  if (!dev) throw notFound();
  await prisma.attendanceDevice.update({ where: { id: dev.id }, data: { status: req.body.status } });
  await audit.record(req.ctx, { action: 'UPDATE', entityType: 'AttendanceDevice', entityId: dev.id, newValue: req.body });
  res.status(204).end();
}));

// ───── Reports ─────
const REPORTS = ['daily', 'monthly', 'employee', 'branch', 'late', 'absence', 'overtime', 'missing-checkout', 'corrections', 'suspicious'];
router.get('/reports/:type', authorize('attendance.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const { type } = req.params;
  if (!REPORTS.includes(type)) throw notFound();
  const q = req.validQuery;
  const from = q.from || fmtDate(dayjs().startOf('month').toDate());
  const to = q.to || fmtDate(localDate(new Date(), req.ctx.tz));
  const base = await recordsWhere(req.ctx, { ...q, from, to, date: type === 'daily' ? q.date || to : undefined, ...(type === 'daily' ? { from: undefined, to: undefined } : {}) });
  let rows;
  let columns = recordColumns;
  const fmt = q.format || 'json';
  if (type === 'monthly' || type === 'employee' || type === 'branch') {
    const groupKey = type === 'branch' ? 'branch' : 'employee';
    const recs = await prisma.attendanceRecord.findMany({ where: base, include: recordInclude, take: 100000 });
    const map = new Map();
    for (const r of recs) {
      const key = groupKey === 'branch' ? r.employee.branch?.nameEn || '-' : r.employeeId;
      const acc = map.get(key) || { key, name: groupKey === 'branch' ? key : empName(r.employee), employeeNumber: r.employee.employeeNumber, present: 0, late: 0, absent: 0, leave: 0, halfDay: 0, lateMinutes: 0, workedHours: 0, overtimeHours: 0, approvedOvertimeHours: 0 };
      if (['PRESENT', 'INCOMPLETE'].includes(r.status)) acc.present++;
      if (r.status === 'LATE') { acc.present++; acc.late++; }
      if (r.status === 'ABSENT') acc.absent++;
      if (r.status === 'ON_LEAVE') acc.leave++;
      if (r.status === 'HALF_DAY') acc.halfDay++;
      acc.lateMinutes += r.lateMinutes;
      acc.workedHours += r.workedMinutes / 60;
      acc.overtimeHours += r.overtimeMinutes / 60;
      acc.approvedOvertimeHours += r.overtimeApprovedMinutes / 60;
      map.set(key, acc);
    }
    rows = [...map.values()].map((r) => ({ ...r, workedHours: r.workedHours.toFixed(1), overtimeHours: r.overtimeHours.toFixed(1), approvedOvertimeHours: r.approvedOvertimeHours.toFixed(1) }));
    columns = [
      ...(groupKey === 'employee' ? [{ header: 'Employee ID', key: 'employeeNumber' }] : []), { header: groupKey === 'branch' ? 'Branch' : 'Employee', key: 'name' },
      { header: 'Present', key: 'present' }, { header: 'Late', key: 'late' }, { header: 'Absent', key: 'absent' }, { header: 'Leave', key: 'leave' }, { header: 'Half day', key: 'halfDay' },
      { header: 'Late min', key: 'lateMinutes' }, { header: 'Worked h', key: 'workedHours' }, { header: 'OT h', key: 'overtimeHours' }, { header: 'OT approved h', key: 'approvedOvertimeHours' },
    ];
  } else if (type === 'corrections') {
    rows = await prisma.attendanceCorrection.findMany({ where: { companyId: req.ctx.companyId, date: { gte: toDateOnly(from), lte: toDateOnly(to) }, employee: await employeeWhere(req.ctx, 'attendance.view') }, include: { employee: recordInclude.employee }, orderBy: { date: 'desc' } });
    columns = [{ header: 'Date', value: (r) => fmtDate(r.date) }, { header: 'Employee', value: (r) => empName(r.employee) }, { header: 'Type', key: 'type' }, { header: 'Requested in', value: (r) => r.requestedCheckIn?.toISOString() || '' }, { header: 'Requested out', value: (r) => r.requestedCheckOut?.toISOString() || '' }, { header: 'Reason', key: 'reason' }, { header: 'Status', key: 'status' }];
  } else {
    const extra = { late: { lateMinutes: { gt: 0 } }, absence: { status: 'ABSENT' }, overtime: { overtimeMinutes: { gt: 0 } }, 'missing-checkout': { firstCheckIn: { not: null }, lastCheckOut: null }, suspicious: { isSuspicious: true }, daily: {} }[type];
    rows = await prisma.attendanceRecord.findMany({ where: { AND: [base, extra] }, include: recordInclude, orderBy: [{ date: 'desc' }], take: 50000 });
  }
  if (fmt !== 'json') {
    if (!hasPermission(req.ctx, 'attendance.export')) throw require('../../utils/errors').forbidden('PERMISSION_DENIED');
    return exporter.send(res, fmt, { title: `Attendance — ${type}`, subtitle: `${from} → ${to}`, filename: `attendance-${type}`, columns, rows });
  }
  res.json({ type, from, to, ...exporter.table(columns, rows) });
}));

module.exports = router;
