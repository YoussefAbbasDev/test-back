const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs, overlapDays } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const engine = require('../../engines/payroll');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const { notify, userForEmployee, usersWithRoles } = require('../../services/notifications');
const { nextSequence, formatNumber, empName, maskIban } = require('../../services/common');
const { countLeaveDays } = require('../../engines/leave');
const leaveService = require('../leaves/leaves.service');

const ACTIVE_RUN = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'LOCKED', 'PAID', 'PARTIALLY_PAID'];
const EDITABLE = ['DRAFT', 'CALCULATED'];

const getSettings = async (companyId, tx = prisma) => {
  let s = await tx.payrollSetting.findUnique({ where: { companyId } });
  if (!s) s = await tx.payrollSetting.create({ data: { companyId } });
  return s;
};

const loadRun = async (ctx, id, tx = prisma) => {
  const run = await tx.payrollRun.findFirst({ where: { id, companyId: ctx.companyId }, include: { period: true } });
  if (!run) throw notFound();
  return run;
};

const createPeriod = async (ctx, { name, startDate, endDate, paymentDate, frequency }) => {
  if (endDate < startDate) throw badRequest('VALIDATION_FAILED');
  const exists = await prisma.payrollPeriod.findFirst({ where: { companyId: ctx.companyId, frequency: frequency || 'MONTHLY', startDate: { lte: toDateOnly(endDate) }, endDate: { gte: toDateOnly(startDate) } } });
  if (exists) throw conflict('PAYROLL_PERIOD_EXISTS');
  const p = await prisma.payrollPeriod.create({ data: { companyId: ctx.companyId, name, frequency: frequency || 'MONTHLY', startDate: toDateOnly(startDate), endDate: toDateOnly(endDate), paymentDate: toDateOnly(paymentDate) } });
  await audit.record(ctx, { action: 'CREATE', entityType: 'PayrollPeriod', entityId: p.id, after: p });
  return p;
};

const createRun = async (ctx, { periodId, branchId, employeeIds, departmentIds, notes, type }) => {
  const period = await prisma.payrollPeriod.findFirst({ where: { id: periodId, companyId: ctx.companyId } });
  if (!period) throw notFound();
  if (period.status === 'CLOSED') throw badRequest('PAYROLL_LOCKED');
  if (branchId && !(await prisma.branch.count({ where: { id: branchId, companyId: ctx.companyId } }))) throw badRequest('INVALID_REFERENCE', { field: 'branchId' });
  if ((type || 'REGULAR') === 'REGULAR') {
    const clash = await prisma.payrollRun.findFirst({ where: { companyId: ctx.companyId, periodId, type: 'REGULAR', status: { in: ACTIVE_RUN }, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) } });
    if (clash) throw conflict('PAYROLL_RUN_EXISTS');
  }
  const settings = await getSettings(ctx.companyId);
  return prisma.$transaction(async (tx) => {
    const n = await nextSequence(tx, ctx.companyId, 'payrollRun');
    const run = await tx.payrollRun.create({
      data: {
        companyId: ctx.companyId, periodId, branchId: branchId || null, runNumber: formatNumber(`PR${dayjs(period.startDate).format('YYYYMM')}`, n, 3), type: type || 'REGULAR',
        employeeFilter: employeeIds?.length || departmentIds?.length ? { employeeIds: employeeIds || null, departmentIds: departmentIds || null } : undefined,
        currency: ctx.currency || 'SAR', notes: notes || null, createdById: ctx.userId,
      },
    });
    await audit.record(ctx, { action: 'PAYROLL_RUN_CREATED', entityType: 'PayrollRun', entityId: run.id, after: run }, tx);
    return { ...run, settingsCurrency: settings.frequency };
  });
};

