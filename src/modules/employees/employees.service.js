const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const { parsePaging, parseSort, paged } = require('../../utils/pagination');
const { nextSequence, formatNumber, assertSameCompany, empName, maskIban } = require('../../services/common');
const { employeeWhere, assertEmployeeAccess, scopeOf } = require('../../services/scope');
const { hasPermission } = require('../../middleware/auth');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');

const DATE_FIELDS = ['dateOfBirth', 'passportExpiry', 'hireDate', 'probationStart', 'probationEnd', 'contractStart', 'contractEnd', 'terminationDate'];
const FINANCIAL_FIELDS = ['paymentFrequency', 'paymentMethod', 'bankName', 'iban', 'accountHolder', 'gosiApplicable', 'gosiNumber', 'salaryStructureId'];
const SENSITIVE_IDS = ['nationalId', 'passportNumber'];
const TRACKED = {
  branchId: 'TRANSFER_BRANCH', departmentId: 'CHANGE_DEPARTMENT', sectionId: 'CHANGE_DEPARTMENT', teamId: 'CHANGE_TEAM', managerId: 'CHANGE_MANAGER',
  positionId: 'CHANGE_POSITION', gradeId: 'CHANGE_POSITION', status: 'CHANGE_STATUS', contractType: 'CHANGE_CONTRACT', contractEnd: 'CHANGE_CONTRACT', employmentType: 'CHANGE_CONTRACT',
};

const listInclude = {
  branch: { select: { id: true, nameAr: true, nameEn: true } },
  department: { select: { id: true, nameAr: true, nameEn: true } },
  position: { select: { id: true, titleAr: true, titleEn: true } },
  manager: { select: { id: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } },
};

const normalizeDates = (data) => {
  for (const f of DATE_FIELDS) if (f in data) data[f] = data[f] ? toDateOnly(data[f]) : null;
  return data;
};

// Strip financial/sensitive data the caller may not see
const present = (ctx, emp) => {
  if (!emp) return emp;
  const out = { ...emp };
  delete out.kioskPinHash;
  const self = ctx.employeeId === emp.id;
  if (!hasPermission(ctx, 'employees.financial') && !self) {
    for (const f of FINANCIAL_FIELDS) delete out[f];
  } else if (!hasPermission(ctx, 'employees.financial') && self) {
    out.iban = maskIban(out.iban);
  }
  if (!self && scopeOf(ctx, 'employees.edit') === 0 && !hasPermission(ctx, 'employees.documents')) {
    for (const f of SENSITIVE_IDS) if (out[f]) out[f] = `****${String(out[f]).slice(-4)}`;
  }
  return out;
};

const buildListWhere = async (ctx, q) => {
  const and = [await employeeWhere(ctx, 'employees.view'), { deletedAt: null }];
  if (q.includeArchived !== 'true') and.push({ archivedAt: null });
  if (q.search) {
    const s = q.search.trim();
    and.push({ OR: [
      { firstName: { contains: s } }, { lastName: { contains: s } }, { fullNameAr: { contains: s } }, { fullNameEn: { contains: s } },
      { employeeNumber: { contains: s } }, { nationalId: { contains: s } }, { mobile: { contains: s } }, { email: { contains: s } },
    ] });
  }
  for (const key of ['branchId', 'departmentId', 'positionId', 'status', 'contractType', 'employmentType', 'managerId', 'teamId']) {
    if (q[key]) and.push({ [key]: q[key].includes(',') ? { in: q[key].split(',') } : q[key] });
  }
  if (q.contractExpiringDays) {
    and.push({ contractEnd: { gte: toDateOnly(new Date()), lte: dayjs().add(Number(q.contractExpiringDays), 'day').toDate() } });
  }
  return { AND: and };
};

