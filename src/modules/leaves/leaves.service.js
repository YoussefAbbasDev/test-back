const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D } = require('../../utils/money');
const engine = require('../../engines/leave');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const { notify, userForEmployee } = require('../../services/notifications');
const { assertEmployeeAccess } = require('../../services/scope');
const { empName } = require('../../services/common');

const ACTIVE_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING_MANAGER', 'PENDING_HR', 'APPROVED', 'CANCELLATION_PENDING'];

const resolvePolicy = async (employee, leaveTypeId, at, tx = prisma) => {
  const d = toDateOnly(at);
  const policies = await tx.leavePolicy.findMany({
    where: { companyId: employee.companyId, leaveTypeId, status: 'ACTIVE', effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] },
    orderBy: { effectiveFrom: 'desc' },
  });
  return policies.find((p) =>
    (!p.applicableBranchIds?.length || p.applicableBranchIds.includes(employee.branchId))
    && (!p.applicableEmploymentTypes?.length || p.applicableEmploymentTypes.includes(employee.employmentType))) || null;
};

const holidaySet = async (companyId, branchId, start, end, tx = prisma) => {
  const rows = await tx.holiday.findMany({ where: { companyId, date: { gte: toDateOnly(start), lte: toDateOnly(end) }, OR: [{ branchId: null }, { branchId: branchId || undefined }] } });
  return new Set(rows.map((h) => fmtDate(h.date)));
};

const computeDays = async (employee, policy, { startDate, endDate, halfDay }, company, tx = prisma) => engine.countLeaveDays({
  start: startDate, end: endDate, halfDay, weekendDays: company.weekendDays || [], holidays: await holidaySet(employee.companyId, employee.branchId, startDate, endDate, tx),
  countWeekends: policy?.countWeekends ?? false, countHolidays: policy?.countHolidays ?? false,
});

const ensureBalance = async (tx, employee, leaveTypeId, policy, year, ctx) => {
  let bal = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId, year } } });
  if (!bal) {
    bal = await tx.leaveBalance.create({ data: { companyId: employee.companyId, employeeId: employee.id, leaveTypeId, year } });
  }
  if (policy) bal = await syncAccrual(tx, bal, policy, employee, new Date(), ctx);
  return bal;
};

// Brings `accrued` up to the policy's value as of today (idempotent; writes ACCRUAL movements for the delta)
const syncAccrual = async (tx, bal, policy, employee, asOf, ctx) => {
  const target = engine.accruedFor({
    entitlement: policy.annualEntitlement, method: policy.accrualMethod, hireDate: employee.hireDate, year: bal.year,
    asOf, prorateFirstYear: policy.prorateFirstYear, maxBalance: policy.maxBalance,
  });
  const delta = target.minus(bal.accrued);
  if (delta.isZero()) return bal;
  await tx.leaveBalanceTransaction.create({ data: { companyId: bal.companyId, balanceId: bal.id, type: 'ACCRUAL', days: delta.toFixed(2), note: `${policy.accrualMethod} accrual as of ${fmtDate(asOf)}`, createdById: ctx?.userId || null } });
  return tx.leaveBalance.update({ where: { id: bal.id }, data: { accrued: target.toFixed(2) } });
};

const move = async (tx, bal, field, days, type, ref, ctx, note) => {
  await tx.leaveBalanceTransaction.create({ data: { companyId: bal.companyId, balanceId: bal.id, type, days: D(days).toFixed(2), refType: ref?.type || null, refId: ref?.id || null, note: note || null, createdById: ctx?.userId || null } });
  return tx.leaveBalance.update({ where: { id: bal.id }, data: { [field]: D(bal[field]).plus(days).toFixed(2) } });
};

const preview = async (ctx, body) => {
  const employeeId = body.employeeId || ctx.employeeId;
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND');
  const policy = await resolvePolicy(employee, body.leaveTypeId, body.startDate);
  const days = await computeDays(employee, policy, body, ctx.company);
  const year = toDateOnly(body.startDate).getUTCFullYear();
  const bal = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: body.leaveTypeId, year } } });
  return { days: days.toFixed(2), policy: policy ? { id: policy.id, name: policy.name, requiresBalance: policy.requiresBalance, attachmentRequired: policy.attachmentRequired } : null, available: bal ? engine.availableBalance(bal, policy?.reserveOnPending).toFixed(2) : null };
};

