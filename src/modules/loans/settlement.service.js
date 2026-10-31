// Final settlement on termination. Collects obligations for review; NEVER deducts automatically.
// Deductions from final dues are entered explicitly after policy/legal review (agreedDeduction) and approved.
const prisma = require('../../database/prisma');
const { badRequest, notFound } = require('../../utils/errors');
const { D, sum } = require('../../utils/money');
const { dayjs, fmtDate } = require('../../utils/dates');
const audit = require('../../services/audit');

const collect = async (tx, employeeId) => {
  const installments = await tx.installment.findMany({ where: { employeeId, status: { in: ['UPCOMING', 'DUE', 'PARTIALLY_PAID', 'OVERDUE'] } }, include: { advance: { select: { number: true } }, loan: { select: { number: true } } } });
  const outstanding = sum(installments, (i) => D(i.amount).minus(i.paidAmount));
  const year = new Date().getUTCFullYear();
  const balances = await tx.leaveBalance.findMany({ where: { employeeId, year, leaveType: { category: 'ANNUAL' } } });
  const leaveDays = sum(balances, (b) => D(b.openingBalance).plus(b.accrued).plus(b.adjustments).plus(b.carriedForward).minus(b.used));
  return {
    outstanding, unpaidInstallments: installments.length,
    details: {
      installments: installments.map((i) => ({ id: i.id, ref: i.loan?.number || i.advance?.number, number: i.number, dueDate: fmtDate(i.dueDate), remaining: D(i.amount).minus(i.paidAmount).toFixed(2) })),
      annualLeaveDaysRemaining: leaveDays.toFixed(2),
    },
  };
};

// End-of-service per company-configured rules: [{ fromYears, toYears, monthsPerYear, base: 'BASIC' | 'FLAGGED' }].
// With no configured rules the amount stays 0 and must be entered by HR (no legal rule is invented here).
const computeEos = async (tx, employee, terminationDate) => {
  const setting = await tx.payrollSetting.findUnique({ where: { companyId: employee.companyId } });
  const rules = Array.isArray(setting?.eosRules) ? setting.eosRules : [];
  if (!rules.length) return { amount: D(0), configured: false };
  const rev = await tx.employeeSalaryRevision.findFirst({ where: { employeeId: employee.id, status: 'ACTIVE', effectiveFrom: { lte: terminationDate } }, orderBy: { effectiveFrom: 'desc' }, include: { lines: { include: { component: true } } } });
  if (!rev) return { amount: D(0), configured: true };
  const years = dayjs(terminationDate).diff(dayjs(employee.hireDate), 'day') / 365;
  let amount = D(0);
  for (const r of rules) {
    const base = sum(rev.lines.filter((l) => (r.base === 'BASIC' ? l.component.category === 'BASIC' : l.component.includeInEosBase)), (l) => l.amount);
    const from = Number(r.fromYears || 0);
    const to = r.toYears != null ? Number(r.toYears) : Infinity;
    const inBand = Math.max(0, Math.min(years, to) - from);
    amount = amount.plus(base.times(r.monthsPerYear || 0).times(inBand));
  }
  return { amount: amount.toDecimalPlaces(2), configured: true, years: years.toFixed(2) };
};

const createSettlementDraft = async (tx, ctx, employee, reason) => {
  const existing = await tx.employeeSettlement.findFirst({ where: { employeeId: employee.id, status: { not: 'CLOSED' } } });
  if (existing) return existing;
  const c = await collect(tx, employee.id);
  const eos = await computeEos(tx, employee, employee.terminationDate || new Date());
  return tx.employeeSettlement.create({
    data: {
      companyId: employee.companyId, employeeId: employee.id, terminationDate: employee.terminationDate || new Date(), reason: reason || null,
      outstandingBalance: c.outstanding.toFixed(2), unpaidInstallments: c.unpaidInstallments, eosAmount: eos.amount.toFixed(2),
      details: { ...c.details, eosConfigured: eos.configured, serviceYears: eos.years || null }, netSettlement: eos.amount.toFixed(2),
    },
  });
};

