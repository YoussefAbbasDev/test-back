// Pure commission calculations — unit tested in tests/unit/commission.test.js
const { D } = require('../utils/money');
const { badRequest } = require('../utils/errors');

/**
 * Tiered commission.
 *  WHOLE_AMOUNT: the rate of the tier the total falls into applies to the whole amount.
 *  INCREMENTAL: each tier's rate applies only to the slice of the amount inside that tier.
 * tiers: [{ fromAmount, toAmount|null, rate }] (rate in %)
 */
const tieredAmount = (amount, tiers, mode) => {
  if (!mode) throw badRequest('TIER_MODE_REQUIRED');
  if (!tiers?.length) throw badRequest('TIERS_REQUIRED');
  const base = D(amount);
  const sorted = [...tiers].sort((a, b) => D(a.fromAmount).comparedTo(D(b.fromAmount)));
  if (mode === 'WHOLE_AMOUNT') {
    const tier = [...sorted].reverse().find((t) => base.greaterThanOrEqualTo(D(t.fromAmount)));
    return tier ? base.times(D(tier.rate)).dividedBy(100) : D(0);
  }
  let total = D(0);
  for (const t of sorted) {
    const from = D(t.fromAmount);
    const to = t.toAmount != null ? D(t.toAmount) : null;
    if (base.lessThanOrEqualTo(from)) break;
    const upper = to && base.greaterThan(to) ? to : base;
    total = total.plus(upper.minus(from).times(D(t.rate)).dividedBy(100));
  }
  return total;
};

// Tier ranges must be ordered and non-overlapping
const validateTiers = (tiers) => {
  const sorted = [...tiers].sort((a, b) => Number(a.fromAmount) - Number(b.fromAmount));
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.toAmount != null && Number(t.toAmount) <= Number(t.fromAmount)) throw badRequest('VALIDATION_FAILED');
    const next = sorted[i + 1];
    if (next && (t.toAmount == null || Number(next.fromAmount) < Number(t.toAmount))) throw badRequest('VALIDATION_FAILED');
  }
  return sorted;
};

const validateDistribution = (participants) => {
  const total = participants.reduce((s, p) => s.plus(D(p.sharePercent)), D(0));
  if (!total.minus(100).abs().lessThanOrEqualTo(0.0001)) throw badRequest('DISTRIBUTION_NOT_100', { total: total.toFixed(2) });
  return true;
};

const baseOf = (rule, src) => {
  switch (rule.calculationBase) {
    case 'SALES_AMOUNT': return D(src.salesAmount);
    case 'COLLECTED_AMOUNT': return D(src.collectedAmount);
    case 'NET_PROFIT': return D(src.netProfit);
    case 'TASK_COUNT': return D(src.taskCount);
    default: return D(1);
  }
};

const DEFAULT_CONDITIONS = { requireCompleted: true, excludeCancelled: true, excludeRefunded: true, requireActiveEmployee: true };

// Eligibility of a source transaction for a rule (and an employee)
const isEligible = (rule, src, employee) => {
  const c = { ...DEFAULT_CONDITIONS, ...(rule.conditions || {}) };
  const reasons = [];
  if (c.requireCompleted && !src.isCompleted) reasons.push('NOT_COMPLETED');
  if ((c.requireQuality || rule.requiresQuality) && !src.qualityApproved) reasons.push('QUALITY_NOT_APPROVED');
  if (c.requireInvoice && !src.invoiceIssued) reasons.push('NO_INVOICE');
  if ((c.requireCollection || rule.requiresCollection) && !src.invoiceCollected) reasons.push('NOT_COLLECTED');
  if (c.excludeCancelled && src.isCancelled) reasons.push('CANCELLED');
  if (c.excludeRefunded && src.isRefunded) reasons.push('REFUNDED');
  if (c.requireActiveEmployee && employee && !['ACTIVE', 'PROBATION', 'ON_LEAVE'].includes(employee.status)) reasons.push('EMPLOYEE_INACTIVE');
  return { eligible: reasons.length === 0, reasons };
};

const PER_TRANSACTION = ['FIXED_PER_SERVICE', 'PERCENT_SALES', 'PERCENT_COLLECTED', 'PERCENT_NET_PROFIT', 'PER_TASK', 'TEAM', 'SUPERVISOR'];
const PER_PERIOD = ['TARGET', 'TIERED', 'BRANCH_MANAGER', 'MONTHLY_BONUS', 'PERFORMANCE_BONUS'];

// Gross commission for one participant of one transaction (before cap)
const perTransactionAmount = (rule, src, sharePercent) => {
  const share = D(sharePercent).dividedBy(100);
  let gross;
  switch (rule.type) {
    case 'FIXED_PER_SERVICE': gross = D(rule.value); break;
    case 'PER_TASK': gross = D(rule.value).times(src.taskCount || 1); break;
    default: gross = baseOf(rule, src).times(D(rule.value)).dividedBy(100);
  }
  return applyCap(rule, gross.times(share));
};

// Period rules on an aggregated base (sum of eligible bases in the month)
const perPeriodAmount = (rule, aggregatedBase, tiers) => {
  const base = D(aggregatedBase);
  if (rule.type === 'TIERED') return applyCap(rule, tieredAmount(base, tiers, rule.tierMode));
  if (rule.type === 'MONTHLY_BONUS' || rule.type === 'PERFORMANCE_BONUS') return applyCap(rule, D(rule.value));
  if (rule.minTarget != null && base.lessThan(D(rule.minTarget))) return D(0);
  const capped = rule.maxTarget != null && base.greaterThan(D(rule.maxTarget)) ? D(rule.maxTarget) : base;
  const amount = rule.calculationBase === 'FIXED' ? D(rule.value) : capped.times(D(rule.value)).dividedBy(100);
  return applyCap(rule, amount);
};

const applyCap = (rule, amount) => (rule.maxCommission != null && amount.greaterThan(D(rule.maxCommission)) ? D(rule.maxCommission) : amount).toDecimalPlaces(2);

// Rule applicability to an employee / transaction
const applies = (rule, employee, src) => {
  const inList = (list, v) => !Array.isArray(list) || !list.length || list.includes(v);
  return inList(rule.employeeIds, employee.id) && inList(rule.positionIds, employee.positionId) && inList(rule.departmentIds, employee.departmentId)
    && inList(rule.branchIds, src?.branchId ?? employee.branchId)
    && (!rule.serviceCategory || !src || rule.serviceCategory === src.serviceCategory) && (!rule.serviceCode || !src || rule.serviceCode === src.serviceCode);
};

const TRANSITIONS = {
  DRAFT: ['CALCULATED', 'CANCELLED'],
  CALCULATED: ['PENDING_APPROVAL', 'APPROVED', 'ON_HOLD', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'ON_HOLD', 'CANCELLED'],
  APPROVED: ['PAYABLE', 'ON_HOLD', 'REVERSED'],
  ON_HOLD: ['APPROVED', 'CANCELLED'],
  PAYABLE: ['ON_HOLD', 'REVERSED'],
  INCLUDED_IN_PAYROLL: ['PAID'],
  PAID: [],
  REVERSED: [],
  CANCELLED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

module.exports = { tieredAmount, validateTiers, validateDistribution, isEligible, perTransactionAmount, perPeriodAmount, applies, baseOf, canTransition, TRANSITIONS, PER_TRANSACTION, PER_PERIOD };
