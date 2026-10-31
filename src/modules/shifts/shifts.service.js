const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, eachDay, weekday, dayjs, addDays } = require('../../utils/dates');
const engine = require('../../engines/attendance');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const { notify, userForEmployee } = require('../../services/notifications');
const { employeeWhere, assertEmployeeAccess } = require('../../services/scope');
const { empName } = require('../../services/common');

const getSetting = async (companyId, key, fallback = null) => {
  const s = await prisma.systemSetting.findUnique({ where: { companyId_key: { companyId, key } } });
  return s ? s.value : fallback;
};

/**
 * Validates one prospective assignment. Returns null when OK or { code, params } describing the conflict.
 */
const checkAssignment = async (tx, ctx, { employee, shift, date, window, branchId, ignoreAssignmentIds = [], maxWeeklyMinutes }) => {
  if (branchId && employee.branchId && employee.branchId !== branchId) return { code: 'EMPLOYEE_WRONG_BRANCH' };
  if (shift.branchId && employee.branchId && shift.branchId !== employee.branchId && !branchId) return { code: 'EMPLOYEE_WRONG_BRANCH' };
  if (['TERMINATED', 'RESIGNED', 'INACTIVE', 'SUSPENDED'].includes(employee.status)) return { code: 'ACCOUNT_DISABLED' };
  const leave = await tx.leaveRequest.count({ where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: date }, endDate: { gte: date } } });
  if (leave) return { code: 'EMPLOYEE_ON_LEAVE', params: { date: fmtDate(date) } };
  // overlap with any scheduled assignment (covers over-midnight shifts since UTC windows are compared)
  const clash = await tx.shiftAssignment.findFirst({
    where: { employeeId: employee.id, status: 'SCHEDULED', id: { notIn: ignoreAssignmentIds }, startAt: { lt: window.end }, endAt: { gt: window.start } },
  });
  if (clash) return { code: 'SHIFT_CONFLICT', params: { date: fmtDate(clash.date) } };
  if (maxWeeklyMinutes) {
    const weekStart = dayjs(date).startOf('week').toDate();
    const weekEnd = dayjs(date).endOf('week').toDate();
    const week = await tx.shiftAssignment.findMany({ where: { employeeId: employee.id, status: 'SCHEDULED', id: { notIn: ignoreAssignmentIds }, date: { gte: toDateOnly(weekStart), lte: toDateOnly(weekEnd) } }, include: { shift: { select: { expectedMinutes: true } } } });
    const total = week.reduce((s, a) => s + a.shift.expectedMinutes, 0) + shift.expectedMinutes;
    if (total > maxWeeklyMinutes) return { code: 'MAX_HOURS_EXCEEDED', params: { max: maxWeeklyMinutes / 60 } };
  }
  return null;
};

/**
 * assign(ctx, { employeeIds | teamId, shiftId, from, to, weekdays?, branchId?, managerId?, notes?, dryRun?, source? })
 * Creates valid assignments and reports skipped ones with their reasons.
 */