const refresh = async (ctx, id) => {
  const s = await prisma.employeeSettlement.findFirst({ where: { id, companyId: ctx.companyId }, include: { employee: true } });
  if (!s) throw notFound();
  if (['APPROVED', 'CLOSED'].includes(s.status)) return s;
  return prisma.$transaction(async (tx) => {
    const c = await collect(tx, s.employeeId);
    return tx.employeeSettlement.update({ where: { id }, data: { outstandingBalance: c.outstanding.toFixed(2), unpaidInstallments: c.unpaidInstallments, details: { ...(s.details || {}), ...c.details } } });
  });
};

const update = async (ctx, id, body) => {
  const s = await prisma.employeeSettlement.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!s) throw notFound();
  if (!['DRAFT', 'REVIEWED'].includes(s.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: s.status, to: 'DRAFT' });
  const eos = D(body.eosAmount ?? s.eosAmount);
  const leave = D(body.leaveEncashment ?? s.leaveEncashment);
  const other = D(body.otherDues ?? s.otherDues);
  const deduction = D(body.agreedDeduction ?? s.agreedDeduction);
  if (deduction.greaterThan(s.outstandingBalance)) throw badRequest('AMOUNT_EXCEEDS_LIMIT');
  const updated = await prisma.employeeSettlement.update({
    where: { id },
    data: { eosAmount: eos.toFixed(2), leaveEncashment: leave.toFixed(2), otherDues: other.toFixed(2), agreedDeduction: deduction.toFixed(2), netSettlement: eos.plus(leave).plus(other).minus(deduction).toFixed(2), notes: body.notes ?? s.notes, status: 'DRAFT' },
  });
  await audit.record(ctx, { action: 'SETTLEMENT_UPDATED', entityType: 'EmployeeSettlement', entityId: id, employeeId: s.employeeId, before: s, after: updated });
  return updated;
};

const transition = async (ctx, id, to) => {
  const s = await prisma.employeeSettlement.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!s) throw notFound();
  const allowed = { REVIEWED: ['DRAFT'], APPROVED: ['REVIEWED'], CLOSED: ['APPROVED'] };
  if (!allowed[to].includes(s.status)) throw badRequest(to === 'APPROVED' ? 'SETTLEMENT_NOT_REVIEWED' : 'INVALID_STATUS_TRANSITION', { from: s.status, to });
  return prisma.$transaction(async (tx) => {
    const data = { status: to };
    if (to === 'REVIEWED') data.reviewedById = ctx.userId;
    if (to === 'APPROVED') data.approvedById = ctx.userId;
    if (to === 'CLOSED') {
      // apply the agreed deduction (if any) to outstanding installments through the ledger; the remainder stays visible
      let left = D(s.agreedDeduction);
      if (left.greaterThan(0)) {
        const { postLedger, refreshFinancingStatus } = require('./loans.service');
        const insts = await tx.installment.findMany({ where: { employeeId: s.employeeId, status: { in: ['UPCOMING', 'DUE', 'PARTIALLY_PAID', 'OVERDUE'] } }, orderBy: { dueDate: 'asc' } });
        for (const inst of insts) {
          if (left.lessThanOrEqualTo(0)) break;
          const due = D(inst.amount).minus(inst.paidAmount);
          const pay = left.lessThan(due) ? left : due;
          await tx.installment.update({ where: { id: inst.id }, data: { paidAmount: D(inst.paidAmount).plus(pay).toFixed(2), status: D(inst.paidAmount).plus(pay).greaterThanOrEqualTo(inst.amount) ? 'PAID' : 'PARTIALLY_PAID' } });
          await postLedger(tx, ctx, { employeeId: s.employeeId, advanceId: inst.advanceId, loanId: inst.loanId, installmentId: inst.id, type: 'SETTLEMENT', credit: pay, note: `Settlement ${s.id}` });
          await refreshFinancingStatus(tx, inst.advanceId, inst.loanId);
          left = left.minus(pay);
        }
      }
    }
    const updated = await tx.employeeSettlement.update({ where: { id }, data });
    await audit.record(ctx, { action: `SETTLEMENT_${to}`, entityType: 'EmployeeSettlement', entityId: id, employeeId: s.employeeId, before: s, after: updated }, tx);
    return updated;
  });
};

module.exports = { createSettlementDraft, refresh, update, transition, computeEos, collect };
