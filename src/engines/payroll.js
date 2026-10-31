// Pure payroll calculation for one employee and one period. All money math uses decimal.js.
// Input is fully pre-fetched by the payroll service so this module is deterministic and unit-testable.
const { D, round, sum } = require('../utils/money');
const { toDateOnly, daysBetweenInclusive, fmtDate, addDays } = require('../utils/dates');
const formula = require('./formula');

const EARNING_ORDER = { BASIC: 1, HOUSING: 2, TRANSPORT: 3, ALLOWANCE: 4, VARIABLE_ALLOWANCE: 5, OVERTIME: 6, COMMISSION: 7, BONUS: 8, OTHER_EARNING: 9 };
const DEDUCTION_ORDER = { ABSENCE: 20, LATE: 21, EARLY_LEAVE: 22, UNPAID_LEAVE: 23, GOSI: 24, PENALTY: 25, OTHER_DEDUCTION: 26, ADVANCE: 27, LOAN: 28 };

/**
 * Splits the employment window inside the period into salary-revision segments.
 * Returns { employedFraction, segments: [{ revision, from, to, days, fraction }], employedDays, periodDays, basisDays }
 */
const segmentsFor = ({ period, hireDate, terminationDate, revisions, settings }) => {
  const pStart = toDateOnly(period.start);
  const pEnd = toDateOnly(period.end);
  const periodDays = daysBetweenInclusive(pStart, pEnd);
  const basisDays = settings.daysBasis === 'CALENDAR' ? periodDays : Number(settings.fixedDaysPerMonth || 30);
  const wStart = hireDate && toDateOnly(hireDate) > pStart ? toDateOnly(hireDate) : pStart;
  const wEnd = terminationDate && toDateOnly(terminationDate) < pEnd ? toDateOnly(terminationDate) : pEnd;
  if (wEnd < wStart) return { employedFraction: D(0), segments: [], employedDays: 0, periodDays, basisDays };
  const employedDays = daysBetweenInclusive(wStart, wEnd);
  const fullPeriod = employedDays === periodDays;
  const employedFraction = fullPeriod ? D(1) : D(Math.min(employedDays, basisDays)).dividedBy(basisDays);

  const sorted = [...revisions].sort((a, b) => toDateOnly(a.effectiveFrom) - toDateOnly(b.effectiveFrom));
  const segments = [];
  for (let i = 0; i < sorted.length; i++) {
    const rev = sorted[i];
    const from = toDateOnly(rev.effectiveFrom) > wStart ? toDateOnly(rev.effectiveFrom) : wStart;
    const nextStart = sorted[i + 1] ? addDays(toDateOnly(sorted[i + 1].effectiveFrom), -1) : wEnd;
    const to = nextStart < wEnd ? nextStart : wEnd;
    if (to < from) continue;
    const days = daysBetweenInclusive(from, to);
    segments.push({ revision: rev, from, to, days, fraction: employedFraction.times(days).dividedBy(employedDays) });
  }
  return { employedFraction, segments, employedDays, periodDays, basisDays };
};

/**
 * calculate(input) → { lines, gross, deductions, net, stats, warnings, errors, installmentsApplied }
 * input = {
 *   period: { start, end }, settings, employee: { hireDate, terminationDate, gosiApplicable, nationality, paymentMethod, iban },
 *   components: [SalaryComponent], structureLines: [{ component, calculationMethod, value, baseComponentCode, formula }],
 *   revisions: [{ effectiveFrom, lines: [{ componentId, amount }] }],
 *   attendance: { presentDays, absentDays, halfDays, lateMinutes, earlyMinutes, workedMinutes, overtime: { WORKDAY, WEEKEND, HOLIDAY }, pendingOvertimeRecords, incompleteRecords },
 *   leaves: [{ days, payPercent, leaveTypeName }],
 *   commissions: [{ id, amount, label }], adjustments: [{ id, type, category, amount, reason }],
 *   installments: [{ id, kind, refId, due, label }]
 * }
 */