const list = async (ctx, q) => {
  const where = await buildListWhere(ctx, q);
  const orderBy = parseSort(q.sort, ['employeeNumber', 'firstName', 'hireDate', 'contractEnd', 'status', 'createdAt'], { employeeNumber: 'asc' });
  if (q.format && q.format !== 'json') {
    const rows = await prisma.employee.findMany({ where, orderBy, include: listInclude, take: 20000 });
    return { rows: rows.map((r) => present(ctx, r)) };
  }
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.employee.findMany({ where, orderBy, include: listInclude, skip: paging.skip, take: paging.take }),
    prisma.employee.count({ where }),
  ]);
  return paged(items.map((r) => present(ctx, r)), total, paging);
};

const assertNoManagerCycle = async (companyId, employeeId, managerId) => {
  if (!managerId) return;
  if (managerId === employeeId) throw badRequest('MANAGER_CYCLE');
  let cur = managerId;
  const seen = new Set();
  while (cur) {
    if (cur === employeeId || seen.has(cur)) throw badRequest('MANAGER_CYCLE');
    seen.add(cur);
    const m = await prisma.employee.findFirst({ where: { id: cur, companyId }, select: { managerId: true } });
    cur = m?.managerId;
  }
};

const create = async (ctx, body) => {
  const { emergencyContact, salary, ...data } = body;
  if (!hasPermission(ctx, 'employees.financial')) {
    for (const f of FINANCIAL_FIELDS) delete data[f];
  }
  normalizeDates(data);
  await assertSameCompany(ctx.companyId, {
    branchId: data.branchId, departmentId: data.departmentId, sectionId: data.sectionId, teamId: data.teamId, positionId: data.positionId,
    gradeId: data.gradeId, managerId: data.managerId, defaultShiftId: data.defaultShiftId, attendancePolicyId: data.attendancePolicyId, salaryStructureId: data.salaryStructureId,
  });
  if (salary?.lines?.length) {
    if (!hasPermission(ctx, 'employees.financial')) throw forbidden('PERMISSION_DENIED', { permission: 'employees.financial' });
    await assertSameCompany(ctx.companyId, { componentId: salary.lines.map((l) => l.componentId) });
  }

  const emp = await prisma.$transaction(async (tx) => {
    let employeeNumber = data.employeeNumber;
    if (!employeeNumber) employeeNumber = formatNumber('EMP', await nextSequence(tx, ctx.companyId, 'employee'), 4);
    const exists = await tx.employee.findFirst({ where: { companyId: ctx.companyId, employeeNumber } });
    if (exists) throw conflict('EMPLOYEE_NUMBER_EXISTS');
    const created = await tx.employee.create({
      data: {
        ...data, employeeNumber, companyId: ctx.companyId,
        fullNameEn: data.fullNameEn || [data.firstName, data.middleName, data.lastName].filter(Boolean).join(' '),
        status: data.status || (data.probationEnd && data.probationEnd > new Date() ? 'PROBATION' : 'ACTIVE'),
      },
    });
    if (emergencyContact) await tx.employeeEmergencyContact.create({ data: { ...emergencyContact, companyId: ctx.companyId, employeeId: created.id } });
    if (salary?.lines?.length) {
      await tx.employeeSalaryRevision.create({
        data: {
          companyId: ctx.companyId, employeeId: created.id, effectiveFrom: toDateOnly(salary.effectiveFrom || data.hireDate), reason: 'Initial salary', status: 'ACTIVE', createdById: ctx.userId,
          lines: { create: salary.lines.map((l) => ({ componentId: l.componentId, amount: l.amount })) },
        },
      });
    }
    await tx.employeeEmploymentHistory.create({
      data: { companyId: ctx.companyId, employeeId: created.id, changeType: 'HIRE', field: 'hireDate', newValue: fmtDate(created.hireDate), effectiveDate: created.hireDate, changedById: ctx.userId },
    });
    await audit.record(ctx, { action: 'CREATE', entityType: 'Employee', entityId: created.id, employeeId: created.id, after: created }, tx);
    return created;
  });
  return emp;
};

const labelFor = async (field, id) => {
  if (!id) return null;
  const map = { branchId: 'branch', departmentId: 'department', sectionId: 'department', teamId: 'team', positionId: 'jobPosition', gradeId: 'jobGrade' };
  if (field === 'managerId') {
    const e = await prisma.employee.findUnique({ where: { id }, select: { firstName: true, lastName: true, fullNameEn: true } });
    return e ? empName(e) : null;
  }
  if (!map[field]) return String(id);
  const row = await prisma[map[field]].findUnique({ where: { id } });
  return row?.nameEn || row?.titleEn || row?.name || null;
};

