const prisma = require('../../database/prisma');
const { badRequest, conflict, notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const engine = require('../../engines/commission');
const audit = require('../../services/audit');
const { notify, userForEmployee } = require('../../services/notifications');
const { assertEmployeeAccess } = require('../../services/scope');

const activeRules = (companyId, at) => prisma.commissionRule.findMany({
  where: { companyId, status: 'ACTIVE', effectiveFrom: { lte: toDateOnly(at) }, OR: [{ expiryDate: null }, { expiryDate: { gte: toDateOnly(at) } }] },
  include: { tiers: true }, orderBy: { priority: 'desc' },
});

const initialStatus = (rule) => (rule.requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED');

// Creates a source transaction (idempotent on externalRef) with its distribution
const createSource = async (ctx, body) => {
  engine.validateDistribution(body.participants);
  const ids = body.participants.map((p) => p.employeeId);
  if ((await prisma.employee.count({ where: { id: { in: ids }, companyId: ctx.companyId } })) !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', { field: 'participants' });
  const existing = await prisma.commissionSourceTransaction.findUnique({ where: { companyId_externalRef: { companyId: ctx.companyId, externalRef: body.externalRef } } });
  if (existing) throw conflict('DUPLICATE_VALUE', { field: 'externalRef' });
  const { participants, ...data } = body;
  const src = await prisma.commissionSourceTransaction.create({
    data: { ...data, companyId: ctx.companyId, transactionDate: toDateOnly(body.transactionDate), participants: { create: participants.map((p) => ({ employeeId: p.employeeId, role: p.role || 'TECHNICIAN', sharePercent: p.sharePercent })) } },
    include: { participants: true },
  });
  await audit.record(ctx, { action: 'COMMISSION_SOURCE_CREATED', entityType: 'CommissionSourceTransaction', entityId: src.id, after: src });
  return src;
};

// Flag changes (quality approved, collected, cancelled, refunded). Cancel/refund reverses commissions already calculated.
const updateSourceFlags = async (ctx, id, flags) => {
  const src = await prisma.commissionSourceTransaction.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!src) throw notFound();
  const updated = await prisma.commissionSourceTransaction.update({ where: { id }, data: flags });
  await audit.record(ctx, { action: 'COMMISSION_SOURCE_UPDATED', entityType: 'CommissionSourceTransaction', entityId: id, before: src, after: updated });
  let reversed = 0;
  if ((flags.isCancelled && !src.isCancelled) || (flags.isRefunded && !src.isRefunded)) {
    const entries = await prisma.commissionTransaction.findMany({ where: { companyId: ctx.companyId, sourceTransactionId: id, entryType: 'ACCRUAL', status: { notIn: ['REVERSED', 'CANCELLED'] } } });
    for (const e of entries) { await reverse(ctx, e.id, flags.isCancelled ? 'Source transaction cancelled' : 'Source transaction refunded'); reversed++; }
  }
  return { ...updated, reversed };
};

/**
 * calculate(ctx, { from, to, branchId?, ruleIds? }) — idempotent: a dedupe key per (rule, source, employee, role)
 * or (rule, month, employee) prevents double commission for the same operation.
 */
const calculate = async (ctx, { from, to, branchId, ruleIds }) => {
  const rules = (await activeRules(ctx.companyId, to)).filter((r) => !ruleIds?.length || ruleIds.includes(r.id));
  const sources = await prisma.commissionSourceTransaction.findMany({
    where: { companyId: ctx.companyId, transactionDate: { gte: toDateOnly(from), lte: toDateOnly(to) }, ...(branchId ? { branchId } : {}) },
    include: { participants: { include: { employee: true } } },
  });
  const created = [];
  const skipped = [];
  const exists = async (key) => !!(await prisma.commissionTransaction.findUnique({ where: { companyId_dedupeKey: { companyId: ctx.companyId, dedupeKey: key } } }));

  // per-transaction rules
  for (const rule of rules.filter((r) => engine.PER_TRANSACTION.includes(r.type))) {
    for (const src of sources) {
      for (const p of src.participants) {
        if (rule.participantRole !== 'ANY' && rule.participantRole !== p.role) continue;
        if (!engine.applies(rule, p.employee, src)) continue;
        const key = `${rule.id}:${src.id}:${p.employeeId}:${p.role}`;
        if (await exists(key)) continue;
        const elig = engine.isEligible(rule, src, p.employee);
        if (!elig.eligible) { skipped.push({ rule: rule.code, source: src.externalRef, employeeId: p.employeeId, reasons: elig.reasons }); continue; }
        const amount = engine.perTransactionAmount(rule, src, p.sharePercent);
        if (amount.isZero()) continue;
        created.push(await prisma.commissionTransaction.create({
          data: {
            companyId: ctx.companyId, employeeId: p.employeeId, ruleId: rule.id, sourceTransactionId: src.id, branchId: src.branchId, serviceCode: src.serviceCode,
            calculationBase: engine.baseOf(rule, src).toFixed(2), rate: rule.value, sharePercent: p.sharePercent, grossAmount: amount.toFixed(2), netAmount: amount.toFixed(2),
            status: initialStatus(rule), dedupeKey: key, earnedDate: src.transactionDate, createdById: ctx.userId,
          },
        }));
      }
    }
  }

  // per-period rules, month by month
  const months = [];
  for (let m = dayjs(from).startOf('month'); !m.isAfter(dayjs(to)); m = m.add(1, 'month')) months.push(m);
  const employees = await prisma.employee.findMany({ where: { companyId: ctx.companyId, deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] } } });
  for (const rule of rules.filter((r) => engine.PER_PERIOD.includes(r.type))) {
    if (rule.type === 'PERFORMANCE_BONUS') continue; // entered manually with an evaluation reference
    for (const m of months) {
      const periodKey = m.format('YYYY-MM');
      const mStart = m.startOf('month').toDate();
      const mEnd = m.endOf('month').toDate();
      const monthSources = sources.filter((s) => s.transactionDate >= toDateOnly(mStart) && s.transactionDate <= toDateOnly(mEnd));
      let targets;
      if (rule.type === 'BRANCH_MANAGER') {
        const branches = await prisma.branch.findMany({ where: { companyId: ctx.companyId, managerId: { not: null }, ...(rule.branchIds?.length ? { id: { in: rule.branchIds } } : {}) } });
        targets = branches.map((b) => ({ employee: employees.find((e) => e.id === b.managerId), base: sum(monthSources.filter((s) => s.branchId === b.id && engine.isEligible(rule, s).eligible), (s) => engine.baseOf(rule, s)) })).filter((t) => t.employee);
      } else if (rule.type === 'MONTHLY_BONUS') {
        targets = employees.filter((e) => engine.applies(rule, e, null)).map((e) => ({ employee: e, base: D(0) }));
      } else {
        // TARGET / TIERED: base = employee's share of eligible transactions in the month
        targets = employees.filter((e) => engine.applies(rule, e, null)).map((e) => {
          let base = D(0);
          for (const s of monthSources) {
            const part = s.participants.find((p) => p.employeeId === e.id && (rule.participantRole === 'ANY' || rule.participantRole === p.role));
            if (!part || !engine.isEligible(rule, s, e).eligible || !engine.applies(rule, e, s)) continue;
            base = base.plus(engine.baseOf(rule, s).times(D(part.sharePercent)).dividedBy(100));
          }
          return { employee: e, base };
        }).filter((t) => t.base.greaterThan(0));
      }
      for (const t of targets) {
        const amount = engine.perPeriodAmount(rule, t.base, rule.tiers);
        const key = `${rule.id}:${periodKey}:${t.employee.id}`;
        const prior = await prisma.commissionTransaction.findMany({ where: { companyId: ctx.companyId, ruleId: rule.id, periodKey, employeeId: t.employee.id, status: { notIn: ['REVERSED', 'CANCELLED'] } } });
        if (!prior.length) {
          if (amount.isZero()) continue;
          created.push(await prisma.commissionTransaction.create({
            data: {
              companyId: ctx.companyId, employeeId: t.employee.id, ruleId: rule.id, periodKey, branchId: t.employee.branchId, calculationBase: t.base.toFixed(2), rate: rule.value,
              grossAmount: amount.toFixed(2), netAmount: amount.toFixed(2), status: initialStatus(rule), dedupeKey: key, earnedDate: toDateOnly(mEnd), createdById: ctx.userId,
            },
          }));
        } else {
          // the month grew (new sales) → record the delta as an ADJUSTMENT entry instead of editing the original
          const already = sum(prior, (x) => x.netAmount);
          const delta = amount.minus(already);
          if (!delta.isZero()) {
            created.push(await prisma.commissionTransaction.create({
              data: {
                companyId: ctx.companyId, employeeId: t.employee.id, ruleId: rule.id, periodKey, branchId: t.employee.branchId, entryType: 'ADJUSTMENT', calculationBase: t.base.toFixed(2), rate: rule.value,
                grossAmount: delta.toFixed(2), netAmount: delta.toFixed(2), status: initialStatus(rule), earnedDate: toDateOnly(mEnd), notes: `Recalculated ${periodKey}: ${already.toFixed(2)} → ${amount.toFixed(2)}`, createdById: ctx.userId,
              },
            }));
          }
        }
      }
    }
  }

  await prisma.commissionSourceTransaction.updateMany({ where: { id: { in: sources.map((s) => s.id) } }, data: { status: 'PROCESSED' } });
  await audit.record(ctx, { action: 'COMMISSIONS_CALCULATED', entityType: 'CommissionTransaction', newValue: { from, to, created: created.length, skipped: skipped.length } });
  return { created: created.length, total: sum(created, (c) => c.netAmount).toFixed(2), skipped };
};