const assign = async (ctx, body) => {
  const shift = await prisma.shift.findFirst({ where: { id: body.shiftId, companyId: ctx.companyId, deletedAt: null } });
  if (!shift) throw notFound();
  let employeeIds = body.employeeIds || [];
  if (body.teamId) {
    const team = await prisma.employee.findMany({ where: { companyId: ctx.companyId, teamId: body.teamId, deletedAt: null }, select: { id: true } });
    employeeIds = [...new Set([...employeeIds, ...team.map((e) => e.id)])];
  }
  if (!employeeIds.length) throw badRequest('VALIDATION_FAILED');
  const scope = await employeeWhere(ctx, 'shifts.create');
  const employees = await prisma.employee.findMany({ where: { AND: [scope, { id: { in: employeeIds }, deletedAt: null }] } });
  if (employees.length !== employeeIds.length) throw forbidden('OUT_OF_SCOPE');
  const days = eachDay(body.from, body.to).filter((d) => (body.weekdays?.length ? body.weekdays : shift.workingDays).includes(weekday(d)));
  const maxWeeklyHours = await getSetting(ctx.companyId, 'scheduling.maxWeeklyHours');
  const maxWeeklyMinutes = maxWeeklyHours ? Number(maxWeeklyHours) * 60 : null;

  const created = [];
  const skipped = [];
  await prisma.$transaction(async (tx) => {
    for (const employee of employees) {
      for (const date of days) {
        const window = engine.shiftWindow(shift, date, ctx.tz);
        const problem = await checkAssignment(tx, ctx, { employee, shift, date, window, branchId: body.branchId, maxWeeklyMinutes });
        if (problem) { skipped.push({ employeeId: employee.id, employee: empName(employee), date: fmtDate(date), ...problem }); continue; }
        if (body.dryRun) { created.push({ employeeId: employee.id, date: fmtDate(date) }); continue; }
        const a = await tx.shiftAssignment.create({
          data: {
            companyId: ctx.companyId, employeeId: employee.id, shiftId: shift.id, branchId: body.branchId || shift.branchId || employee.branchId, date,
            startAt: window.start, endAt: window.end, managerId: body.managerId || null, source: body.source || 'MANUAL', notes: body.notes || null, createdById: ctx.userId,
          },
        });
        created.push(a);
      }
    }
    if (!body.dryRun && created.length) {
      await audit.record(ctx, { action: 'SHIFT_ASSIGNED', entityType: 'ShiftAssignment', newValue: { shift: shift.code, from: body.from, to: body.to, employees: employees.length, created: created.length, skipped: skipped.length } }, tx);
      const users = await Promise.all(employees.map((e) => userForEmployee(e.id, tx)));
      await notify({ companyId: ctx.companyId, userIds: users, type: 'SHIFT_CHANGED', params: { shift: shift.nameEn, from: body.from, to: body.to }, link: '/shifts/my' }, tx);
    }
  }, { timeout: 60000 });
  return { created: created.length, skipped, dryRun: !!body.dryRun };
};

const copyWeek = async (ctx, { fromWeekStart, toWeekStart, branchId, employeeIds }) => {
  const src = toDateOnly(fromWeekStart);
  const offset = dayjs(toDateOnly(toWeekStart)).diff(dayjs(src), 'day');
  const scope = await employeeWhere(ctx, 'shifts.create');
  const rows = await prisma.shiftAssignment.findMany({
    where: { companyId: ctx.companyId, status: 'SCHEDULED', date: { gte: src, lte: addDays(src, 6) }, employee: scope, ...(branchId ? { branchId } : {}), ...(employeeIds?.length ? { employeeId: { in: employeeIds } } : {}) },
    include: { shift: true, employee: true },
  });
  const maxWeeklyHours = await getSetting(ctx.companyId, 'scheduling.maxWeeklyHours');
  const created = [];
  const skipped = [];
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const date = addDays(r.date, offset);
      const window = engine.shiftWindow(r.shift, date, ctx.tz);
      const problem = await checkAssignment(tx, ctx, { employee: r.employee, shift: r.shift, date, window, branchId: r.branchId, maxWeeklyMinutes: maxWeeklyHours ? maxWeeklyHours * 60 : null });
      if (problem) { skipped.push({ employeeId: r.employeeId, employee: empName(r.employee), date: fmtDate(date), ...problem }); continue; }
      created.push(await tx.shiftAssignment.create({ data: { companyId: ctx.companyId, employeeId: r.employeeId, shiftId: r.shiftId, branchId: r.branchId, date, startAt: window.start, endAt: window.end, managerId: r.managerId, source: 'COPY', createdById: ctx.userId } }));
    }
    await audit.record(ctx, { action: 'SCHEDULE_COPIED', entityType: 'ShiftAssignment', newValue: { fromWeekStart, toWeekStart, created: created.length, skipped: skipped.length } }, tx);
  }, { timeout: 60000 });
  return { created: created.length, skipped };
};