// Gathers everything engine.calculate needs for one employee
const gatherInput = async (tx, ctx, run, employee, settings, components, reserved) => {
  const start = run.period.startDate;
  const end = run.period.endDate;
  const revisions = await tx.employeeSalaryRevision.findMany({
    where: { employeeId: employee.id, status: 'ACTIVE', effectiveFrom: { lte: end } }, orderBy: { effectiveFrom: 'asc' }, include: { lines: true },
  });
  // keep the last revision before the period plus all inside it
  const before = revisions.filter((r) => r.effectiveFrom <= start);
  const inside = revisions.filter((r) => r.effectiveFrom > start);
  const effective = [...(before.length ? [before[before.length - 1]] : []), ...inside];

  const structureLines = employee.salaryStructureId
    ? await tx.salaryStructureLine.findMany({ where: { structureId: employee.salaryStructureId }, include: { component: true } })
    : [];

  const records = await tx.attendanceRecord.findMany({ where: { employeeId: employee.id, date: { gte: start, lte: end } } });
  const attendance = { presentDays: 0, absentDays: 0, halfDays: 0, lateMinutes: 0, earlyMinutes: 0, workedMinutes: 0, overtime: { WORKDAY: 0, WEEKEND: 0, HOLIDAY: 0 }, pendingOvertimeRecords: 0, incompleteRecords: 0 };
  for (const r of records) {
    if (['PRESENT', 'LATE'].includes(r.status)) attendance.presentDays++;
    if (r.status === 'ABSENT') attendance.absentDays++;
    if (r.status === 'HALF_DAY') { attendance.halfDays++; attendance.presentDays += 0.5; }
    if (r.status === 'INCOMPLETE') { attendance.incompleteRecords++; attendance.presentDays++; }
    attendance.lateMinutes += r.lateMinutes;
    attendance.earlyMinutes += r.earlyLeaveMinutes;
    attendance.workedMinutes += r.workedMinutes;
    if (r.overtimeStatus === 'APPROVED') attendance.overtime[r.dayType] = (attendance.overtime[r.dayType] || 0) + r.overtimeApprovedMinutes;
    if (r.overtimeStatus === 'PENDING') attendance.pendingOvertimeRecords++;
  }

  // approved leaves overlapping the period, counted with the policy calendar, clipped to the period
  const leaveReqs = await tx.leaveRequest.findMany({ where: { employeeId: employee.id, status: { in: ['APPROVED', 'CANCELLATION_PENDING'] }, startDate: { lte: end }, endDate: { gte: start } }, include: { leaveType: true, policy: true } });
  const leaves = [];
  for (const lr of leaveReqs) {
    if (Number(lr.leaveType.payPercent) >= 100 && lr.leaveType.isPaid) continue;
    const s = lr.startDate > start ? lr.startDate : start;
    const e = lr.endDate < end ? lr.endDate : end;
    const days = lr.halfDay ? D(lr.days) : countLeaveDays({
      start: s, end: e, weekendDays: ctx.company.weekendDays || [], holidays: await leaveService.holidaySet(ctx.companyId, employee.branchId, s, e, tx),
      countWeekends: lr.policy?.countWeekends ?? false, countHolidays: lr.policy?.countHolidays ?? false,
    });
    leaves.push({ days, payPercent: lr.leaveType.isPaid ? Number(lr.leaveType.payPercent) : 0, leaveTypeName: lr.leaveType.nameEn });
  }

  const commissionRows = await tx.commissionTransaction.findMany({
    where: {
      employeeId: employee.id, companyId: ctx.companyId, payrollRunId: null, status: { in: ['APPROVED', 'PAYABLE'] }, id: { notIn: reserved.commissions },
      ...(settings.commissionInclusion === 'APPROVED_BY_PERIOD_END' ? { OR: [{ approvedAt: { lte: dayjs(end).endOf('day').toDate() } }, { approvedAt: null }] } : {}),
    },
    include: { rule: { select: { nameEn: true } } },
  });
  const adjustments = await tx.payrollAdjustment.findMany({ where: { employeeId: employee.id, companyId: ctx.companyId, status: 'APPROVED', appliedRunId: null, effectiveDate: { lte: end } } });
  const installments = await tx.installment.findMany({
    where: {
      employeeId: employee.id, companyId: ctx.companyId, dueDate: { lte: end }, status: { in: ['UPCOMING', 'DUE', 'PARTIALLY_PAID', 'OVERDUE'] }, id: { notIn: reserved.installments },
      OR: [{ advance: { status: { in: ['DISBURSED', 'REPAYING'] }, repaymentMethod: 'PAYROLL' } }, { loan: { status: { in: ['DISBURSED', 'REPAYING'] }, repaymentMethod: 'PAYROLL' } }],
    },
    include: { advance: { select: { number: true } }, loan: { select: { number: true } } },
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
  });

  return {
    period: { start, end }, settings, employee, components, structureLines, revisions: effective, attendance, leaves,
    serviceYears: Math.max(0, dayjs(end).diff(dayjs(employee.hireDate), 'month') / 12),
    commissions: commissionRows.map((c) => ({ id: c.id, amount: c.netAmount, label: c.rule?.nameEn || c.entryType })),
    adjustments: adjustments.map((a) => ({ id: a.id, type: a.type, category: a.category, amount: a.amount, reason: a.reason })),
    installments: installments.map((i) => ({ id: i.id, kind: i.loanId ? 'LOAN' : 'ADVANCE', refId: i.loanId || i.advanceId, due: D(i.amount).minus(i.paidAmount), label: `${i.loan?.number || i.advance?.number} #${i.number}` })),
  };
};