const calculate = (input) => {
  const { period, settings, employee } = input;
  const dp = Number(settings.roundingDecimals ?? 2);
  const rmode = settings.roundingMode || 'HALF_UP';
  const r = (v) => round(v, dp, rmode);
  const warnings = [];
  const errors = [];
  const lines = [];
  const compById = new Map(input.components.map((c) => [c.id, c]));
  const compByCode = new Map(input.components.map((c) => [c.code, c]));
  const sysComp = (category) => input.components.find((c) => c.category === category && c.status !== 'INACTIVE');
  const push = (line) => {
    const amount = r(line.amount);
    if (amount.isZero()) return;
    lines.push({ ...line, amount });
  };

  if (!input.revisions.length) errors.push('NO_ACTIVE_SALARY');
  const seg = segmentsFor({ period, hireDate: employee.hireDate, terminationDate: employee.terminationDate, revisions: input.revisions, settings });
  if (input.revisions.length && !seg.segments.length) errors.push('NOT_EMPLOYED_IN_PERIOD');
  const att = input.attendance || {};
  const otMinutes = att.overtime || {};
  const totalOtHours = D((otMinutes.WORKDAY || 0) + (otMinutes.WEEKEND || 0) + (otMinutes.HOLIDAY || 0)).dividedBy(60);

  // ── Fixed & structure earnings/deductions, per revision segment ──
  const fixedTotals = new Map(); // code → { comp, amount, fullAmount }
  const add = (comp, amount, fullAmount) => {
    const cur = fixedTotals.get(comp.code) || { comp, amount: D(0), fullAmount: D(0) };
    cur.amount = cur.amount.plus(amount);
    cur.fullAmount = fullAmount;
    fixedTotals.set(comp.code, cur);
  };
  for (const s of seg.segments) {
    const monthly = new Map(); // code → monthly amount for this segment (before proration)
    for (const l of s.revision.lines) {
      const c = compById.get(l.componentId);
      if (c) monthly.set(c.code, D(l.amount));
    }
    const basic = monthly.get(sysComp('BASIC')?.code) || D(0);
    const vars = () => ({
      ...Object.fromEntries([...monthly.entries()]), BASIC: basic, GROSS_FIXED: sum([...monthly.entries()].filter(([code]) => compByCode.get(code)?.type === 'EARNING'), ([, v]) => v),
      PERIOD_DAYS: seg.basisDays, PAID_DAYS: D(seg.basisDays).times(seg.employedFraction), PRESENT_DAYS: att.presentDays || 0, ABSENT_DAYS: att.absentDays || 0,
      WORKED_HOURS: D(att.workedMinutes || 0).dividedBy(60), OT_HOURS: totalOtHours, LATE_MINUTES: att.lateMinutes || 0, SERVICE_YEARS: input.serviceYears || 0,
    });
    // structure lines fill components the employee does not have a personal amount for
    for (const sl of input.structureLines || []) {
      const c = sl.component;
      if (monthly.has(c.code) || c.status === 'INACTIVE') continue;
      const method = sl.calculationMethod || c.calculationMethod;
      const value = D(sl.value ?? c.value ?? 0);
      let amt = null;
      if (method === 'FIXED') amt = value;
      else if (method === 'PERCENT_OF_BASIC') amt = basic.times(value).dividedBy(100);
      else if (method === 'PERCENT_OF_COMPONENT') amt = (monthly.get(sl.baseComponentCode || c.baseComponentCode) || D(0)).times(value).dividedBy(100);
      else if (method === 'FORMULA') amt = formula.evaluate(sl.formula || c.formula, vars());
      else if (method === 'HOURLY') amt = value.times(D(att.workedMinutes || 0).dividedBy(60)).dividedBy(seg.segments.length); // usage-based, split evenly across segments
      else if (method === 'WORKING_DAYS' || method === 'ATTENDANCE_BASED') amt = value.times(att.presentDays || 0).dividedBy(seg.segments.length);
      if (amt !== null) monthly.set(c.code, amt);
    }
    for (const [code, amt] of monthly.entries()) {
      const c = compByCode.get(code);
      if (!c) continue;
      const usage = ['HOURLY', 'WORKING_DAYS', 'ATTENDANCE_BASED'].includes(c.calculationMethod);
      const prorated = c.prorate && !usage ? amt.times(s.fraction) : usage ? amt : amt.times(s.fraction.greaterThan(0) ? D(1).dividedBy(seg.segments.length) : 0);
      add(c, prorated, amt);
    }
  }
  for (const { comp, amount } of fixedTotals.values()) {
    push({ componentId: comp.id, code: comp.code, nameAr: comp.nameAr, nameEn: comp.nameEn, type: comp.type, category: comp.category, amount, sourceType: 'SALARY', sortOrder: (comp.type === 'EARNING' ? EARNING_ORDER : DEDUCTION_ORDER)[comp.category] || comp.sortOrder || 50 });
  }

  // monthly bases (latest segment) for rates
  const last = seg.segments[seg.segments.length - 1];
  const latestMonthly = (flag) => {
    if (!last) return D(0);
    let total = D(0);
    for (const l of last.revision.lines) {
      const c = compById.get(l.componentId);
      if (c && c.type === 'EARNING' && c[flag]) total = total.plus(l.amount);
    }
    return total;
  };
  const basicMonthly = (() => {
    if (!last) return D(0);
    const bc = sysComp('BASIC');
    const l = last.revision.lines.find((x) => compById.get(x.componentId)?.code === bc?.code);
    return l ? D(l.amount) : D(0);
  })();
  const dailyHours = D(settings.standardDailyHours || 8);
  const basis = D(seg.basisDays);
  const absenceBase = settings.absenceDeductionBase === 'BASIC' ? basicMonthly : latestMonthly('includeInAbsenceBase').greaterThan(0) ? latestMonthly('includeInAbsenceBase') : basicMonthly;
  const dailyRate = basis.isZero() ? D(0) : absenceBase.dividedBy(basis);
  const otBase = settings.overtimeBase === 'FLAGGED_COMPONENTS' && latestMonthly('includeInOvertimeBase').greaterThan(0) ? latestMonthly('includeInOvertimeBase') : basicMonthly;
  const hourlyRate = basis.isZero() ? D(0) : otBase.dividedBy(basis.times(dailyHours));
  const line = (category, extra) => {
    const c = sysComp(category);
    return { componentId: c?.id || null, code: c?.code || category, nameAr: c?.nameAr || category, nameEn: c?.nameEn || category, type: c?.type || extra.type, category, sortOrder: (EARNING_ORDER[category] || DEDUCTION_ORDER[category] || 50), ...extra };
  };

  // ── Overtime (approved minutes only) ──
  for (const [dayType, rateKey] of [['WORKDAY', 'overtimeRateWeekday'], ['WEEKEND', 'overtimeRateWeekend'], ['HOLIDAY', 'overtimeRateHoliday']]) {
    const minutes = otMinutes[dayType] || 0;
    if (!minutes) continue;
    const hours = D(minutes).dividedBy(60);
    const rate = hourlyRate.times(settings[rateKey] || 1.5);
    push(line('OVERTIME', { type: 'EARNING', amount: hours.times(rate), quantity: hours.toDecimalPlaces(4), rate: rate.toDecimalPlaces(4), sourceType: 'ATTENDANCE', meta: { dayType, multiplier: String(settings[rateKey]) } }));
  }
  if (att.pendingOvertimeRecords) warnings.push({ code: 'OVERTIME_PENDING_APPROVAL', count: att.pendingOvertimeRecords });
  if (att.incompleteRecords) warnings.push({ code: 'INCOMPLETE_ATTENDANCE', count: att.incompleteRecords });

  // ── Commissions & adjustments (earnings) ──
  for (const c of input.commissions || []) {
    push(line('COMMISSION', { type: 'EARNING', amount: D(c.amount), sourceType: 'COMMISSION', sourceId: c.id, meta: { label: c.label } }));
  }
  for (const a of (input.adjustments || []).filter((x) => x.type === 'EARNING')) {
    push(line(a.category || 'OTHER_EARNING', { type: 'EARNING', amount: D(a.amount), sourceType: 'ADJUSTMENT', sourceId: a.id, meta: { reason: a.reason } }));
  }

  const gross = sum(lines.filter((l) => l.type === 'EARNING'), (l) => l.amount);

  // ── Attendance & leave deductions ──
  const absentDays = D(att.absentDays || 0).plus(D(att.halfDays || 0).times(0.5));
  if (settings.absenceDeductionEnabled && absentDays.greaterThan(0)) {
    push(line('ABSENCE', { type: 'DEDUCTION', amount: dailyRate.times(absentDays), quantity: absentDays, rate: dailyRate.toDecimalPlaces(4), sourceType: 'ATTENDANCE' }));
  }
  if (settings.lateDeductionMode === 'PER_MINUTE' && (att.lateMinutes || 0) > (settings.lateFreeMinutesPerPeriod || 0)) {
    const billable = D(att.lateMinutes).minus(settings.lateFreeMinutesPerPeriod || 0);
    const minuteRate = basis.isZero() ? D(0) : absenceBase.dividedBy(basis.times(dailyHours).times(60));
    push(line('LATE', { type: 'DEDUCTION', amount: billable.times(minuteRate), quantity: billable, rate: minuteRate.toDecimalPlaces(6), sourceType: 'ATTENDANCE' }));
  }
  if (settings.earlyLeaveDeduction && (att.earlyMinutes || 0) > 0) {
    const minuteRate = basis.isZero() ? D(0) : absenceBase.dividedBy(basis.times(dailyHours).times(60));
    push(line('EARLY_LEAVE', { type: 'DEDUCTION', amount: D(att.earlyMinutes).times(minuteRate), quantity: D(att.earlyMinutes), rate: minuteRate.toDecimalPlaces(6), sourceType: 'ATTENDANCE' }));
  }
  let unpaidDays = D(0);
  if (settings.unpaidLeaveDeduction) {
    for (const lv of input.leaves || []) {
      const unpaidShare = D(100).minus(lv.payPercent ?? 100).dividedBy(100);
      if (unpaidShare.lessThanOrEqualTo(0)) continue;
      const days = D(lv.days).times(unpaidShare);
      unpaidDays = unpaidDays.plus(days);
      push(line('UNPAID_LEAVE', { type: 'DEDUCTION', amount: dailyRate.times(days), quantity: days, rate: dailyRate.toDecimalPlaces(4), sourceType: 'LEAVE', meta: { leaveType: lv.leaveTypeName, payPercent: String(lv.payPercent) } }));
    }
  }

  // ── Statutory (GOSI) — company-configured rates ──
  const gosiRate = D(settings.gosiEmployeeRate || 0);
  const gosiNat = settings.gosiNationalities;
  if (employee.gosiApplicable && gosiRate.greaterThan(0) && (!gosiNat?.length || gosiNat.includes(employee.nationality))) {
    const base = sum([...fixedTotals.values()].filter((x) => x.comp.includeInGosiBase), (x) => x.amount);
    push(line('GOSI', { type: 'DEDUCTION', amount: base.times(gosiRate).dividedBy(100), quantity: base, rate: gosiRate, sourceType: 'STATUTORY' }));
  }
  for (const a of (input.adjustments || []).filter((x) => x.type === 'DEDUCTION')) {
    push(line(a.category || 'OTHER_DEDUCTION', { type: 'DEDUCTION', amount: D(a.amount), sourceType: 'ADJUSTMENT', sourceId: a.id, meta: { reason: a.reason } }));
  }

  // ── Loan / advance installments, capped (never over-deduct; remainder stays on the installment) ──
  const installmentsApplied = [];
  let deductionsSoFar = sum(lines.filter((l) => l.type === 'DEDUCTION'), (l) => l.amount);
  const capPct = settings.maxDeductionPercent != null ? D(settings.maxDeductionPercent) : null;
  let capLeft = capPct ? r(gross.times(capPct).dividedBy(100)) : null;
  for (const inst of input.installments || []) {
    let allowed = D(inst.due);
    const netRoom = gross.minus(deductionsSoFar);
    if (netRoom.lessThan(allowed)) allowed = netRoom;
    if (capLeft !== null && capLeft.lessThan(allowed)) allowed = capLeft;
    allowed = r(allowed.greaterThan(0) ? allowed : 0);
    if (allowed.lessThan(D(inst.due))) warnings.push({ code: 'INSTALLMENT_CAPPED', installmentId: inst.id, due: D(inst.due).toFixed(2), deducted: allowed.toFixed(2) });
    if (allowed.isZero()) continue;
    push(line(inst.kind === 'LOAN' ? 'LOAN' : 'ADVANCE', { type: 'DEDUCTION', amount: allowed, sourceType: inst.kind, sourceId: inst.id, meta: { label: inst.label, refId: inst.refId, due: D(inst.due).toFixed(2) } }));
    installmentsApplied.push({ id: inst.id, kind: inst.kind, refId: inst.refId, amount: allowed });
    deductionsSoFar = deductionsSoFar.plus(allowed);
    if (capLeft !== null) capLeft = capLeft.minus(allowed);
  }

  const deductions = sum(lines.filter((l) => l.type === 'DEDUCTION'), (l) => l.amount);
  const net = gross.minus(deductions);
  if (net.lessThan(0)) errors.push('NEGATIVE_NET');
  if (employee.paymentMethod === 'BANK' && !employee.iban) warnings.push({ code: 'MISSING_IBAN' });

  lines.sort((a, b) => (a.type === b.type ? a.sortOrder - b.sortOrder : a.type === 'EARNING' ? -1 : 1));
  const basicLine = lines.find((l) => l.category === 'BASIC');
  return {
    lines,
    gross: r(gross),
    deductions: r(deductions),
    net: r(net),
    stats: {
      periodDays: seg.basisDays, paidDays: D(seg.basisDays).times(seg.employedFraction).minus(absentDays).minus(unpaidDays).toDecimalPlaces(2),
      absentDays, unpaidLeaveDays: unpaidDays, lateMinutes: att.lateMinutes || 0,
      overtimeMinutes: (otMinutes.WORKDAY || 0) + (otMinutes.WEEKEND || 0) + (otMinutes.HOLIDAY || 0), basicSalary: basicLine ? basicLine.amount : D(0),
      dailyRate: dailyRate.toDecimalPlaces(4), hourlyRate: hourlyRate.toDecimalPlaces(4), segments: seg.segments.map((s) => ({ from: fmtDate(s.from), to: fmtDate(s.to), fraction: s.fraction.toDecimalPlaces(6).toString() })),
    },
    warnings,
    errors,
    installmentsApplied,
  };
};

module.exports = { calculate, segmentsFor };