// Writes employment-history rows for tracked field changes
const trackChanges = async (tx, ctx, before, data, { effectiveDate, reason }) => {
  for (const [field, changeType] of Object.entries(TRACKED)) {
    if (!(field in data)) continue;
    const oldV = before[field] instanceof Date ? fmtDate(before[field]) : before[field];
    const newV = data[field] instanceof Date ? fmtDate(data[field]) : data[field];
    if ((oldV ?? null) === (newV ?? null)) continue;
    await tx.employeeEmploymentHistory.create({
      data: {
        companyId: ctx.companyId, employeeId: before.id, changeType, field, oldValue: oldV ?? null, newValue: newV ?? null,
        oldLabel: await labelFor(field, oldV), newLabel: await labelFor(field, newV),
        effectiveDate: toDateOnly(effectiveDate || new Date()), reason: reason || null, changedById: ctx.userId,
      },
    });
  }
};

const update = async (ctx, id, body) => {
  const before = await prisma.employee.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } });
  if (!before) throw notFound('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, id, 'employees.edit');
  const { reason, ...data } = body;
  if (!hasPermission(ctx, 'employees.financial')) for (const f of FINANCIAL_FIELDS) delete data[f];
  // status changes go through dedicated actions so their side effects run
  delete data.status;
  normalizeDates(data);
  if (data.employeeNumber && data.employeeNumber !== before.employeeNumber) {
    const exists = await prisma.employee.findFirst({ where: { companyId: ctx.companyId, employeeNumber: data.employeeNumber, NOT: { id } } });
    if (exists) throw conflict('EMPLOYEE_NUMBER_EXISTS');
  }
  await assertSameCompany(ctx.companyId, {
    branchId: data.branchId, departmentId: data.departmentId, sectionId: data.sectionId, teamId: data.teamId, positionId: data.positionId,
    gradeId: data.gradeId, managerId: data.managerId, defaultShiftId: data.defaultShiftId, attendancePolicyId: data.attendancePolicyId, salaryStructureId: data.salaryStructureId,
  });
  await assertNoManagerCycle(ctx.companyId, id, data.managerId);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.employee.update({ where: { id }, data });
    await trackChanges(tx, ctx, before, data, { effectiveDate: new Date(), reason });
    await audit.record(ctx, { action: 'UPDATE', entityType: 'Employee', entityId: id, employeeId: id, before, after: updated, reason }, tx);
    return updated;
  });
};

const transfer = async (ctx, id, body) => {
  const before = await prisma.employee.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } });
  if (!before) throw notFound('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, id, 'employees.edit');
  const { effectiveDate, reason, ...refs } = body;
  const data = Object.fromEntries(Object.entries(refs).filter(([, v]) => v !== undefined));
  await assertSameCompany(ctx.companyId, data);
  await assertNoManagerCycle(ctx.companyId, id, data.managerId);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.employee.update({ where: { id }, data });
    await trackChanges(tx, ctx, before, data, { effectiveDate, reason });
    const action = data.branchId && data.branchId !== before.branchId ? 'TRANSFER_EMPLOYEE' : data.managerId ? 'CHANGE_MANAGER' : data.positionId ? 'CHANGE_POSITION' : 'CHANGE_DEPARTMENT';
    await audit.record(ctx, { action, entityType: 'Employee', entityId: id, employeeId: id, before, after: updated, reason }, tx);
    return updated;
  });
};

const STATUS_ACTIONS = {
  suspend: { from: ['ACTIVE', 'PROBATION', 'ON_LEAVE'], to: 'SUSPENDED' },
  reactivate: { from: ['SUSPENDED', 'INACTIVE', 'PROBATION'], to: 'ACTIVE' },
  resign: { from: ['ACTIVE', 'PROBATION', 'SUSPENDED', 'ON_LEAVE'], to: 'RESIGNED' },
  terminate: { from: ['ACTIVE', 'PROBATION', 'SUSPENDED', 'ON_LEAVE'], to: 'TERMINATED' },
  archive: { from: ['RESIGNED', 'TERMINATED', 'INACTIVE'], to: 'INACTIVE' },
};