const eligibleEmployees = async (tx, ctx, run) => {
  const filter = run.employeeFilter || {};
  return tx.employee.findMany({
    where: {
      companyId: ctx.companyId, deletedAt: null, hireDate: { lte: run.period.endDate },
      OR: [{ terminationDate: null }, { terminationDate: { gte: run.period.startDate } }],
      status: { notIn: ['INACTIVE'] }, paymentFrequency: run.period.frequency,
      ...(run.branchId ? { branchId: run.branchId } : {}),
      ...(filter.employeeIds?.length ? { id: { in: filter.employeeIds } } : {}),
      ...(filter.departmentIds?.length ? { departmentId: { in: filter.departmentIds } } : {}),
    },
    include: { position: true, department: true, branch: true },
    orderBy: { employeeNumber: 'asc' },
  });
};

// Commissions / installments already referenced by another active run cannot be included twice
const reservedSources = async (tx, ctx, runId) => {
  const lines = await tx.payrollLine.findMany({
    where: { sourceType: { in: ['COMMISSION', 'LOAN', 'ADVANCE'] }, runEmployee: { companyId: ctx.companyId, status: 'INCLUDED', runId: { not: runId }, run: { status: { in: ACTIVE_RUN }, type: { not: 'REVERSAL' } } } },
    select: { sourceType: true, sourceId: true },
  });
  return { commissions: lines.filter((l) => l.sourceType === 'COMMISSION').map((l) => l.sourceId), installments: lines.filter((l) => l.sourceType !== 'COMMISSION').map((l) => l.sourceId) };
};

const snapshotOf = (e) => ({
  employeeNumber: e.employeeNumber, nameEn: empName(e, 'en'), nameAr: e.fullNameAr || empName(e, 'en'), titleEn: e.position?.titleEn || null, titleAr: e.position?.titleAr || null,
  departmentEn: e.department?.nameEn || null, departmentAr: e.department?.nameAr || null, branchEn: e.branch?.nameEn || null, branchAr: e.branch?.nameAr || null,
  paymentMethod: e.paymentMethod, bankName: e.bankName, ibanMasked: maskIban(e.iban), iban: e.iban, accountHolder: e.accountHolder || empName(e),
});