const validateRequest = async (tx, ctx, employee, leaveType, policy, body, days, excludeId) => {
  if (!policy) throw badRequest('NO_LEAVE_POLICY');
  if (days.lessThanOrEqualTo(0)) throw badRequest('LEAVE_ZERO_DAYS');
  if (policy.minRequestDays && days.lessThan(policy.minRequestDays)) throw badRequest('LEAVE_MIN_DAYS', { min: policy.minRequestDays.toString() });
  if (policy.maxRequestDays && days.greaterThan(policy.maxRequestDays)) throw badRequest('LEAVE_MAX_DAYS', { max: policy.maxRequestDays.toString() });
  const needsAttachment = policy.attachmentRequired && (!policy.attachmentAfterDays || days.greaterThan(policy.attachmentAfterDays));
  if (needsAttachment && !body.attachmentId) throw badRequest('ATTACHMENT_REQUIRED');
  if (policy.minServiceMonths && dayjs(body.startDate).diff(dayjs(employee.hireDate), 'month') < policy.minServiceMonths) throw badRequest('NOT_ELIGIBLE_SERVICE');
  if (policy.genderRestriction && employee.gender && policy.genderRestriction !== employee.gender) throw badRequest('NOT_ELIGIBLE_GENDER');
  const overlap = await tx.leaveRequest.findFirst({
    where: { employeeId: employee.id, status: { in: ACTIVE_STATUSES.filter((s) => s !== 'DRAFT') }, startDate: { lte: toDateOnly(body.endDate) }, endDate: { gte: toDateOnly(body.startDate) }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (overlap) throw conflict('LEAVE_OVERLAP');
};

const checkBalance = (bal, policy, days) => {
  if (!policy.requiresBalance || policy.allowNegativeBalance) return;
  const available = engine.availableBalance(bal, policy.reserveOnPending);
  if (available.lessThan(days)) throw badRequest('INSUFFICIENT_BALANCE', { available: available.toFixed(2), requested: days.toFixed(2) });
};

const submitWithin = async (tx, ctx, request, employee, policy, days) => {
  const year = request.startDate.getUTCFullYear();
  let bal = await ensureBalance(tx, employee, request.leaveTypeId, policy, year, ctx);
  checkBalance(bal, policy, days);
  if (policy.reserveOnPending || policy.requiresBalance) bal = await move(tx, bal, 'pending', days, 'RESERVE', { type: 'LeaveRequest', id: request.id }, ctx);
  const res = await approvals.start(tx, ctx, {
    entityType: 'LEAVE', entityId: request.id, requesterEmployeeId: employee.id, leaveTypeId: request.leaveTypeId, workflowId: policy.workflowId || undefined,
    summary: `${empName(employee)} — ${fmtDate(request.startDate)} → ${fmtDate(request.endDate)} (${days.toFixed(1)})`,
    requesterUserId: ctx.employeeId === employee.id ? ctx.userId : undefined,
  });
  return tx.leaveRequest.update({ where: { id: request.id }, data: { approvalInstanceId: res.instance.id, submittedAt: new Date(), ...(res.completed ? {} : { status: res.pendingStatus || 'SUBMITTED' }) } });
};

const create = async (ctx, body) => {
  const employeeId = body.employeeId || ctx.employeeId;
  if (!employeeId) throw badRequest('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, employeeId, employeeId === ctx.employeeId ? 'leaves.view' : 'leaves.create');
  if (employeeId !== ctx.employeeId && !require('../../middleware/auth').hasPermission(ctx, 'leaves.edit')) throw forbidden('PERMISSION_DENIED', { permission: 'leaves.edit' });
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  const leaveType = await prisma.leaveType.findFirst({ where: { id: body.leaveTypeId, companyId: ctx.companyId, status: 'ACTIVE' } });
  if (!leaveType) throw notFound();
  if (body.endDate < body.startDate) throw badRequest('VALIDATION_FAILED');
  if (body.attachmentId) {
    const f = await prisma.fileAttachment.count({ where: { id: body.attachmentId, companyId: ctx.companyId } });
    if (!f) throw badRequest('INVALID_REFERENCE', { field: 'attachmentId' });
  }
  const policy = await resolvePolicy(employee, leaveType.id, body.startDate);
  const days = await computeDays(employee, policy, body, ctx.company);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employee.id} FOR UPDATE`;
    await validateRequest(tx, ctx, employee, leaveType, policy, body, days);
    let request = await tx.leaveRequest.create({
      data: {
        companyId: ctx.companyId, employeeId: employee.id, leaveTypeId: leaveType.id, policyId: policy.id, startDate: toDateOnly(body.startDate), endDate: toDateOnly(body.endDate),
        halfDay: !!body.halfDay, days: days.toFixed(2), reason: body.reason || null, attachmentId: body.attachmentId || null, emergencyContact: body.emergencyContact || null,
        handoverNotes: body.handoverNotes || null, status: body.draft ? 'DRAFT' : 'SUBMITTED', createdById: ctx.userId,
      },
    });
    if (!body.draft) request = await submitWithin(tx, ctx, request, employee, policy, days);
    await audit.record(ctx, { action: body.draft ? 'LEAVE_DRAFTED' : 'LEAVE_REQUESTED', entityType: 'LeaveRequest', entityId: request.id, employeeId: employee.id, after: request }, tx);
    return tx.leaveRequest.findUnique({ where: { id: request.id } });
  });
};

const submitDraft = async (ctx, id) => {
  const request = await prisma.leaveRequest.findFirst({ where: { id, companyId: ctx.companyId, status: 'DRAFT' } });
  if (!request) throw notFound();
  if (request.employeeId !== ctx.employeeId && request.createdById !== ctx.userId) throw forbidden();
  const employee = await prisma.employee.findUnique({ where: { id: request.employeeId } });
  const policy = await resolvePolicy(employee, request.leaveTypeId, request.startDate);
  const days = await computeDays(employee, policy, request, ctx.company);
  return prisma.$transaction(async (tx) => {
    await validateRequest(tx, ctx, employee, null, policy, { ...request, startDate: fmtDate(request.startDate), endDate: fmtDate(request.endDate) }, days, request.id);
    await tx.leaveRequest.update({ where: { id }, data: { days: days.toFixed(2), status: 'SUBMITTED' } });
    const r = await submitWithin(tx, ctx, { ...request, days }, employee, policy, days);
    await audit.record(ctx, { action: 'LEAVE_REQUESTED', entityType: 'LeaveRequest', entityId: id, employeeId: employee.id, after: r }, tx);
    return r;
  });
};

const balanceOf = async (tx, request) => tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year: request.startDate.getUTCFullYear() } } });

approvals.registerHandler('LEAVE', {
  onStep: async (tx, inst, pendingStatus) => {
    await tx.leaveRequest.update({ where: { id: inst.entityId }, data: { status: pendingStatus } });
  },
  onApproved: async (tx, inst, ctx) => {
    const request = await tx.leaveRequest.findUnique({ where: { id: inst.entityId }, include: { leaveType: true, employee: true } });
    let bal = await balanceOf(tx, request);
    if (bal) {
      if (D(bal.pending).greaterThanOrEqualTo(request.days)) bal = await move(tx, bal, 'pending', D(request.days).negated(), 'RELEASE', { type: 'LeaveRequest', id: request.id }, ctx);
      bal = await move(tx, bal, 'used', request.days, 'USAGE', { type: 'LeaveRequest', id: request.id }, ctx);
    }
    await tx.leaveRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
    // absences already recorded inside the leave become ON_LEAVE
    await tx.attendanceRecord.updateMany({ where: { employeeId: request.employeeId, date: { gte: request.startDate, lte: request.endDate }, status: 'ABSENT' }, data: { status: 'ON_LEAVE' } });
    const u = await userForEmployee(request.employeeId, tx);
    await notify({ companyId: request.companyId, userIds: [u], type: 'LEAVE_APPROVED', params: { from: fmtDate(request.startDate), to: fmtDate(request.endDate), type: request.leaveType.nameEn }, link: '/leaves/my' }, tx);
    await audit.record(ctx, { action: 'LEAVE_APPROVED', entityType: 'LeaveRequest', entityId: request.id, employeeId: request.employeeId, newValue: { status: 'APPROVED' } }, tx);
  },
  onRejected: async (tx, inst, ctx, comment) => {
    const request = await tx.leaveRequest.findUnique({ where: { id: inst.entityId }, include: { leaveType: true } });
    const bal = await balanceOf(tx, request);
    if (bal && D(bal.pending).greaterThanOrEqualTo(request.days)) await move(tx, bal, 'pending', D(request.days).negated(), 'RELEASE', { type: 'LeaveRequest', id: request.id }, ctx);
    await tx.leaveRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', decidedAt: new Date() } });
    await notify({ companyId: request.companyId, userIds: [await userForEmployee(request.employeeId, tx)], type: 'LEAVE_REJECTED', params: { from: fmtDate(request.startDate), comment }, link: '/leaves/my' }, tx);
  },
});

// Approved-leave cancellation runs through its own workflow and restores the balance when approved
approvals.registerHandler('LEAVE_CANCELLATION', {
  onApproved: async (tx, inst, ctx) => {
    const request = await tx.leaveRequest.findUnique({ where: { id: inst.entityId } });
    const bal = await balanceOf(tx, request);
    if (bal) await move(tx, bal, 'used', D(request.days).negated(), 'CANCELLATION_RESTORE', { type: 'LeaveRequest', id: request.id }, ctx);
    await tx.leaveRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED', decidedAt: new Date() } });
    await tx.attendanceRecord.deleteMany({ where: { employeeId: request.employeeId, date: { gte: request.startDate, lte: request.endDate }, status: 'ON_LEAVE', firstCheckIn: null } });
    await notify({ companyId: request.companyId, userIds: [await userForEmployee(request.employeeId, tx)], type: 'LEAVE_CANCELLED', params: { from: fmtDate(request.startDate) }, link: '/leaves/my' }, tx);
    await audit.record(ctx, { action: 'LEAVE_CANCELLED', entityType: 'LeaveRequest', entityId: request.id, employeeId: request.employeeId, newValue: { status: 'CANCELLED', restoredDays: request.days.toString() } }, tx);
  },
  onRejected: async (tx, inst) => {
    await tx.leaveRequest.update({ where: { id: inst.entityId }, data: { status: 'APPROVED' } });
  },
});

const withdraw = async (ctx, id) => {
  const request = await prisma.leaveRequest.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!request) throw notFound();
  if (request.employeeId !== ctx.employeeId && request.createdById !== ctx.userId) throw forbidden();
  if (!['DRAFT', 'SUBMITTED', 'PENDING_MANAGER', 'PENDING_HR'].includes(request.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: request.status, to: 'WITHDRAWN' });
  return prisma.$transaction(async (tx) => {
    await approvals.cancel(tx, request.approvalInstanceId, 'WITHDRAWN');
    const bal = await balanceOf(tx, request);
    if (request.status !== 'DRAFT' && bal && D(bal.pending).greaterThanOrEqualTo(request.days)) await move(tx, bal, 'pending', D(request.days).negated(), 'RELEASE', { type: 'LeaveRequest', id: request.id }, ctx, 'Withdrawn');
    const r = await tx.leaveRequest.update({ where: { id }, data: { status: 'WITHDRAWN' } });
    await audit.record(ctx, { action: 'LEAVE_WITHDRAWN', entityType: 'LeaveRequest', entityId: id, employeeId: request.employeeId, before: request, after: r }, tx);
    return r;
  });
};

const requestCancellation = async (ctx, id, reason) => {
  const request = await prisma.leaveRequest.findFirst({ where: { id, companyId: ctx.companyId, status: 'APPROVED' }, include: { policy: true, employee: true } });
  if (!request) throw notFound();
  await assertEmployeeAccess(ctx, request.employeeId, 'leaves.view');
  const started = request.startDate <= toDateOnly(new Date());
  if (started && !request.policy?.allowCancellationAfterStart) throw badRequest('CANCELLATION_NOT_ALLOWED');
  return prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({ where: { id }, data: { status: 'CANCELLATION_PENDING', cancelReason: reason } });
    const res = await approvals.start(tx, ctx, { entityType: 'LEAVE_CANCELLATION', entityId: id, requesterEmployeeId: request.employeeId, summary: `Cancel leave ${empName(request.employee)} ${fmtDate(request.startDate)}` });
    await audit.record(ctx, { action: 'LEAVE_CANCELLATION_REQUESTED', entityType: 'LeaveRequest', entityId: id, employeeId: request.employeeId, reason }, tx);
    return { completed: res.completed };
  });
};

const adjustBalance = async (ctx, { employeeId, leaveTypeId, year, days, reason, type }) => {
  await assertEmployeeAccess(ctx, employeeId, 'leaves.edit');
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  const lt = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, companyId: ctx.companyId } });
  if (!lt) throw notFound();
  return prisma.$transaction(async (tx) => {
    const policy = await resolvePolicy(employee, leaveTypeId, `${year}-12-31`, tx);
    let bal = await ensureBalance(tx, employee, leaveTypeId, policy, year, ctx);
    const field = type === 'OPENING' ? 'openingBalance' : 'adjustments';
    bal = await move(tx, bal, field, D(days), type === 'OPENING' ? 'OPENING' : 'ADJUSTMENT', null, ctx, reason);
    await audit.record(ctx, { action: 'LEAVE_BALANCE_ADJUSTED', entityType: 'LeaveBalance', entityId: bal.id, employeeId, newValue: { days, type, year }, reason }, tx);
    return bal;
  });
};

const balancesFor = async (ctx, employeeId, year) => {
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND');
  const types = await prisma.leaveType.findMany({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, orderBy: { code: 'asc' } });
  const out = [];
  await prisma.$transaction(async (tx) => {
    for (const t of types) {
      const policy = await resolvePolicy(employee, t.id, new Date(Date.UTC(year, 11, 31)) < new Date() ? `${year}-12-31` : new Date(), tx);
      if (!policy) continue;
      const bal = await ensureBalance(tx, employee, t.id, policy, year, ctx);
      out.push({
        leaveType: t, policy: { id: policy.id, name: policy.name, annualEntitlement: policy.annualEntitlement, accrualMethod: policy.accrualMethod, requiresBalance: policy.requiresBalance },
        ...bal, current: engine.currentBalance(bal).toFixed(2), available: engine.availableBalance(bal, policy.reserveOnPending).toFixed(2),
      });
    }
  }, { timeout: 30000 });
  return out;
};

// Year-end carry forward: remaining balance (capped by policy) moves into the next year's carriedForward
const carryForward = async (ctx, fromYear) => {
  const balances = await prisma.leaveBalance.findMany({ where: { companyId: ctx.companyId, year: fromYear }, include: { employee: true } });
  let count = 0;
  for (const bal of balances) {
    const policy = await resolvePolicy(bal.employee, bal.leaveTypeId, `${fromYear}-12-31`);
    if (!policy || policy.carryForwardMax == null) continue;
    const amount = engine.carryForwardAmount(bal, policy.carryForwardMax);
    await prisma.$transaction(async (tx) => {
      let next = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: bal.employeeId, leaveTypeId: bal.leaveTypeId, year: fromYear + 1 } } });
      if (!next) next = await tx.leaveBalance.create({ data: { companyId: bal.companyId, employeeId: bal.employeeId, leaveTypeId: bal.leaveTypeId, year: fromYear + 1 } });
      // idempotent: replace previous carry-forward value
      const delta = amount.minus(next.carriedForward);
      if (!delta.isZero()) await move(tx, next, 'carriedForward', delta, 'CARRY_FORWARD', { type: 'LeaveBalance', id: bal.id }, ctx, `From ${fromYear}`);
    });
    count++;
  }
  await audit.record(ctx, { action: 'LEAVE_CARRY_FORWARD', entityType: 'LeaveBalance', newValue: { fromYear, balances: count } });
  return { processed: count };
};

module.exports = { resolvePolicy, computeDays, preview, create, submitDraft, withdraw, requestCancellation, adjustBalance, balancesFor, carryForward, ensureBalance, holidaySet, ACTIVE_STATUSES };
