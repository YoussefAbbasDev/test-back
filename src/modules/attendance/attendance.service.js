const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden, unauthorized } = require('../../utils/errors');
const { toDateOnly, fmtDate, localDate, addDays, weekday, dayjs, eachDay } = require('../../utils/dates');
const { sha256, randomToken } = require('../../utils/crypto');
const engine = require('../../engines/attendance');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const { notify, userForEmployee } = require('../../services/notifications');
const { assertEmployeeAccess, employeeWhere } = require('../../services/scope');
const { empName } = require('../../services/common');

const DEFAULT_POLICY = {
  graceMinutes: 10, lateCountFromShiftStart: true, earlyLeaveGraceMinutes: 5, breakMinutes: 60, overtimeEnabled: true, overtimeMinMinutes: 30,
  overtimeRequiresApproval: true, weekendWorkIsOvertime: true, holidayWorkIsOvertime: true, missingCheckoutAction: 'MARK_INCOMPLETE',
  allowMultipleSessions: true, correctionWindowDays: 7, correctionRequiresHR: false, requireGeofence: true, maxGpsAccuracyMeters: 100,
  rejectOutsideGeofence: true, allowedMethods: ['GPS', 'QR', 'KIOSK', 'MANUAL', 'BIOMETRIC', 'NFC'], minMinutesBetweenEvents: 1,
};

// employee override → department → branch → company default
const resolvePolicy = async (employee, tx = prisma) => {
  const where = { companyId: employee.companyId, status: 'ACTIVE' };
  let p = null;
  if (employee.attendancePolicyId) p = await tx.attendancePolicy.findFirst({ where: { ...where, id: employee.attendancePolicyId } });
  if (!p && employee.departmentId) p = await tx.attendancePolicy.findFirst({ where: { ...where, scope: 'DEPARTMENT', departmentId: employee.departmentId } });
  if (!p && employee.branchId) p = await tx.attendancePolicy.findFirst({ where: { ...where, scope: 'BRANCH', branchId: employee.branchId } });
  if (!p) p = await tx.attendancePolicy.findFirst({ where: { ...where, isDefault: true } });
  return { ...DEFAULT_POLICY, ...(p || {}), allowedMethods: p?.allowedMethods || DEFAULT_POLICY.allowedMethods };
};

const isHoliday = async (companyId, branchId, date, tx = prisma) =>
  (await tx.holiday.count({ where: { companyId, date: toDateOnly(date), OR: [{ branchId: null }, { branchId: branchId || undefined }] } })) > 0;

/** Schedule of an employee on a local work date: { shift, start, end, expectedMinutes, graceMinutes, dayType } */
const resolveSchedule = async (employee, date, company, tx = prisma) => {
  const d = toDateOnly(date);
  const holiday = await isHoliday(company.id, employee.branchId, d, tx);
  const assignment = await tx.shiftAssignment.findFirst({ where: { employeeId: employee.id, date: d, status: 'SCHEDULED' }, include: { shift: true }, orderBy: { startAt: 'asc' } });
  const weekend = (company.weekendDays || []).includes(weekday(d));
  let shift = assignment?.shift || null;
  if (!shift && employee.defaultShiftId && !weekend) {
    const def = await tx.shift.findFirst({ where: { id: employee.defaultShiftId, companyId: company.id } });
    if (def && (def.workingDays || []).includes(weekday(d))) shift = def;
  }
  const dayType = holiday ? 'HOLIDAY' : !shift && weekend ? 'WEEKEND' : 'WORKDAY';
  if (!shift || dayType !== 'WORKDAY') return { shift: dayType === 'WORKDAY' ? null : shift, start: null, end: null, dayType, scheduled: !!shift && dayType === 'WORKDAY' };
  const win = assignment ? { start: assignment.startAt, end: assignment.endAt } : engine.shiftWindow(shift, d, company.timezone);
  return { shift, start: win.start, end: win.end, expectedMinutes: shift.expectedMinutes, graceMinutes: shift.graceMinutes ?? undefined, dayType, scheduled: true };
};