const transition = async (ctx, id, to, { reason } = {}) => {
  const e = await prisma.commissionTransaction.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!e) throw notFound();
  if (!engine.canTransition(e.status, to)) throw badRequest('INVALID_STATUS_TRANSITION', { from: e.status, to });
  if (to === 'APPROVED' && e.employeeId === ctx.employeeId) throw forbidden('NOT_YOUR_APPROVAL');
  if (to === 'ON_HOLD' && !reason) throw badRequest('REJECTION_REASON_REQUIRED');
  const data = { status: to };
  if (to === 'APPROVED') { data.approvedById = ctx.userId; data.approvedAt = new Date(); data.holdReason = null; }
  if (to === 'ON_HOLD') data.holdReason = reason;
  if (to === 'CANCELLED') data.notes = reason || e.notes;
  // conditional update guards against concurrent transitions
  const upd = await prisma.commissionTransaction.updateMany({ where: { id, status: e.status }, data });
  if (upd.count !== 1) throw conflict('APPROVAL_ALREADY_DECIDED');
  const after = await prisma.commissionTransaction.findUnique({ where: { id } });
  await audit.record(ctx, { action: `COMMISSION_${to}`, entityType: 'CommissionTransaction', entityId: id, employeeId: e.employeeId, before: e, after, reason });
  if (to === 'APPROVED') await notify({ companyId: ctx.companyId, userIds: [await userForEmployee(e.employeeId)], type: 'COMMISSION_APPROVED', params: { amount: e.netAmount.toString() }, link: '/commissions/my' });
  return after;
};