const changeStatus = async (ctx, id, action, { effectiveDate, reason }) => {
  const rule = STATUS_ACTIONS[action];
  const before = await prisma.employee.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } });
  if (!before) throw notFound('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, id, 'employees.edit');
  if (!rule.from.includes(before.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: before.status, to: rule.to });
  return prisma.$transaction(async (tx) => {
    const data = { status: rule.to };
    if (['resign', 'terminate'].includes(action)) data.terminationDate = toDateOnly(effectiveDate);
    if (action === 'archive') data.archivedAt = new Date();
    if (action === 'reactivate') { data.terminationDate = null; data.archivedAt = null; }
    const updated = await tx.employee.update({ where: { id }, data });
    // Disable/enable login together with employment status
    if (['resign', 'terminate', 'archive', 'suspend'].includes(action)) await tx.user.updateMany({ where: { employeeId: id }, data: { status: 'DISABLED' } });
    if (action === 'reactivate') await tx.user.updateMany({ where: { employeeId: id }, data: { status: 'ACTIVE' } });
    if (action === 'resign' || action === 'terminate') {
      await tx.refreshToken.updateMany({ where: { user: { employeeId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
      // Settlement draft: collects outstanding advances/loans for HR/Finance review before financial closure
      const { createSettlementDraft } = require('../loans/settlement.service');
      await createSettlementDraft(tx, ctx, updated, reason);
    }
    await trackChanges(tx, ctx, before, { status: rule.to }, { effectiveDate, reason });
    await audit.record(ctx, { action: `EMPLOYEE_${action.toUpperCase()}`, entityType: 'Employee', entityId: id, employeeId: id, before, after: updated, reason }, tx);
    return updated;
  });
};

const remove = async (ctx, id) => {
  const emp = await prisma.employee.findFirst({ where: { id, companyId: ctx.companyId, deletedAt: null } });
  if (!emp) throw notFound('EMPLOYEE_NOT_FOUND');
  const [runs, ledger, comm, adv, loans] = await Promise.all([
    prisma.payrollRunEmployee.count({ where: { employeeId: id } }),
    prisma.financialLedgerEntry.count({ where: { employeeId: id } }),
    prisma.commissionTransaction.count({ where: { employeeId: id } }),
    prisma.employeeAdvance.count({ where: { employeeId: id } }),
    prisma.employeeLoan.count({ where: { employeeId: id } }),
  ]);
  if (runs + ledger + comm + adv + loans > 0) throw conflict('EMPLOYEE_HAS_FINANCIAL_HISTORY');
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
    await tx.user.updateMany({ where: { employeeId: id }, data: { status: 'DISABLED' } });
    await audit.record(ctx, { action: 'DELETE', entityType: 'Employee', entityId: id, employeeId: id, before: emp }, tx);
  });
};

// ── Salary ──
const currentRevision = async (employeeId, at = new Date()) =>
  prisma.employeeSalaryRevision.findFirst({
    where: { employeeId, status: 'ACTIVE', effectiveFrom: { lte: toDateOnly(at) } },
    orderBy: { effectiveFrom: 'desc' },
    include: { lines: { include: { component: { select: { id: true, code: true, nameAr: true, nameEn: true, type: true, category: true } } } } },
  });

const salaryHistory = async (ctx, id) => {
  await assertEmployeeAccess(ctx, id, 'employees.view');
  if (!hasPermission(ctx, 'employees.financial') && ctx.employeeId !== id) throw forbidden('PERMISSION_DENIED', { permission: 'employees.financial' });
  const revisions = await prisma.employeeSalaryRevision.findMany({
    where: { employeeId: id, companyId: ctx.companyId }, orderBy: { effectiveFrom: 'desc' },
    include: { lines: { include: { component: { select: { code: true, nameAr: true, nameEn: true, type: true, category: true } } } } },
  });
  const current = await currentRevision(id);
  return { current, revisions: revisions.map((r) => ({ ...r, total: sum(r.lines.filter((l) => l.component.type === 'EARNING'), (l) => l.amount).toFixed(2) })) };
};

// Salary changes are effective-dated and go through the SALARY_CHANGE approval workflow; locked payroll runs are untouched.
const requestSalaryChange = async (ctx, id, body) => {
  await assertEmployeeAccess(ctx, id, 'employees.edit');
  await assertSameCompany(ctx.companyId, { componentId: body.lines.map((l) => l.componentId) });
  const emp = await prisma.employee.findFirst({ where: { id, companyId: ctx.companyId } });
  const effectiveFrom = toDateOnly(body.effectiveFrom);
  const dup = await prisma.employeeSalaryRevision.findFirst({ where: { employeeId: id, effectiveFrom, status: { in: ['ACTIVE', 'PENDING'] } } });
  if (dup) throw conflict('DUPLICATE_VALUE', { field: 'effectiveFrom' });
  return prisma.$transaction(async (tx) => {
    const rev = await tx.employeeSalaryRevision.create({
      data: {
        companyId: ctx.companyId, employeeId: id, effectiveFrom, reason: body.reason, status: 'PENDING', createdById: ctx.userId,
        lines: { create: body.lines.map((l) => ({ componentId: l.componentId, amount: l.amount })) },
      },
    });
    const total = sum(body.lines, (l) => l.amount);
    const res = await approvals.start(tx, ctx, { entityType: 'SALARY_CHANGE', entityId: rev.id, requesterEmployeeId: id, requesterUserId: ctx.userId, amount: total.toFixed(2), summary: `${empName(emp)} — ${fmtDate(effectiveFrom)}` });
    await audit.record(ctx, { action: 'SALARY_CHANGE_REQUESTED', entityType: 'EmployeeSalaryRevision', entityId: rev.id, employeeId: id, newValue: { effectiveFrom: body.effectiveFrom, lines: body.lines }, reason: body.reason }, tx);
    return { ...rev, status: res.completed ? 'ACTIVE' : 'PENDING' };
  });
};

approvals.registerHandler('SALARY_CHANGE', {
  onApproved: async (tx, inst, ctx) => {
    const rev = await tx.employeeSalaryRevision.update({ where: { id: inst.entityId }, data: { status: 'ACTIVE' } });
    await audit.record(ctx, { action: 'SALARY_CHANGED', entityType: 'EmployeeSalaryRevision', entityId: rev.id, employeeId: rev.employeeId, newValue: { status: 'ACTIVE' } }, tx);
  },
  onRejected: async (tx, inst) => {
    await tx.employeeSalaryRevision.update({ where: { id: inst.entityId }, data: { status: 'REJECTED' } });
  },
});

// ── Profile & overview ──
const get = async (ctx, id) => {
  await assertEmployeeAccess(ctx, id, 'employees.view');
  const emp = await prisma.employee.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      ...listInclude,
      section: { select: { id: true, nameAr: true, nameEn: true } }, team: { select: { id: true, nameAr: true, nameEn: true } },
      grade: { select: { id: true, name: true, code: true } }, defaultShift: { select: { id: true, nameAr: true, nameEn: true, startTime: true, endTime: true } },
      attendancePolicy: { select: { id: true, name: true } }, salaryStructure: { select: { id: true, name: true } },
      emergencyContacts: true, user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
    },
  });
  return present(ctx, emp);
};