const updateAssignment = async (ctx, id, { shiftId, date, notes, reason }) => {
  const a = await prisma.shiftAssignment.findFirst({ where: { id, companyId: ctx.companyId, status: 'SCHEDULED' }, include: { employee: true } });
  if (!a) throw notFound();
  await assertEmployeeAccess(ctx, a.employeeId, 'shifts.edit');
  const shift = await prisma.shift.findFirst({ where: { id: shiftId || a.shiftId, companyId: ctx.companyId } });
  if (!shift) throw notFound();
  const d = date ? toDateOnly(date) : a.date;
  const window = engine.shiftWindow(shift, d, ctx.tz);
  return prisma.$transaction(async (tx) => {
    const problem = await checkAssignment(tx, ctx, { employee: a.employee, shift, date: d, window, branchId: a.branchId, ignoreAssignmentIds: [a.id] });
    if (problem) throw conflict(problem.code, problem.params);
    const updated = await tx.shiftAssignment.update({ where: { id }, data: { shiftId: shift.id, date: d, startAt: window.start, endAt: window.end, notes: notes ?? a.notes } });
    await audit.record(ctx, { action: 'SHIFT_CHANGED', entityType: 'ShiftAssignment', entityId: id, employeeId: a.employeeId, before: a, after: updated, reason }, tx);
    await notify({ companyId: ctx.companyId, userIds: [await userForEmployee(a.employeeId, tx)], type: 'SHIFT_CHANGED', params: { shift: shift.nameEn, from: fmtDate(d), to: fmtDate(d) }, link: '/shifts/my' }, tx);
    return updated;
  });
};

const cancelAssignment = async (ctx, id, reason) => {
  const a = await prisma.shiftAssignment.findFirst({ where: { id, companyId: ctx.companyId, status: 'SCHEDULED' } });
  if (!a) throw notFound();
  await assertEmployeeAccess(ctx, a.employeeId, 'shifts.edit');
  await prisma.shiftAssignment.update({ where: { id }, data: { status: 'CANCELLED', notes: reason || a.notes } });
  await audit.record(ctx, { action: 'SHIFT_CANCELLED', entityType: 'ShiftAssignment', entityId: id, employeeId: a.employeeId, before: a, reason });
  await notify({ companyId: ctx.companyId, userIds: [await userForEmployee(a.employeeId)], type: 'SHIFT_CHANGED', params: { from: fmtDate(a.date), to: fmtDate(a.date), cancelled: true }, link: '/shifts/my' });
};

const schedule = async (ctx, q) => {
  const from = toDateOnly(q.from);
  const to = toDateOnly(q.to);
  const empFilter = { AND: [await employeeWhere(ctx, 'shifts.view'), { deletedAt: null, status: { notIn: ['TERMINATED', 'RESIGNED', 'INACTIVE'] } }] };
  if (q.branchId) empFilter.AND.push({ branchId: q.branchId });
  if (q.departmentId) empFilter.AND.push({ departmentId: q.departmentId });
  if (q.employeeId) empFilter.AND.push({ id: q.employeeId });
  const employees = await prisma.employee.findMany({ where: empFilter, select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true, branchId: true, departmentId: true, position: { select: { titleAr: true, titleEn: true } } }, orderBy: { firstName: 'asc' }, take: 500 });
  const ids = employees.map((e) => e.id);
  const [assignments, leaves, holidays, coverage] = await Promise.all([
    prisma.shiftAssignment.findMany({ where: { companyId: ctx.companyId, employeeId: { in: ids }, status: 'SCHEDULED', date: { gte: from, lte: to } }, include: { shift: { select: { id: true, code: true, nameAr: true, nameEn: true, startTime: true, endTime: true, color: true, expectedMinutes: true } } } }),
    prisma.leaveRequest.findMany({ where: { companyId: ctx.companyId, employeeId: { in: ids }, status: { in: ['APPROVED', 'PENDING_MANAGER', 'PENDING_HR', 'SUBMITTED'] }, startDate: { lte: to }, endDate: { gte: from } }, include: { leaveType: { select: { nameAr: true, nameEn: true, color: true } } } }),
    prisma.holiday.findMany({ where: { companyId: ctx.companyId, date: { gte: from, lte: to } } }),
    coverageReport(ctx, { from: q.from, to: q.to, branchId: q.branchId }),
  ]);
  return { from: fmtDate(from), to: fmtDate(to), employees, assignments, leaves, holidays, coverage: coverage.items.filter((c) => c.shortage > 0) };
};