// Which work date does a punch belong to? Open sessions and over-midnight shifts keep the previous date.
const resolveWorkDate = async (employee, at, company, tx = prisma) => {
  const today = localDate(at, company.timezone);
  const yesterday = addDays(today, -1);
  const prev = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: employee.id, date: yesterday } }, include: { events: true } });
  if (prev) {
    const { open } = engine.buildSessions(prev.events);
    if (open && engine.toMinutes && (new Date(at) - new Date(open.in)) / 3600000 < 20) return yesterday;
  }
  const prevAssign = await tx.shiftAssignment.findFirst({ where: { employeeId: employee.id, date: yesterday, status: 'SCHEDULED', endAt: { gte: dayjs(at).subtract(3, 'hour').toDate() }, startAt: { lte: at } } });
  if (prevAssign) return yesterday;
  return today;
};

const recompute = async (tx, recordId) => {
  const record = await tx.attendanceRecord.findUnique({ where: { id: recordId }, include: { events: true, employee: true } });
  const company = await tx.company.findUnique({ where: { id: record.companyId } });
  const policy = await resolvePolicy(record.employee, tx);
  const schedule = await resolveSchedule(record.employee, record.date, company, tx);
  const calc = engine.computeRecord({ events: record.events, schedule: schedule.start ? schedule : null, dayType: schedule.dayType, policy });
  const keepStatus = ['ON_LEAVE', 'PENDING_APPROVAL'].includes(record.status) && !calc.firstCheckIn;
  const otStatus = calc.overtimeMinutes > 0 ? (policy.overtimeRequiresApproval ? (record.overtimeStatus === 'APPROVED' || record.overtimeStatus === 'REJECTED' ? record.overtimeStatus : 'PENDING') : 'APPROVED') : 'NONE';
  const firstIn = record.events.filter((e) => !e.isVoided && e.type === 'CHECK_IN').sort((a, b) => a.occurredAt - b.occurredAt)[0];
  const lastOut = record.events.filter((e) => !e.isVoided && e.type === 'CHECK_OUT').sort((a, b) => b.occurredAt - a.occurredAt)[0];
  return tx.attendanceRecord.update({
    where: { id: recordId },
    data: {
      shiftId: schedule.shift?.id || null, scheduledStart: schedule.start, scheduledEnd: schedule.end, dayType: schedule.dayType,
      firstCheckIn: calc.firstCheckIn, lastCheckOut: calc.lastCheckOut, checkInMethod: calc.checkInMethod, checkOutMethod: calc.checkOutMethod,
      checkInLat: firstIn?.latitude ?? null, checkInLng: firstIn?.longitude ?? null, checkInLocationId: firstIn?.locationId ?? null,
      checkOutLat: lastOut?.latitude ?? null, checkOutLng: lastOut?.longitude ?? null, checkOutLocationId: lastOut?.locationId ?? null,
      workedMinutes: calc.workedMinutes, breakMinutes: calc.breakMinutes, lateMinutes: calc.lateMinutes, earlyLeaveMinutes: calc.earlyLeaveMinutes,
      regularMinutes: calc.regularMinutes, overtimeMinutes: calc.overtimeMinutes,
      overtimeApprovedMinutes: otStatus === 'APPROVED' ? (record.overtimeStatus === 'APPROVED' && record.overtimeApprovedMinutes ? Math.min(record.overtimeApprovedMinutes, calc.overtimeMinutes) : calc.overtimeMinutes) : 0,
      overtimeStatus: otStatus,
      status: keepStatus ? record.status : calc.firstCheckIn ? (calc.status === 'PRESENT' && schedule.dayType === 'HOLIDAY' ? 'PRESENT' : calc.status) : schedule.dayType === 'HOLIDAY' ? 'HOLIDAY' : schedule.dayType === 'WEEKEND' ? 'DAY_OFF' : 'ABSENT',
      isSuspicious: record.events.some((e) => e.isSuspicious && !e.isVoided),
    },
  });
};

const ensureRecord = async (tx, employee, date) => {
  const d = toDateOnly(date);
  const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: employee.id, date: d } } });
  if (existing) return existing;
  return tx.attendanceRecord.create({ data: { companyId: employee.companyId, employeeId: employee.id, date: d, status: 'INCOMPLETE' } });
};

/**
 * punch(ctx, employeeId, { type, method, latitude, longitude, accuracy, qrToken, deviceInfo, occurredAt, deviceId })
 * Validates method/policy/location/sequence, stores the event, recomputes the daily record.
 */