const calculate = async (ctx, runId) => {
  const run = await loadRun(ctx, runId);
  if (!EDITABLE.includes(run.status)) throw badRequest('PAYROLL_LOCKED');
  const settings = await getSettings(ctx.companyId);
  const components = await prisma.salaryComponent.findMany({ where: { companyId: ctx.companyId } });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id = ${run.id} FOR UPDATE`;
    const previous = await tx.payrollRunEmployee.findMany({ where: { runId: run.id }, select: { employeeId: true, status: true, excludeReason: true } });
    const keepExcluded = new Map(previous.filter((p) => p.status !== 'INCLUDED').map((p) => [p.employeeId, p]));
    await tx.payrollRunEmployee.deleteMany({ where: { runId: run.id } });
    const reserved = await reservedSources(tx, ctx, run.id);
    const employees = await eligibleEmployees(tx, ctx, run);

    const totals = { basic: D(0), earnings: D(0), deductions: D(0), net: D(0), overtime: D(0), commissions: D(0), count: 0 };
    for (const e of employees) {
      const input = await gatherInput(tx, ctx, run, e, settings, components, reserved);
      const result = engine.calculate(input);
      const excluded = keepExcluded.get(e.id);
      const re = await tx.payrollRunEmployee.create({
        data: {
          companyId: ctx.companyId, runId: run.id, employeeId: e.id, snapshot: snapshotOf(e), status: excluded?.status || 'INCLUDED', excludeReason: excluded?.excludeReason || null,
          periodDays: String(result.stats.periodDays), paidDays: result.stats.paidDays.toFixed(2), absentDays: D(result.stats.absentDays).toFixed(2), unpaidLeaveDays: D(result.stats.unpaidLeaveDays).toFixed(2),
          lateMinutes: result.stats.lateMinutes, overtimeMinutes: result.stats.overtimeMinutes, basicSalary: D(result.stats.basicSalary).toFixed(2),
          grossEarnings: result.gross.toFixed(2), totalDeductions: result.deductions.toFixed(2), netSalary: result.net.toFixed(2),
          warnings: result.warnings.length ? result.warnings : undefined, errors: result.errors.length ? result.errors : undefined,
        },
      });
      if (result.lines.length) {
        await tx.payrollLine.createMany({
          data: result.lines.map((l, i) => ({
            runEmployeeId: re.id, componentId: l.componentId || null, code: l.code, nameAr: l.nameAr, nameEn: l.nameEn, type: l.type, category: l.category,
            quantity: l.quantity != null ? D(l.quantity).toFixed(4) : null, rate: l.rate != null ? D(l.rate).toFixed(4) : null, amount: l.amount.toFixed(2),
            sourceType: l.sourceType, sourceId: l.sourceId || null, meta: l.meta || undefined, sortOrder: l.sortOrder ?? i,
          })),
        });
      }
      if ((excluded?.status || 'INCLUDED') === 'INCLUDED') {
        totals.count++;
        totals.basic = totals.basic.plus(result.stats.basicSalary);
        totals.earnings = totals.earnings.plus(result.gross);
        totals.deductions = totals.deductions.plus(result.deductions);
        totals.net = totals.net.plus(result.net);
        totals.overtime = totals.overtime.plus(sum(result.lines.filter((l) => l.category === 'OVERTIME'), (l) => l.amount));
        totals.commissions = totals.commissions.plus(sum(result.lines.filter((l) => l.category === 'COMMISSION'), (l) => l.amount));
      }
    }
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: 'CALCULATED', calculatedAt: new Date(), employeesCount: totals.count, totalBasic: totals.basic.toFixed(2), totalEarnings: totals.earnings.toFixed(2),
        totalDeductions: totals.deductions.toFixed(2), totalNet: totals.net.toFixed(2), totalOvertime: totals.overtime.toFixed(2), totalCommissions: totals.commissions.toFixed(2),
      },
    });
    await audit.record(ctx, { action: 'PAYROLL_CALCULATED', entityType: 'PayrollRun', entityId: run.id, newValue: { employees: employees.length, net: totals.net.toFixed(2) } }, tx);
    return updated;
  }, { timeout: 180000, maxWait: 10000 });
};

const recomputeTotals = async (tx, runId) => {
  const rows = await tx.payrollRunEmployee.findMany({ where: { runId, status: 'INCLUDED' }, include: { lines: true } });
  const lines = rows.flatMap((r) => r.lines);
  return tx.payrollRun.update({
    where: { id: runId },
    data: {
      employeesCount: rows.length, totalBasic: sum(rows, (r) => r.basicSalary).toFixed(2), totalEarnings: sum(rows, (r) => r.grossEarnings).toFixed(2),
      totalDeductions: sum(rows, (r) => r.totalDeductions).toFixed(2), totalNet: sum(rows, (r) => r.netSalary).toFixed(2),
      totalOvertime: sum(lines.filter((l) => l.category === 'OVERTIME'), (l) => l.amount).toFixed(2), totalCommissions: sum(lines.filter((l) => l.category === 'COMMISSION'), (l) => l.amount).toFixed(2),
    },
  });
};

const setInclusion = async (ctx, runId, runEmployeeId, { status, reason }) => {
  const run = await loadRun(ctx, runId);
  if (!EDITABLE.includes(run.status)) throw badRequest('PAYROLL_LOCKED');
  const re = await prisma.payrollRunEmployee.findFirst({ where: { id: runEmployeeId, runId } });
  if (!re) throw notFound();
  return prisma.$transaction(async (tx) => {
    await tx.payrollRunEmployee.update({ where: { id: re.id }, data: { status, excludeReason: status === 'INCLUDED' ? null : reason } });
    await audit.record(ctx, { action: `PAYROLL_EMPLOYEE_${status}`, entityType: 'PayrollRun', entityId: runId, employeeId: re.employeeId, reason }, tx);
    return recomputeTotals(tx, runId);
  });
};

const submit = async (ctx, runId) => {
  const run = await loadRun(ctx, runId);
  if (run.status !== 'CALCULATED') throw badRequest(run.status === 'DRAFT' ? 'PAYROLL_NOT_CALCULATED' : 'INVALID_STATUS_TRANSITION', { from: run.status, to: 'IN_REVIEW' });
  const rows = await prisma.payrollRunEmployee.findMany({ where: { runId, status: 'INCLUDED' }, select: { errors: true } });
  if (!rows.length) throw badRequest('PAYROLL_NOT_CALCULATED');
  if (rows.some((r) => Array.isArray(r.errors) && r.errors.length)) throw badRequest('PAYROLL_HAS_ERRORS');
  const settings = await getSettings(ctx.companyId);
  return prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'IN_REVIEW' } });
    const res = await approvals.start(tx, ctx, { entityType: 'PAYROLL', entityId: runId, requesterUserId: ctx.userId, amount: run.totalNet.toString(), branchId: run.branchId, workflowId: settings.workflowId || undefined, summary: `${run.runNumber} — ${run.period.name}` });
    await audit.record(ctx, { action: 'PAYROLL_SUBMITTED', entityType: 'PayrollRun', entityId: runId }, tx);
    return tx.payrollRun.update({ where: { id: runId }, data: { approvalInstanceId: res.instance.id } });
  });
};

approvals.registerHandler('PAYROLL', {
  onApproved: async (tx, inst, ctx) => {
    await tx.payrollRun.update({ where: { id: inst.entityId }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await audit.record(ctx, { action: 'PAYROLL_APPROVED', entityType: 'PayrollRun', entityId: inst.entityId }, tx);
    const payrollUsers = await usersWithRoles(inst.companyId, ['PAYROLL_MANAGER', 'HR_MANAGER'], tx);
    await notify({ companyId: inst.companyId, userIds: payrollUsers, type: 'PAYROLL_APPROVED', params: { summary: inst.summary }, link: `/payroll/runs/${inst.entityId}` }, tx);
  },
  onRejected: async (tx, inst, ctx, comment) => {
    await tx.payrollRun.update({ where: { id: inst.entityId }, data: { status: 'CALCULATED', notes: comment } });
  },
});

/**
 * Lock (one MySQL transaction): marks commissions as included, deducts installments with ledger entries, applies
 * adjustments and issues payslips. Any failure rolls everything back.
 */
const lock = async (ctx, runId) => {
  const run = await loadRun(ctx, runId);
  if (run.status !== 'APPROVED') throw badRequest('INVALID_STATUS_TRANSITION', { from: run.status, to: 'LOCKED' });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id = ${run.id} FOR UPDATE`;
    const rows = await tx.payrollRunEmployee.findMany({ where: { runId, status: 'INCLUDED' }, include: { lines: true } });
    for (const re of rows) {
      for (const l of re.lines) {
        if (l.sourceType === 'COMMISSION') {
          const upd = await tx.commissionTransaction.updateMany({ where: { id: l.sourceId, payrollRunId: null, status: { in: ['APPROVED', 'PAYABLE'] } }, data: { status: 'INCLUDED_IN_PAYROLL', payrollRunId: run.id } });
          if (upd.count !== 1) throw conflict('PAYROLL_COMMISSION_CONFLICT');
        }
        if (l.sourceType === 'LOAN' || l.sourceType === 'ADVANCE') {
          const inst = await tx.installment.findUnique({ where: { id: l.sourceId } });
          const remaining = D(inst.amount).minus(inst.paidAmount);
          if (remaining.lessThan(l.amount) || ['PAID', 'CANCELLED'].includes(inst.status)) throw conflict('INSTALLMENT_ALREADY_DEDUCTED');
          const paid = D(inst.paidAmount).plus(l.amount);
          await tx.installment.update({ where: { id: inst.id }, data: { paidAmount: paid.toFixed(2), status: paid.greaterThanOrEqualTo(inst.amount) ? 'PAID' : 'PARTIALLY_PAID' } });
          const { postLedger, refreshFinancingStatus } = require('../loans/loans.service');
          await postLedger(tx, ctx, { employeeId: re.employeeId, advanceId: inst.advanceId, loanId: inst.loanId, installmentId: inst.id, type: 'INSTALLMENT_DEDUCTION', credit: l.amount, payrollRunId: run.id, note: `${run.runNumber}` });
          await refreshFinancingStatus(tx, inst.advanceId, inst.loanId);
        }
        if (l.sourceType === 'ADJUSTMENT') {
          const upd = await tx.payrollAdjustment.updateMany({ where: { id: l.sourceId, status: 'APPROVED', appliedRunId: null }, data: { status: 'APPLIED', appliedRunId: run.id } });
          if (upd.count !== 1) throw conflict('DUPLICATE_VALUE', { field: 'adjustment' });
        }
      }
      const n = await nextSequence(tx, ctx.companyId, 'payslip');
      await tx.payslip.create({
        data: {
          companyId: ctx.companyId, runEmployeeId: re.id, runId: run.id, employeeId: re.employeeId, number: formatNumber(`PS${dayjs(run.period.startDate).format('YYMM')}`, n, 5),
          periodStart: run.period.startDate, periodEnd: run.period.endDate, paymentDate: run.period.paymentDate, grossEarnings: re.grossEarnings, totalDeductions: re.totalDeductions,
          netSalary: re.netSalary, currency: run.currency,
        },
      });
    }
    const locked = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'LOCKED', lockedAt: new Date() } });
    await audit.record(ctx, { action: 'PAYROLL_LOCKED', entityType: 'PayrollRun', entityId: run.id, newValue: { payslips: rows.length, net: run.totalNet.toString() } }, tx);
    const users = (await Promise.all(rows.map((r) => userForEmployee(r.employeeId, tx)))).filter(Boolean);
    await notify({ companyId: ctx.companyId, userIds: users, type: 'PAYSLIP_GENERATED', params: { period: run.period.name }, link: '/payslips' }, tx);
    return locked;
  }, { timeout: 180000, maxWait: 10000 });
};