// Required vs scheduled headcount per branch / shift / day
const coverageReport = async (ctx, { from, to, branchId }) => {
  const reqs = await prisma.shiftCoverageRequirement.findMany({ where: { companyId: ctx.companyId, ...(branchId ? { branchId } : {}) }, include: { shift: true } });
  if (!reqs.length) return { items: [] };
  const days = eachDay(from, to);
  const counts = await prisma.shiftAssignment.groupBy({ by: ['branchId', 'shiftId', 'date'], where: { companyId: ctx.companyId, status: 'SCHEDULED', date: { gte: toDateOnly(from), lte: toDateOnly(to) } }, _count: true });
  const branches = await prisma.branch.findMany({ where: { companyId: ctx.companyId }, select: { id: true, nameAr: true, nameEn: true } });
  const items = [];
  for (const day of days) {
    for (const r of reqs) {
      if (r.dayOfWeek != null && r.dayOfWeek !== weekday(day)) continue;
      if (!(r.shift.workingDays || []).includes(weekday(day))) continue;
      const scheduled = counts.find((c) => c.branchId === r.branchId && c.shiftId === r.shiftId && fmtDate(c.date) === fmtDate(day))?._count || 0;
      const br = branches.find((b) => b.id === r.branchId);
      items.push({ date: fmtDate(day), branchId: r.branchId, branch: br, shiftId: r.shiftId, shift: { code: r.shift.code, nameAr: r.shift.nameAr, nameEn: r.shift.nameEn }, required: r.minEmployees, scheduled, shortage: Math.max(0, r.minEmployees - scheduled) });
    }
  }
  return { items };
};

// Rotation: pattern = [{ shiftId | null }, …] applied block by block (block = blockDays days) starting at rotation.startDate
const applyRotation = async (ctx, rotationId, { employeeIds, from, to }) => {
  const rot = await prisma.shiftRotation.findFirst({ where: { id: rotationId, companyId: ctx.companyId } });
  if (!rot) throw notFound();
  const pattern = rot.pattern || [];
  if (!pattern.length) throw badRequest('VALIDATION_FAILED');
  const days = eachDay(from, to);
  let created = 0;
  const skipped = [];
  for (const day of days) {
    const elapsed = dayjs(day).diff(dayjs(rot.startDate), 'day');
    if (elapsed < 0) continue;
    const block = rot.type === 'MONTHLY' ? dayjs(day).diff(dayjs(rot.startDate), 'month') : Math.floor(elapsed / rot.blockDays);
    const shiftId = pattern[block % pattern.length]?.shiftId;
    if (!shiftId) continue;
    const res = await assign(ctx, { employeeIds, shiftId, from: fmtDate(day), to: fmtDate(day), source: 'ROTATION' });
    created += res.created;
    skipped.push(...res.skipped);
  }
  return { created, skipped };
};

// ── Shift exchange (employee ↔ replacement, then approval) ──
const requestExchange = async (ctx, body) => {
  if (!ctx.employeeId) throw badRequest('EMPLOYEE_NOT_FOUND');
  const mine = await prisma.shiftAssignment.findFirst({ where: { id: body.requesterAssignmentId, companyId: ctx.companyId, employeeId: ctx.employeeId, status: 'SCHEDULED' }, include: { shift: true } });
  if (!mine) throw notFound();
  const replacement = await prisma.employee.findFirst({ where: { id: body.replacementId, companyId: ctx.companyId, deletedAt: null } });
  if (!replacement || replacement.id === ctx.employeeId) throw badRequest('INVALID_REFERENCE', { field: 'replacementId' });
  if (replacement.branchId !== mine.branchId && mine.branchId) throw badRequest('EMPLOYEE_WRONG_BRANCH');
  let theirs = null;
  if (body.replacementAssignmentId) {
    theirs = await prisma.shiftAssignment.findFirst({ where: { id: body.replacementAssignmentId, companyId: ctx.companyId, employeeId: replacement.id, status: 'SCHEDULED' } });
    if (!theirs) throw notFound();
  }
  const req = await prisma.shiftExchangeRequest.create({
    data: { companyId: ctx.companyId, requesterId: ctx.employeeId, replacementId: replacement.id, requesterAssignmentId: mine.id, replacementAssignmentId: theirs?.id || null, date: mine.date, reason: body.reason || null },
  });
  await audit.record(ctx, { action: 'SHIFT_EXCHANGE_REQUESTED', entityType: 'ShiftExchangeRequest', entityId: req.id, employeeId: ctx.employeeId, after: req });
  await notify({ companyId: ctx.companyId, userIds: [await userForEmployee(replacement.id)], type: 'SHIFT_EXCHANGE_REQUESTED', params: { date: fmtDate(mine.date) }, link: '/shifts/exchanges' });
  return req;
};