const bulkTransition = async (ctx, ids, to, opts) => {
  const results = [];
  for (const id of ids) {
    try { await transition(ctx, id, to, opts); results.push({ id, ok: true }); } catch (err) { results.push({ id, ok: false, code: err.code }); }
  }
  return { results };
};

// Reversal: never edits the original. Unpaid entries become REVERSED; paid/included entries get a negative entry
// that the next payroll deducts.
const reverse = async (ctx, id, reason) => {
  const e = await prisma.commissionTransaction.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!e) throw notFound();
  if (['REVERSED', 'CANCELLED'].includes(e.status) || e.entryType === 'REVERSAL') throw badRequest('INVALID_STATUS_TRANSITION', { from: e.status, to: 'REVERSED' });
  return prisma.$transaction(async (tx) => {
    if (['INCLUDED_IN_PAYROLL', 'PAID'].includes(e.status)) {
      const rev = await tx.commissionTransaction.create({
        data: {
          companyId: e.companyId, employeeId: e.employeeId, ruleId: e.ruleId, sourceTransactionId: e.sourceTransactionId, branchId: e.branchId, serviceCode: e.serviceCode, periodKey: e.periodKey,
          entryType: 'REVERSAL', calculationBase: e.calculationBase, rate: e.rate, sharePercent: e.sharePercent, grossAmount: D(e.grossAmount).negated().toFixed(2), netAmount: D(e.netAmount).negated().toFixed(2),
          status: 'APPROVED', approvedAt: new Date(), approvedById: ctx.userId, reversalOfId: e.id, earnedDate: toDateOnly(new Date()), notes: reason, createdById: ctx.userId,
        },
      });
      await audit.record(ctx, { action: 'COMMISSION_REVERSAL_ENTRY', entityType: 'CommissionTransaction', entityId: rev.id, employeeId: e.employeeId, newValue: { reversalOf: e.id, amount: rev.netAmount.toString() }, reason }, tx);
      return rev;
    }
    const upd = await tx.commissionTransaction.update({ where: { id }, data: { status: 'REVERSED', notes: reason } });
    await audit.record(ctx, { action: 'COMMISSION_REVERSED', entityType: 'CommissionTransaction', entityId: id, employeeId: e.employeeId, before: e, after: upd, reason }, tx);
    return upd;
  });
};

const manualEntry = async (ctx, { employeeId, amount, reason, ruleId, earnedDate }) => {
  await assertEmployeeAccess(ctx, employeeId, 'commissions.create');
  if (ruleId && !(await prisma.commissionRule.count({ where: { id: ruleId, companyId: ctx.companyId } }))) throw badRequest('INVALID_REFERENCE', { field: 'ruleId' });
  const e = await prisma.commissionTransaction.create({
    data: { companyId: ctx.companyId, employeeId, ruleId: ruleId || null, entryType: 'ADJUSTMENT', grossAmount: amount, netAmount: amount, status: 'PENDING_APPROVAL', notes: reason, earnedDate: toDateOnly(earnedDate || new Date()), createdById: ctx.userId },
  });
  await audit.record(ctx, { action: 'COMMISSION_MANUAL_ENTRY', entityType: 'CommissionTransaction', entityId: e.id, employeeId, after: e, reason });
  return e;
};

module.exports = { createSource, updateSourceFlags, calculate, transition, bulkTransition, reverse, manualEntry };