const recordPayments = async (ctx, runId, { runEmployeeIds, paidAt, reference, status }) => {
  const run = await loadRun(ctx, runId);
  if (!['LOCKED', 'PARTIALLY_PAID'].includes(run.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: run.status, to: 'PAID' });
  return prisma.$transaction(async (tx) => {
    const where = { runId, status: 'INCLUDED', paymentStatus: { not: 'PAID' }, ...(runEmployeeIds?.length ? { id: { in: runEmployeeIds } } : {}) };
    const rows = await tx.payrollRunEmployee.findMany({ where });
    const when = paidAt ? new Date(paidAt) : new Date();
    for (const re of rows) {
      const snap = re.snapshot || {};
      await tx.payrollPayment.create({ data: { companyId: ctx.companyId, runId, runEmployeeId: re.id, amount: re.netSalary, method: snap.paymentMethod || 'BANK', bankName: snap.bankName || null, iban: snap.iban || null, reference: reference || null, paidAt: when, status: status || 'PAID', recordedById: ctx.userId } });
      await tx.payrollRunEmployee.update({ where: { id: re.id }, data: { paymentStatus: status || 'PAID', paymentReference: reference || null, paidAt: status === 'FAILED' ? null : when } });
      if ((status || 'PAID') === 'PAID') {
        await tx.payslip.updateMany({ where: { runEmployeeId: re.id }, data: { status: 'PAID' } });
        await tx.commissionTransaction.updateMany({ where: { payrollRunId: runId, employeeId: re.employeeId, status: 'INCLUDED_IN_PAYROLL' }, data: { status: 'PAID' } });
      }
    }
    const unpaid = await tx.payrollRunEmployee.count({ where: { runId, status: 'INCLUDED', paymentStatus: { not: 'PAID' } } });
    const updated = await tx.payrollRun.update({ where: { id: runId }, data: { status: unpaid ? 'PARTIALLY_PAID' : 'PAID' } });
    await audit.record(ctx, { action: 'PAYROLL_PAYMENT_RECORDED', entityType: 'PayrollRun', entityId: runId, newValue: { employees: rows.length, reference, status: status || 'PAID' } }, tx);
    return updated;
  });
};

