// Advances & loans: requests, approval, schedule, disbursement, repayments, ledger.
const prisma = require('../../database/prisma');
const { badRequest, notFound, forbidden, conflict } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const { buildSchedule } = require('../../engines/installments');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const { notify, userForEmployee } = require('../../services/notifications');
const { nextSequence, formatNumber, empName } = require('../../services/common');
const { assertEmployeeAccess } = require('../../services/scope');
const { hasPermission } = require('../../middleware/auth');

const KIND = {
  advance: { model: 'employeeAdvance', entity: 'ADVANCE', prefix: 'ADV', perm: 'advances', fk: 'advanceId', notifyType: 'ADVANCE_APPROVED' },
  loan: { model: 'employeeLoan', entity: 'LOAN', prefix: 'LN', perm: 'loans', fk: 'loanId', notifyType: 'LOAN_APPROVED' },
};

// Running balance per advance/loan: debit increases liability, credit reduces it
const postLedger = async (tx, ctx, { employeeId, advanceId, loanId, installmentId, type, debit = 0, credit = 0, payrollRunId, note, reversalOfId }) => {
  const last = await tx.financialLedgerEntry.findFirst({ where: advanceId ? { advanceId } : { loanId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const prev = last ? D(last.balanceAfter) : D(0);
  const balanceAfter = prev.plus(debit).minus(credit);
  return tx.financialLedgerEntry.create({
    data: {
      companyId: ctx.companyId, employeeId, advanceId: advanceId || null, loanId: loanId || null, installmentId: installmentId || null, type,
      debit: D(debit).toFixed(2), credit: D(credit).toFixed(2), balanceAfter: balanceAfter.toFixed(2), payrollRunId: payrollRunId || null, note: note || null,
      reversalOfId: reversalOfId || null, createdById: ctx.userId || null,
    },
  });
};

const outstandingOf = async (tx, { advanceId, loanId }) => {
  const last = await tx.financialLedgerEntry.findFirst({ where: advanceId ? { advanceId } : { loanId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return last ? D(last.balanceAfter) : D(0);
};

const refreshFinancingStatus = async (tx, advanceId, loanId) => {
  const model = advanceId ? 'employeeAdvance' : 'employeeLoan';
  const id = advanceId || loanId;
  if (!id) return;
  const row = await tx[model].findUnique({ where: { id } });
  if (!['DISBURSED', 'REPAYING', 'SETTLED'].includes(row.status)) return;
  const balance = await outstandingOf(tx, { advanceId, loanId });
  const status = balance.lessThanOrEqualTo(0) ? 'SETTLED' : 'REPAYING';
  if (status !== row.status) await tx[model].update({ where: { id }, data: { status } });
};

const getSetting = async (companyId, key) => (await prisma.systemSetting.findUnique({ where: { companyId_key: { companyId, key } } }))?.value ?? null;

const create = async (ctx, kind, body) => {
  const k = KIND[kind];
  const employeeId = body.employeeId || ctx.employeeId;
  if (!employeeId) throw badRequest('EMPLOYEE_NOT_FOUND');
  await assertEmployeeAccess(ctx, employeeId, `${k.perm}.view`);
  if (employeeId !== ctx.employeeId && !hasPermission(ctx, `${k.perm}.edit`)) throw forbidden('PERMISSION_DENIED', { permission: `${k.perm}.edit` });
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId } });
  if (!['ACTIVE', 'PROBATION', 'ON_LEAVE'].includes(employee.status)) throw badRequest('ACCOUNT_DISABLED');
  const maxAmount = await getSetting(ctx.companyId, `${kind}s.maxAmount`);
  if (maxAmount && D(body.amount).greaterThan(D(maxAmount))) throw badRequest('AMOUNT_EXCEEDS_LIMIT');
  const maxInst = await getSetting(ctx.companyId, `${kind}s.maxInstallments`);
  if (maxInst && Number(body.installmentCount) > Number(maxInst)) throw badRequest('AMOUNT_EXCEEDS_LIMIT');
  if (kind === 'loan' && D(body.feeAmount || 0).greaterThan(0) && !(await getSetting(ctx.companyId, 'loans.feesEnabled'))) throw badRequest('VALIDATION_FAILED');

  return prisma.$transaction(async (tx) => {
    const n = await nextSequence(tx, ctx.companyId, kind);
    const data = {
      companyId: ctx.companyId, employeeId, number: formatNumber(k.prefix, n, 5), amount: body.amount, reason: body.reason || null, requestDate: toDateOnly(new Date()),
      repaymentMethod: body.repaymentMethod || 'PAYROLL', installmentCount: body.installmentCount || 1, firstDeductionDate: body.firstDeductionDate ? toDateOnly(body.firstDeductionDate) : null,
      attachmentId: body.attachmentId || null, status: 'PENDING', createdById: ctx.userId,
    };
    if (kind === 'advance') Object.assign(data, { requestedPaymentDate: body.requestedPaymentDate ? toDateOnly(body.requestedPaymentDate) : null, notes: body.notes || null });
    else Object.assign(data, { loanType: body.loanType || 'PERSONAL', feeAmount: body.feeAmount || '0', monthlyInstallment: body.monthlyInstallment || null });
    const row = await tx[k.model].create({ data });
    const res = await approvals.start(tx, ctx, { entityType: k.entity, entityId: row.id, requesterEmployeeId: employeeId, requesterUserId: employeeId === ctx.employeeId ? ctx.userId : undefined, amount: body.amount, summary: `${row.number} — ${empName(employee)} — ${D(body.amount).toFixed(2)}` });
    await tx[k.model].update({ where: { id: row.id }, data: { approvalInstanceId: res.instance.id } });
    await audit.record(ctx, { action: `${k.entity}_REQUESTED`, entityType: k.entity, entityId: row.id, employeeId, after: row }, tx);
    return tx[k.model].findUnique({ where: { id: row.id } });
  });
};

const onApproved = (kind) => async (tx, inst, ctx) => {
  const k = KIND[kind];
  const row = await tx[k.model].findUnique({ where: { id: inst.entityId } });
  const total = D(row.approvedAmount || row.amount).plus(kind === 'loan' ? row.feeAmount : 0);
  const first = row.firstDeductionDate || toDateOnly(dayjs().add(1, 'month').startOf('month').add(24, 'day').toDate());
  const schedule = buildSchedule({ total, count: row.installmentCount, firstDate: first, monthlyAmount: kind === 'loan' ? row.monthlyInstallment : null });
  await tx.installment.createMany({ data: schedule.map((s) => ({ companyId: row.companyId, employeeId: row.employeeId, [k.fk]: row.id, number: s.number, dueDate: s.dueDate, amount: s.amount.toFixed(2) })) });
  await tx[k.model].update({
    where: { id: row.id },
    data: { status: 'APPROVED', approvedAmount: row.approvedAmount || row.amount, firstDeductionDate: first, installmentCount: schedule.length, ...(kind === 'loan' ? { approvalDate: toDateOnly(new Date()), monthlyInstallment: schedule[0]?.amount.toFixed(2) } : {}) },
  });
  await notify({ companyId: row.companyId, userIds: [await userForEmployee(row.employeeId, tx)], type: k.notifyType, params: { number: row.number, amount: D(row.amount).toFixed(2) }, link: `/${kind}s/${row.id}` }, tx);
  await audit.record(ctx, { action: `${k.entity}_APPROVED`, entityType: k.entity, entityId: row.id, employeeId: row.employeeId, newValue: { installments: schedule.length } }, tx);
};
const onRejected = (kind) => async (tx, inst) => {
  await tx[KIND[kind].model].update({ where: { id: inst.entityId }, data: { status: 'REJECTED' } });
};
approvals.registerHandler('ADVANCE', { onApproved: onApproved('advance'), onRejected: onRejected('advance') });
approvals.registerHandler('LOAN', { onApproved: onApproved('loan'), onRejected: onRejected('loan') });

const load = async (ctx, kind, id) => {
  const k = KIND[kind];
  const row = await prisma[k.model].findFirst({ where: { id, companyId: ctx.companyId }, include: { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } }, installments: { orderBy: { number: 'asc' } } } });
  if (!row) throw notFound();
  await assertEmployeeAccess(ctx, row.employeeId, `${k.perm}.view`);
  return row;
};

const detail = async (ctx, kind, id) => {
  const row = await load(ctx, kind, id);
  const k = KIND[kind];
  const ledger = await prisma.financialLedgerEntry.findMany({ where: { [k.fk]: id }, orderBy: [{ createdAt: 'asc' }] });
  const outstanding = await outstandingOf(prisma, { [k.fk]: id });
  return { ...row, ledger, outstanding: outstanding.toFixed(2), approvals: await approvals.timeline(ctx.companyId, k.entity, id) };
};

const disburse = async (ctx, kind, id, { disbursedAt, note }) => {
  const k = KIND[kind];
  const row = await load(ctx, kind, id);
  if (row.status !== 'APPROVED') throw badRequest('INVALID_STATUS_TRANSITION', { from: row.status, to: 'DISBURSED' });
  return prisma.$transaction(async (tx) => {
    const total = D(row.approvedAmount || row.amount).plus(kind === 'loan' ? row.feeAmount : 0);
    await postLedger(tx, ctx, { employeeId: row.employeeId, [k.fk]: row.id, type: 'DISBURSEMENT', debit: total, note });
    const when = disbursedAt ? new Date(disbursedAt) : new Date();
    const updated = await tx[k.model].update({ where: { id }, data: { status: 'DISBURSED', ...(kind === 'advance' ? { disbursedAt: when } : { disbursementDate: toDateOnly(when) }) } });
    await audit.record(ctx, { action: `${k.entity}_DISBURSED`, entityType: k.entity, entityId: id, employeeId: row.employeeId, newValue: { amount: total.toFixed(2) }, reason: note }, tx);
    return updated;
  });
};

// Manual repayment applied to the earliest unpaid installments
const repay = async (ctx, kind, id, { amount, note }) => {
  const k = KIND[kind];
  const row = await load(ctx, kind, id);
  if (!['DISBURSED', 'REPAYING'].includes(row.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: row.status, to: 'REPAYING' });
  return prisma.$transaction(async (tx) => {
    const outstanding = await outstandingOf(tx, { [k.fk]: id });
    if (D(amount).greaterThan(outstanding)) throw badRequest('AMOUNT_EXCEEDS_LIMIT');
    // installments already referenced by a not-yet-locked payroll run are skipped to avoid double collection
    const reserved = (await tx.payrollLine.findMany({ where: { sourceType: kind === 'loan' ? 'LOAN' : 'ADVANCE', runEmployee: { run: { status: { in: ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'] } } } }, select: { sourceId: true } })).map((l) => l.sourceId);
    let left = D(amount);
    const insts = await tx.installment.findMany({ where: { [k.fk]: id, status: { in: ['UPCOMING', 'DUE', 'PARTIALLY_PAID', 'OVERDUE'] }, id: { notIn: reserved } }, orderBy: { number: 'asc' } });
    for (const inst of insts) {
      if (left.lessThanOrEqualTo(0)) break;
      const due = D(inst.amount).minus(inst.paidAmount);
      const pay = left.lessThan(due) ? left : due;
      const paid = D(inst.paidAmount).plus(pay);
      await tx.installment.update({ where: { id: inst.id }, data: { paidAmount: paid.toFixed(2), status: paid.greaterThanOrEqualTo(inst.amount) ? 'PAID' : 'PARTIALLY_PAID' } });
      await postLedger(tx, ctx, { employeeId: row.employeeId, [k.fk]: id, installmentId: inst.id, type: 'MANUAL_REPAYMENT', credit: pay, note });
      left = left.minus(pay);
    }
    if (left.greaterThan(0)) throw conflict('INSTALLMENT_ALREADY_DEDUCTED');
    await refreshFinancingStatus(tx, kind === 'advance' ? id : null, kind === 'loan' ? id : null);
    await audit.record(ctx, { action: `${k.entity}_MANUAL_REPAYMENT`, entityType: k.entity, entityId: id, employeeId: row.employeeId, newValue: { amount }, reason: note }, tx);
    return tx[k.model].findUnique({ where: { id } });
  });
};

// Defer an unpaid installment to after the last one (approved policy action)
const deferInstallment = async (ctx, kind, id, installmentId, reason) => {
  const k = KIND[kind];
  const row = await load(ctx, kind, id);
  const inst = row.installments.find((i) => i.id === installmentId);
  if (!inst || !['UPCOMING', 'DUE', 'OVERDUE'].includes(inst.status) || D(inst.paidAmount).greaterThan(0)) throw badRequest('INVALID_STATUS_TRANSITION', { from: inst?.status || '-', to: 'DEFERRED' });
  return prisma.$transaction(async (tx) => {
    const last = row.installments[row.installments.length - 1];
    const created = await tx.installment.create({ data: { companyId: ctx.companyId, employeeId: row.employeeId, [k.fk]: id, number: last.number + 1, dueDate: toDateOnly(dayjs(last.dueDate).add(1, 'month').toDate()), amount: inst.amount, notes: `Deferred from #${inst.number}` } });
    await tx.installment.update({ where: { id: inst.id }, data: { status: 'DEFERRED', deferredToId: created.id, notes: reason } });
    await tx[k.model].update({ where: { id }, data: { installmentCount: row.installmentCount + 1 } });
    await audit.record(ctx, { action: 'INSTALLMENT_DEFERRED', entityType: k.entity, entityId: id, employeeId: row.employeeId, newValue: { from: inst.number, to: created.number }, reason }, tx);
    return created;
  });
};

const cancel = async (ctx, kind, id, reason) => {
  const k = KIND[kind];
  const row = await load(ctx, kind, id);
  if (!['PENDING', 'APPROVED'].includes(row.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: row.status, to: 'CANCELLED' });
  if (row.employeeId === ctx.employeeId && row.status !== 'PENDING') throw forbidden();
  await prisma.$transaction(async (tx) => {
    await approvals.cancel(tx, row.approvalInstanceId);
    await tx.installment.updateMany({ where: { [k.fk]: id }, data: { status: 'CANCELLED' } });
    await tx[k.model].update({ where: { id }, data: { status: 'CANCELLED' } });
    await audit.record(ctx, { action: `${k.entity}_CANCELLED`, entityType: k.entity, entityId: id, employeeId: row.employeeId, reason }, tx);
  });
};

// Employee financial statement (profile tab)
const statement = async (ctx, employeeId) => {
  await assertEmployeeAccess(ctx, employeeId, ['advances.view', 'loans.view']);
  const [advances, loans, installments, ledger] = await Promise.all([
    prisma.employeeAdvance.findMany({ where: { employeeId, companyId: ctx.companyId }, orderBy: { createdAt: 'desc' } }),
    prisma.employeeLoan.findMany({ where: { employeeId, companyId: ctx.companyId }, orderBy: { createdAt: 'desc' } }),
    prisma.installment.findMany({ where: { employeeId, companyId: ctx.companyId, status: { not: 'CANCELLED' } }, orderBy: { dueDate: 'asc' } }),
    prisma.financialLedgerEntry.findMany({ where: { employeeId, companyId: ctx.companyId }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ]);
  const live = (r) => ['DISBURSED', 'REPAYING', 'SETTLED'].includes(r.status);
  const today = toDateOnly(new Date());
  const unpaid = installments.filter((i) => !['PAID', 'DEFERRED'].includes(i.status));
  return {
    totals: {
      advances: sum(advances.filter(live), (a) => a.approvedAmount || a.amount).toFixed(2),
      loans: sum(loans.filter(live), (l) => D(l.approvedAmount || l.amount).plus(l.feeAmount)).toFixed(2),
      disbursed: sum(ledger.filter((e) => e.type === 'DISBURSEMENT'), (e) => e.debit).toFixed(2),
      paid: sum(installments, (i) => i.paidAmount).toFixed(2),
      remaining: sum(unpaid, (i) => D(i.amount).minus(i.paidAmount)).toFixed(2),
      overdue: sum(unpaid.filter((i) => i.dueDate < today), (i) => D(i.amount).minus(i.paidAmount)).toFixed(2),
    },
    upcoming: unpaid.filter((i) => i.dueDate >= today).slice(0, 6),
    overdue: unpaid.filter((i) => i.dueDate < today),
    advances, loans, ledger,
  };
};

// Daily job: UPCOMING → DUE (due this month) → OVERDUE (past due date and unpaid in a previous month)
const refreshInstallmentStatuses = async (companyId) => {
  const today = toDateOnly(new Date());
  const monthStart = toDateOnly(dayjs().startOf('month').toDate());
  const monthEnd = toDateOnly(dayjs().endOf('month').toDate());
  await prisma.installment.updateMany({ where: { companyId, status: 'UPCOMING', dueDate: { lte: monthEnd } }, data: { status: 'DUE' } });
  const overdue = await prisma.installment.updateMany({ where: { companyId, status: { in: ['DUE', 'PARTIALLY_PAID'] }, dueDate: { lt: monthStart } }, data: { status: 'OVERDUE' } });
  return { overdue: overdue.count, today: fmtDate(today) };
};

module.exports = { KIND, create, detail, disburse, repay, deferInstallment, cancel, statement, postLedger, outstandingOf, refreshFinancingStatus, refreshInstallmentStatuses, load };