const overview = async (ctx, id) => {
  await assertEmployeeAccess(ctx, id, 'employees.view');
  const from = toDateOnly(dayjs().subtract(30, 'day').toDate());
  const year = new Date().getUTCFullYear();
  const canFin = hasPermission(ctx, 'employees.financial') || ctx.employeeId === id;
  const [records, balance, commission, pendingLeaves, pendingCorrections, pendingAdv, pendingLoans, rev] = await Promise.all([
    prisma.attendanceRecord.groupBy({ by: ['status'], where: { employeeId: id, date: { gte: from } }, _count: true }),
    prisma.leaveBalance.findMany({ where: { employeeId: id, year, leaveType: { category: 'ANNUAL' } } }),
    prisma.commissionTransaction.aggregate({ where: { employeeId: id, status: { notIn: ['CANCELLED', 'REVERSED'] } }, _sum: { netAmount: true } }),
    prisma.leaveRequest.count({ where: { employeeId: id, status: { in: ['SUBMITTED', 'PENDING_MANAGER', 'PENDING_HR', 'CANCELLATION_PENDING'] } } }),
    prisma.attendanceCorrection.count({ where: { employeeId: id, status: 'PENDING' } }),
    prisma.employeeAdvance.count({ where: { employeeId: id, status: 'PENDING' } }),
    prisma.employeeLoan.count({ where: { employeeId: id, status: 'PENDING' } }),
    canFin ? currentRevision(id) : null,
  ]);
  const counted = records.reduce((acc, r) => ({ ...acc, [r.status]: r._count }), {});
  const workdays = ['PRESENT', 'LATE', 'ABSENT', 'HALF_DAY', 'INCOMPLETE'].reduce((s, k) => s + (counted[k] || 0), 0);
  const attended = (counted.PRESENT || 0) + (counted.LATE || 0) + (counted.HALF_DAY || 0) * 0.5 + (counted.INCOMPLETE || 0);
  const lb = balance[0];
  const leaveBalance = lb ? D(lb.openingBalance).plus(lb.accrued).plus(lb.adjustments).plus(lb.carriedForward).minus(lb.used).toFixed(2) : null;
  const currentSalary = rev ? sum(rev.lines.filter((l) => l.component.type === 'EARNING'), (l) => l.amount).toFixed(2) : null;
  return {
    attendanceRate: workdays ? Math.round((attended / workdays) * 1000) / 10 : null,
    leaveBalance,
    totalCommission: D(commission._sum.netAmount).toFixed(2),
    currentSalary,
    pendingRequests: pendingLeaves + pendingCorrections + pendingAdv + pendingLoans,
    performanceScore: null, // no performance module yet — shown as "not available" instead of a fabricated number
    serviceDays: dayjs().diff(dayjs((await prisma.employee.findUnique({ where: { id }, select: { hireDate: true } })).hireDate), 'day'),
  };
};