// Reversal creates a mirror run with negated lines; the original approved data is preserved untouched
const reverse = async (ctx, runId, reason) => {
  const run = await loadRun(ctx, runId);
  if (!['LOCKED', 'PAID', 'PARTIALLY_PAID'].includes(run.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: run.status, to: 'REVERSED' });
  return prisma.$transaction(async (tx) => {
    const n = await nextSequence(tx, ctx.companyId, 'payrollRun');
    const rev = await tx.payrollRun.create({
      data: {
        companyId: ctx.companyId, periodId: run.periodId, branchId: run.branchId, runNumber: formatNumber(`RV${dayjs(run.period.startDate).format('YYYYMM')}`, n, 3), type: 'REVERSAL', status: 'LOCKED',
        reversalOfId: run.id, employeesCount: run.employeesCount, totalBasic: D(run.totalBasic).negated().toFixed(2), totalEarnings: D(run.totalEarnings).negated().toFixed(2),
        totalDeductions: D(run.totalDeductions).negated().toFixed(2), totalNet: D(run.totalNet).negated().toFixed(2), totalOvertime: D(run.totalOvertime).negated().toFixed(2),
        totalCommissions: D(run.totalCommissions).negated().toFixed(2), currency: run.currency, notes: reason, createdById: ctx.userId, lockedAt: new Date(), approvedAt: new Date(),
      },
    });
    const rows = await tx.payrollRunEmployee.findMany({ where: { runId: run.id, status: 'INCLUDED' }, include: { lines: true } });
    const { postLedger, refreshFinancingStatus } = require('../loans/loans.service');
    for (const re of rows) {
      const copy = await tx.payrollRunEmployee.create({
        data: {
          companyId: ctx.companyId, runId: rev.id, employeeId: re.employeeId, snapshot: re.snapshot, basicSalary: D(re.basicSalary).negated().toFixed(2),
          grossEarnings: D(re.grossEarnings).negated().toFixed(2), totalDeductions: D(re.totalDeductions).negated().toFixed(2), netSalary: D(re.netSalary).negated().toFixed(2), paymentStatus: 'UNPAID',
        },
      });
      await tx.payrollLine.createMany({ data: re.lines.map((l) => ({ runEmployeeId: copy.id, componentId: l.componentId, code: l.code, nameAr: l.nameAr, nameEn: l.nameEn, type: l.type, category: l.category, quantity: l.quantity, rate: l.rate, amount: D(l.amount).negated().toFixed(2), sourceType: l.sourceType, sourceId: l.sourceId, meta: { reversalOf: l.id }, sortOrder: l.sortOrder })) });
      for (const l of re.lines) {
        if (l.sourceType === 'COMMISSION') await tx.commissionTransaction.updateMany({ where: { id: l.sourceId, payrollRunId: run.id }, data: { status: 'PAYABLE', payrollRunId: null } });
        if (l.sourceType === 'ADJUSTMENT') await tx.payrollAdjustment.updateMany({ where: { id: l.sourceId, appliedRunId: run.id }, data: { status: 'APPROVED', appliedRunId: null } });
        if (l.sourceType === 'LOAN' || l.sourceType === 'ADVANCE') {
          const inst = await tx.installment.findUnique({ where: { id: l.sourceId } });
          const paid = D(inst.paidAmount).minus(l.amount);
          await tx.installment.update({ where: { id: inst.id }, data: { paidAmount: paid.toFixed(2), status: paid.lessThanOrEqualTo(0) ? 'DUE' : 'PARTIALLY_PAID' } });
          await postLedger(tx, ctx, { employeeId: re.employeeId, advanceId: inst.advanceId, loanId: inst.loanId, installmentId: inst.id, type: 'REVERSAL', debit: l.amount, payrollRunId: rev.id, note: `Reversal of ${run.runNumber}` });
          await refreshFinancingStatus(tx, inst.advanceId, inst.loanId);
        }
      }
    }
    await tx.payslip.updateMany({ where: { runId: run.id }, data: { status: 'VOID' } });
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'REVERSED' } });
    await audit.record(ctx, { action: 'PAYROLL_REVERSED', entityType: 'PayrollRun', entityId: run.id, newValue: { reversalRun: rev.runNumber }, reason }, tx);
    return rev;
  }, { timeout: 180000 });
};

const cancelRun = async (ctx, runId, reason) => {
  const run = await loadRun(ctx, runId);
  if (!['DRAFT', 'CALCULATED', 'IN_REVIEW'].includes(run.status)) throw badRequest('PAYROLL_LOCKED');
  await prisma.$transaction(async (tx) => {
    await approvals.cancel(tx, run.approvalInstanceId, 'RUN_CANCELLED');
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CANCELLED', notes: reason } });
    await audit.record(ctx, { action: 'PAYROLL_CANCELLED', entityType: 'PayrollRun', entityId: runId, reason }, tx);
  });
};

module.exports = { getSettings, createPeriod, createRun, calculate, setInclusion, submit, lock, recordPayments, reverse, cancelRun, loadRun, gatherInput, ACTIVE_RUN, snapshotOf };