const respondExchange = async (ctx, id, accept) => {
  const req = await prisma.shiftExchangeRequest.findFirst({ where: { id, companyId: ctx.companyId, status: 'PENDING', replacementConsent: 'PENDING' } });
  if (!req) throw notFound();
  if (req.replacementId !== ctx.employeeId) throw forbidden('NOT_YOUR_APPROVAL');
  return prisma.$transaction(async (tx) => {
    if (!accept) {
      return tx.shiftExchangeRequest.update({ where: { id }, data: { replacementConsent: 'DECLINED', status: 'REJECTED' } });
    }
    await tx.shiftExchangeRequest.update({ where: { id }, data: { replacementConsent: 'ACCEPTED' } });
    const res = await approvals.start(tx, ctx, { entityType: 'SHIFT_EXCHANGE', entityId: id, requesterEmployeeId: req.requesterId, summary: `Shift exchange ${fmtDate(req.date)}` });
    return tx.shiftExchangeRequest.update({ where: { id }, data: { approvalInstanceId: res.instance.id } });
  });
};

approvals.registerHandler('SHIFT_EXCHANGE', {
  onApproved: async (tx, inst, ctx) => {
    const req = await tx.shiftExchangeRequest.findUnique({ where: { id: inst.entityId } });
    const mine = await tx.shiftAssignment.findUnique({ where: { id: req.requesterAssignmentId }, include: { shift: true } });
    const theirs = req.replacementAssignmentId ? await tx.shiftAssignment.findUnique({ where: { id: req.replacementAssignmentId }, include: { shift: true } }) : null;
    const [requester, replacement] = await Promise.all([tx.employee.findUnique({ where: { id: req.requesterId } }), tx.employee.findUnique({ where: { id: req.replacementId } })]);
    const ignore = [mine.id, theirs?.id].filter(Boolean);
    const p1 = await checkAssignment(tx, ctx, { employee: replacement, shift: mine.shift, date: mine.date, window: { start: mine.startAt, end: mine.endAt }, ignoreAssignmentIds: ignore });
    if (p1) throw conflict(p1.code, p1.params);
    if (theirs) {
      const p2 = await checkAssignment(tx, ctx, { employee: requester, shift: theirs.shift, date: theirs.date, window: { start: theirs.startAt, end: theirs.endAt }, ignoreAssignmentIds: ignore });
      if (p2) throw conflict(p2.code, p2.params);
      await tx.shiftAssignment.update({ where: { id: theirs.id }, data: { employeeId: requester.id, source: 'EXCHANGE' } });
    }
    await tx.shiftAssignment.update({ where: { id: mine.id }, data: { employeeId: replacement.id, source: 'EXCHANGE' } });
    await tx.shiftExchangeRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    await audit.record(ctx, { action: 'SHIFT_EXCHANGED', entityType: 'ShiftExchangeRequest', entityId: req.id, employeeId: req.requesterId, newValue: { requester: req.requesterId, replacement: req.replacementId } }, tx);
  },
  onRejected: async (tx, inst) => {
    await tx.shiftExchangeRequest.update({ where: { id: inst.entityId }, data: { status: 'REJECTED' } });
  },
});

module.exports = { assign, copyWeek, updateAssignment, cancelAssignment, schedule, coverageReport, applyRotation, requestExchange, respondExchange, checkAssignment, getSetting };