const history = async (ctx, id) => {
  await assertEmployeeAccess(ctx, id, 'employees.view');
  return prisma.employeeEmploymentHistory.findMany({ where: { employeeId: id, companyId: ctx.companyId }, orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }] });
};

const activity = async (ctx, id) => {
  await assertEmployeeAccess(ctx, id, 'employees.view');
  if (ctx.employeeId === id && scopeOf(ctx, 'employees.view') <= 1) {
    // employees see their own log without IPs
    const rows = await prisma.auditLog.findMany({ where: { companyId: ctx.companyId, employeeId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(({ ip, userAgent, ...r }) => r);
  }
  return prisma.auditLog.findMany({ where: { companyId: ctx.companyId, employeeId: id }, orderBy: { createdAt: 'desc' }, take: 500 });
};

const setEmergencyContacts = async (ctx, id, contacts) => {
  await assertEmployeeAccess(ctx, id, 'employees.edit');
  return prisma.$transaction(async (tx) => {
    await tx.employeeEmergencyContact.deleteMany({ where: { employeeId: id } });
    if (contacts.length) await tx.employeeEmergencyContact.createMany({ data: contacts.map((c, i) => ({ ...c, isPrimary: i === 0, companyId: ctx.companyId, employeeId: id })) });
    await audit.record(ctx, { action: 'UPDATE_EMERGENCY_CONTACTS', entityType: 'Employee', entityId: id, employeeId: id, newValue: { count: contacts.length } }, tx);
    return tx.employeeEmergencyContact.findMany({ where: { employeeId: id } });
  });
};

module.exports = {
  list, get, create, update, transfer, changeStatus, remove, overview, history, activity, salaryHistory, requestSalaryChange,
  currentRevision, setEmergencyContacts, present, STATUS_ACTIONS, assertNoManagerCycle,
};