const punch = async (ctx, employeeId, input) => {
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId, deletedAt: null } });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND');
  if (['TERMINATED', 'RESIGNED', 'INACTIVE', 'SUSPENDED'].includes(employee.status)) throw forbidden('ACCOUNT_DISABLED');
  const company = ctx.company || (await prisma.company.findUnique({ where: { id: ctx.companyId } }));
  const policy = await resolvePolicy(employee);
  const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (!policy.allowedMethods.includes(input.method) && !['SYSTEM', 'CORRECTION'].includes(input.method)) throw badRequest('METHOD_NOT_ALLOWED', { method: input.method });

  const flags = [];
  let locationId = null;
  let distance = null;
  let qrTokenId = null;

  if (input.method === 'GPS') {
    if (input.latitude == null || input.longitude == null) throw badRequest('LOCATION_REQUIRED');
    if (input.accuracy != null && Number(input.accuracy) > policy.maxGpsAccuracyMeters) {
      if (policy.requireGeofence) throw badRequest('GPS_ACCURACY_TOO_LOW', { accuracy: Math.round(input.accuracy) });
      flags.push('LOW_ACCURACY');
    }
    const locations = await prisma.attendanceLocation.findMany({ where: { companyId: ctx.companyId, isActive: true, OR: [{ branchId: employee.branchId }, { branchId: null, type: { in: ['FIELD', 'CUSTOMER_SITE'] } }] } });
    if (!locations.length) {
      if (policy.requireGeofence) throw badRequest('NO_GEOFENCE_CONFIGURED');
      flags.push('NO_GEOFENCE');
    } else {
      const near = engine.nearestLocation(Number(input.latitude), Number(input.longitude), locations);
      distance = near.distance;
      locationId = near.location.id;
      if (!near.inside) {
        if (policy.requireGeofence && policy.rejectOutsideGeofence) {
          await audit.record(ctx, { action: 'ATTENDANCE_OUTSIDE_GEOFENCE', entityType: 'AttendanceEvent', employeeId, newValue: { distance, lat: input.latitude, lng: input.longitude } });
          throw badRequest('OUTSIDE_GEOFENCE', { distance });
        }
        flags.push('OUTSIDE_GEOFENCE');
      }
    }
  }

  if (input.method === 'QR') {
    const token = input.qrToken ? await prisma.qrToken.findUnique({ where: { tokenHash: sha256(input.qrToken) } }) : null;
    if (!token || token.companyId !== ctx.companyId || token.expiresAt < at) throw badRequest('QR_INVALID');
    if (token.branchId !== employee.branchId) throw badRequest('QR_WRONG_BRANCH');
    qrTokenId = token.id;
    locationId = null;
  }

  return prisma.$transaction(async (tx) => {
    // serialize punches per employee
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employee.id} FOR UPDATE`;
    const workDate = await resolveWorkDate(employee, at, company, tx);
    const record = await ensureRecord(tx, employee, workDate);
    const events = await tx.attendanceEvent.findMany({ where: { recordId: record.id, isVoided: false }, orderBy: { occurredAt: 'asc' } });
    const allowed = engine.nextAllowed(events);
    const last = events[events.length - 1];
    if (last && Math.abs(at - last.occurredAt) < policy.minMinutesBetweenEvents * 60000 && last.type === input.type) throw conflict('EVENT_TOO_SOON');
    if (input.type === 'CHECK_IN') {
      if (!allowed.checkIn) throw conflict('ALREADY_CHECKED_IN');
      if (allowed.sessions > 0 && !policy.allowMultipleSessions) throw conflict('MULTIPLE_SESSIONS_NOT_ALLOWED');
    }
    if (input.type === 'CHECK_OUT' && !allowed.checkOut) throw conflict('NOT_CHECKED_IN');
    if (input.type === 'BREAK_START' && !allowed.breakStart) throw conflict(allowed.checkOut ? 'BREAK_ALREADY_STARTED' : 'NOT_CHECKED_IN');
    if (input.type === 'BREAK_END' && !allowed.breakEnd) throw conflict('NOT_ON_BREAK');

    // anti-fraud heuristics (flag for review — never assumed to be conclusive)
    const prevLocated = [...events].reverse().find((e) => e.latitude != null);
    if (input.latitude != null && engine.impossibleTravel(prevLocated, { latitude: input.latitude, longitude: input.longitude, occurredAt: at })) flags.push('IMPOSSIBLE_TRAVEL');
    if (input.deviceInfo) {
      const sameDevice = await tx.attendanceEvent.count({ where: { companyId: ctx.companyId, deviceInfo: input.deviceInfo, employeeId: { not: employee.id }, occurredAt: { gte: dayjs(at).subtract(10, 'minute').toDate() } } });
      if (sameDevice) flags.push('SHARED_DEVICE');
    }
    if (input.method === 'GPS' && input.accuracy != null && Number(input.accuracy) < 1) flags.push('SUSPICIOUS_ACCURACY');

    const event = await tx.attendanceEvent.create({
      data: {
        companyId: ctx.companyId, employeeId: employee.id, recordId: record.id, type: input.type, occurredAt: at, method: input.method,
        latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, distanceMeters: distance,
        locationId, deviceId: input.deviceId || null, deviceInfo: input.deviceInfo?.slice(0, 300) || null, qrTokenId, ip: ctx.ip || null,
        isSuspicious: flags.length > 0, flags: flags.length ? flags : undefined, createdById: ctx.userId || null,
      },
    });
    if (flags.length) await tx.attendanceRecord.update({ where: { id: record.id }, data: { flags } });
    const updated = await recompute(tx, record.id);
    if (input.type === 'CHECK_IN' && updated.lateMinutes > 0 && employee.managerId) {
      const mgr = await userForEmployee(employee.managerId, tx);
      await notify({ companyId: ctx.companyId, userIds: [mgr], type: 'EMPLOYEE_LATE', params: { employee: empName(employee), minutes: updated.lateMinutes }, link: '/attendance' }, tx);
    }
    return { event, record: updated };
  });
};

const today = async (ctx) => {
  if (!ctx.employeeId) return { employee: null };
  const employee = await prisma.employee.findUnique({ where: { id: ctx.employeeId } });
  const date = await resolveWorkDate(employee, new Date(), ctx.company);
  const record = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: employee.id, date } }, include: { events: { orderBy: { occurredAt: 'asc' } }, shift: true } });
  const schedule = await resolveSchedule(employee, date, ctx.company);
  const policy = await resolvePolicy(employee);
  return { date: fmtDate(date), record, schedule: { shift: schedule.shift, start: schedule.start, end: schedule.end, dayType: schedule.dayType }, allowed: engine.nextAllowed(record?.events || []), allowedMethods: policy.allowedMethods, requireGeofence: policy.requireGeofence };
};

// ── QR codes ──
const issueQr = async (ctx, branchId, ttlSeconds = 60) => {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: ctx.companyId } });
  if (!branch) throw notFound();
  const token = randomToken(24);
  const row = await prisma.qrToken.create({ data: { companyId: ctx.companyId, branchId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlSeconds * 1000) } });
  await prisma.qrToken.deleteMany({ where: { companyId: ctx.companyId, expiresAt: { lt: dayjs().subtract(1, 'day').toDate() } } });
  return { token, expiresAt: row.expiresAt, branch: { id: branch.id, nameAr: branch.nameAr, nameEn: branch.nameEn } };
};

// ── Devices (kiosk / biometric / NFC adapters) ──
const authenticateDevice = async (key) => {
  if (!key) throw unauthorized('DEVICE_UNAUTHORIZED');
  const device = await prisma.attendanceDevice.findFirst({ where: { apiKeyHash: sha256(key), status: 'ACTIVE' } });
  if (!device) throw unauthorized('DEVICE_UNAUTHORIZED');
  await prisma.attendanceDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  const company = await prisma.company.findUnique({ where: { id: device.companyId } });
  return { device, ctx: { companyId: device.companyId, company, userId: null, userName: `device:${device.name}`, tz: company.timezone } };
};

// ── Corrections & manual attendance (approval workflow ATTENDANCE_CORRECTION) ──
const requestCorrection = async (ctx, body, { manual = false } = {}) => {
  const employeeId = body.employeeId || ctx.employeeId;
  if (!employeeId) throw badRequest('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, employeeId, manual ? 'attendance.manual' : 'attendance.create');
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  const policy = await resolvePolicy(employee);
  const date = toDateOnly(body.date);
  if (!manual && dayjs().diff(dayjs(date), 'day') > policy.correctionWindowDays) throw badRequest('CORRECTION_WINDOW_PASSED');
  if (date > toDateOnly(dayjs().add(1, 'day').toDate())) throw badRequest('VALIDATION_FAILED');
  const pending = await prisma.attendanceCorrection.findFirst({ where: { employeeId, date, status: 'PENDING' } });
  if (pending) throw conflict('CORRECTION_PENDING_EXISTS');
  const record = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date } } });
  const toInstant = (hhmm, nextDay) => (hhmm ? require('../../utils/dates').localTimeToUtc(nextDay ? addDays(date, 1) : date, hhmm, ctx.tz) : null);
  return prisma.$transaction(async (tx) => {
    const corr = await tx.attendanceCorrection.create({
      data: {
        companyId: ctx.companyId, employeeId, recordId: record?.id || null, date, type: manual ? 'MANUAL_ENTRY' : 'CORRECTION',
        originalCheckIn: record?.firstCheckIn || null, originalCheckOut: record?.lastCheckOut || null,
        requestedCheckIn: toInstant(body.checkIn), requestedCheckOut: toInstant(body.checkOut, body.checkOutNextDay),
        reason: body.reason, attachmentId: body.attachmentId || null, createdById: ctx.userId,
      },
    });
    if (record) await tx.attendanceRecord.update({ where: { id: record.id }, data: { approvalStatus: 'PENDING' } });
    const res = await approvals.start(tx, ctx, { entityType: 'ATTENDANCE_CORRECTION', entityId: corr.id, requesterEmployeeId: employeeId, requesterUserId: manual ? ctx.userId : undefined, summary: `${empName(employee)} — ${fmtDate(date)}` });
    await tx.attendanceCorrection.update({ where: { id: corr.id }, data: { approvalInstanceId: res.instance.id } });
    await audit.record(ctx, { action: manual ? 'MANUAL_ATTENDANCE_REQUESTED' : 'ATTENDANCE_CORRECTION_REQUESTED', entityType: 'AttendanceCorrection', entityId: corr.id, employeeId, after: corr, reason: body.reason }, tx);
    return tx.attendanceCorrection.findUnique({ where: { id: corr.id } });
  });
};

const applyCorrection = async (tx, corrId, ctx) => {
  const corr = await tx.attendanceCorrection.findUnique({ where: { id: corrId } });
  const employee = await tx.employee.findUnique({ where: { id: corr.employeeId } });
  const record = await ensureRecord(tx, employee, corr.date);
  // Original events are kept (voided) — never silently overwritten
  const voidTypes = [];
  if (corr.requestedCheckIn) voidTypes.push('CHECK_IN');
  if (corr.requestedCheckOut) voidTypes.push('CHECK_OUT');
  const events = await tx.attendanceEvent.findMany({ where: { recordId: record.id, isVoided: false, type: { in: voidTypes } }, orderBy: { occurredAt: 'asc' } });
  if (corr.requestedCheckIn) {
    const firstIn = events.find((e) => e.type === 'CHECK_IN');
    if (firstIn) await tx.attendanceEvent.update({ where: { id: firstIn.id }, data: { isVoided: true } });
    await tx.attendanceEvent.create({ data: { companyId: corr.companyId, employeeId: corr.employeeId, recordId: record.id, type: 'CHECK_IN', occurredAt: corr.requestedCheckIn, method: corr.type === 'MANUAL_ENTRY' ? 'MANUAL' : 'CORRECTION', createdById: corr.createdById } });
  }
  if (corr.requestedCheckOut) {
    const lastOut = [...events].reverse().find((e) => e.type === 'CHECK_OUT');
    if (lastOut) await tx.attendanceEvent.update({ where: { id: lastOut.id }, data: { isVoided: true } });
    await tx.attendanceEvent.create({ data: { companyId: corr.companyId, employeeId: corr.employeeId, recordId: record.id, type: 'CHECK_OUT', occurredAt: corr.requestedCheckOut, method: corr.type === 'MANUAL_ENTRY' ? 'MANUAL' : 'CORRECTION', createdById: corr.createdById } });
  }
  await tx.attendanceRecord.update({ where: { id: record.id }, data: { approvalStatus: 'APPROVED', isManual: corr.type === 'MANUAL_ENTRY' || record.isManual, status: 'INCOMPLETE' } });
  await tx.attendanceCorrection.update({ where: { id: corr.id }, data: { status: 'APPROVED', decidedAt: new Date(), recordId: record.id } });
  await recompute(tx, record.id);
  await audit.record(ctx, { action: 'ATTENDANCE_CORRECTION_APPLIED', entityType: 'AttendanceRecord', entityId: record.id, employeeId: corr.employeeId, oldValue: { checkIn: corr.originalCheckIn, checkOut: corr.originalCheckOut }, newValue: { checkIn: corr.requestedCheckIn, checkOut: corr.requestedCheckOut }, reason: corr.reason }, tx);
};

approvals.registerHandler('ATTENDANCE_CORRECTION', {
  onApproved: (tx, inst, ctx) => applyCorrection(tx, inst.entityId, ctx),
  onRejected: async (tx, inst) => {
    const corr = await tx.attendanceCorrection.update({ where: { id: inst.entityId }, data: { status: 'REJECTED', decidedAt: new Date() } });
    if (corr.recordId) await tx.attendanceRecord.update({ where: { id: corr.recordId }, data: { approvalStatus: 'REJECTED' } });
  },
});

const decideOvertime = async (ctx, recordId, { approve, minutes, reason }) => {
  const rec = await prisma.attendanceRecord.findFirst({ where: { id: recordId, companyId: ctx.companyId } });
  if (!rec) throw notFound();
  await assertEmployeeAccess(ctx, rec.employeeId, 'attendance.approve');
  if (rec.employeeId === ctx.employeeId) throw forbidden('NOT_YOUR_APPROVAL');
  const approved = approve ? Math.min(minutes ?? rec.overtimeMinutes, rec.overtimeMinutes) : 0;
  const updated = await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { overtimeStatus: approve ? 'APPROVED' : 'REJECTED', overtimeApprovedMinutes: approved } });
  await audit.record(ctx, { action: approve ? 'OVERTIME_APPROVED' : 'OVERTIME_REJECTED', entityType: 'AttendanceRecord', entityId: rec.id, employeeId: rec.employeeId, before: rec, after: updated, reason });
  return updated;
};

/**
 * Daily finalization (cron + manual trigger): ABSENT / ON_LEAVE records for scheduled employees with no punch,
 * missing-checkout handling. Idempotent.
 */
const finalizeDay = async (companyId, dateInput) => {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const date = toDateOnly(dateInput);
  const employees = await prisma.employee.findMany({ where: { companyId, deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] }, hireDate: { lte: date } } });
  const leaves = await prisma.leaveRequest.findMany({ where: { companyId, status: 'APPROVED', startDate: { lte: date }, endDate: { gte: date } }, select: { employeeId: true } });
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  let absent = 0;
  let leave = 0;
  let missing = 0;
  for (const emp of employees) {
    const existing = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: emp.id, date } }, include: { events: true } });
    if (!existing) {
      const schedule = await resolveSchedule(emp, date, company);
      if (onLeave.has(emp.id)) {
        await prisma.attendanceRecord.create({ data: { companyId, employeeId: emp.id, date, status: 'ON_LEAVE', dayType: schedule.dayType, shiftId: schedule.shift?.id || null } });
        leave++;
      } else if (schedule.dayType === 'WORKDAY' && schedule.scheduled) {
        await prisma.attendanceRecord.create({ data: { companyId, employeeId: emp.id, date, status: 'ABSENT', dayType: 'WORKDAY', shiftId: schedule.shift.id, scheduledStart: schedule.start, scheduledEnd: schedule.end } });
        absent++;
        const mgr = await userForEmployee(emp.managerId);
        await notify({ companyId, userIds: [mgr], type: 'EMPLOYEE_ABSENT', params: { employee: empName(emp), date: fmtDate(date) }, link: '/attendance' });
      }
      continue;
    }
    if (existing.status === 'ABSENT' && onLeave.has(emp.id)) {
      await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { status: 'ON_LEAVE' } });
      continue;
    }
    const { open } = engine.buildSessions(existing.events);
    if (open) {
      const policy = await resolvePolicy(emp);
      missing++;
      if (policy.missingCheckoutAction === 'AUTO_SHIFT_END' && existing.scheduledEnd) {
        await prisma.$transaction(async (tx) => {
          await tx.attendanceEvent.create({ data: { companyId, employeeId: emp.id, recordId: existing.id, type: 'CHECK_OUT', occurredAt: existing.scheduledEnd, method: 'SYSTEM', isSuspicious: true, flags: ['AUTO_CHECKOUT'] } });
          await recompute(tx, existing.id);
        });
      } else {
        await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { status: 'INCOMPLETE', flags: ['MISSING_CHECKOUT'] } });
      }
      const u = await userForEmployee(emp.id);
      await notify({ companyId, userIds: [u], type: 'MISSING_CHECKOUT', params: { date: fmtDate(date) }, link: '/attendance/me' });
    }
  }
  return { date: fmtDate(date), absent, leave, missingCheckouts: missing };
};

const dashboard = async (ctx, { date, branchId, from, to }) => {
  const d = toDateOnly(date || localDate(new Date(), ctx.tz));
  const empWhere = { AND: [await employeeWhere(ctx, 'attendance.view'), { deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] } }, branchId ? { branchId } : {}] };
  const totalEmployees = await prisma.employee.count({ where: empWhere });
  const recWhere = { companyId: ctx.companyId, date: d, employee: empWhere };
  const byStatus = await prisma.attendanceRecord.groupBy({ by: ['status'], where: recWhere, _count: true });
  const c = Object.fromEntries(byStatus.map((x) => [x.status, x._count]));
  const [early, missing, ot, leaveToday] = await Promise.all([
    prisma.attendanceRecord.count({ where: { ...recWhere, earlyLeaveMinutes: { gt: 0 } } }),
    prisma.attendanceRecord.count({ where: { ...recWhere, firstCheckIn: { not: null }, lastCheckOut: null } }),
    prisma.attendanceRecord.aggregate({ where: { ...recWhere }, _sum: { overtimeMinutes: true } }),
    prisma.leaveRequest.count({ where: { companyId: ctx.companyId, status: 'APPROVED', startDate: { lte: d }, endDate: { gte: d }, employee: empWhere } }),
  ]);
  const present = (c.PRESENT || 0) + (c.LATE || 0) + (c.HALF_DAY || 0) + (c.INCOMPLETE || 0);
  // trend for the range (default last 14 days)
  const start = toDateOnly(from || dayjs(d).subtract(13, 'day').toDate());
  const end = toDateOnly(to || d);
  const trendRows = await prisma.attendanceRecord.groupBy({ by: ['date', 'status'], where: { companyId: ctx.companyId, date: { gte: start, lte: end }, employee: empWhere }, _count: true });
  const trend = eachDay(start, end).map((day) => {
    const rows = trendRows.filter((r) => fmtDate(r.date) === fmtDate(day));
    const get = (s) => rows.find((r) => r.status === s)?._count || 0;
    return { date: fmtDate(day), present: get('PRESENT') + get('INCOMPLETE'), late: get('LATE'), absent: get('ABSENT'), leave: get('ON_LEAVE'), halfDay: get('HALF_DAY') };
  });
  return {
    date: fmtDate(d), totalEmployees, presentToday: present, absentToday: c.ABSENT || 0, lateArrivals: c.LATE || 0, earlyDepartures: early,
    onLeave: Math.max(leaveToday, c.ON_LEAVE || 0), missingCheckouts: missing, overtimeHours: Math.round(((ot._sum.overtimeMinutes || 0) / 60) * 10) / 10,
    attendancePercentage: totalEmployees ? Math.round((present / Math.max(1, totalEmployees - (c.ON_LEAVE || 0))) * 1000) / 10 : 0,
    suspicious: await prisma.attendanceRecord.count({ where: { ...recWhere, isSuspicious: true } }),
    trend,
  };
};

module.exports = { resolvePolicy, resolveSchedule, resolveWorkDate, recompute, punch, today, issueQr, authenticateDevice, requestCorrection, applyCorrection, decideOvertime, finalizeDay, dashboard, isHoliday, DEFAULT_POLICY };
