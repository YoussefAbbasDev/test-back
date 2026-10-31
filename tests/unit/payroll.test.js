import { describe, it, expect } from 'vitest';

const { calculate, segmentsFor } = require('../../src/engines/payroll');

const comp = (id, code, type, category, flags = {}) => ({ id, code, nameAr: code, nameEn: code, type, category, calculationMethod: 'EMPLOYEE_AMOUNT', prorate: true, status: 'ACTIVE', ...flags });
const components = [
  comp('b', 'BASIC', 'EARNING', 'BASIC', { includeInOvertimeBase: true, includeInGosiBase: true, includeInAbsenceBase: true }),
  comp('h', 'HOUSING', 'EARNING', 'HOUSING', { includeInGosiBase: true, includeInAbsenceBase: true }),
  comp('t', 'TRANSPORT', 'EARNING', 'TRANSPORT', { includeInAbsenceBase: true }),
  comp('ot', 'OVERTIME', 'EARNING', 'OVERTIME', { prorate: false, calculationMethod: 'SYSTEM' }),
  comp('cm', 'COMMISSION', 'EARNING', 'COMMISSION', { prorate: false, calculationMethod: 'SYSTEM' }),
  comp('ab', 'ABSENCE', 'DEDUCTION', 'ABSENCE', { prorate: false }),
  comp('ul', 'UNPAID_LEAVE', 'DEDUCTION', 'UNPAID_LEAVE', { prorate: false }),
  comp('lt', 'LATE', 'DEDUCTION', 'LATE', { prorate: false }),
  comp('gs', 'GOSI', 'DEDUCTION', 'GOSI', { prorate: false }),
  comp('ln', 'LOAN', 'DEDUCTION', 'LOAN', { prorate: false }),
  comp('ad', 'ADVANCE', 'DEDUCTION', 'ADVANCE', { prorate: false }),
];
const settings = {
  daysBasis: 'FIXED', fixedDaysPerMonth: 30, standardDailyHours: 8, overtimeBase: 'BASIC', overtimeRateWeekday: 1.5, overtimeRateWeekend: 2, overtimeRateHoliday: 2,
  absenceDeductionEnabled: true, absenceDeductionBase: 'FLAGGED_COMPONENTS', lateDeductionMode: 'NONE', lateFreeMinutesPerPeriod: 0, unpaidLeaveDeduction: true,
  roundingDecimals: 2, roundingMode: 'HALF_UP', maxDeductionPercent: null, gosiEmployeeRate: 0,
};
const rev = (from, basic, housing = 0, transport = 0) => ({ effectiveFrom: from, lines: [{ componentId: 'b', amount: basic }, { componentId: 'h', amount: housing }, { componentId: 't', amount: transport }] });
const base = (over = {}) => ({
  period: { start: '2026-10-01', end: '2026-10-31' }, settings, components, structureLines: [],
  employee: { hireDate: '2020-01-01', terminationDate: null, gosiApplicable: false, nationality: 'X', paymentMethod: 'BANK', iban: 'SA00' },
  revisions: [rev('2020-01-01', '6000', '1500', '600')], attendance: {}, leaves: [], commissions: [], adjustments: [], installments: [], ...over,
});
const amt = (r, code) => r.lines.filter((l) => l.code === code).reduce((s, l) => s + Number(l.amount), 0);

describe('payroll engine', () => {
  it('pays the full monthly salary for a full period', () => {
    const r = calculate(base());
    expect(r.gross.toFixed(2)).toBe('8100.00');
    expect(r.net.toFixed(2)).toBe('8100.00');
    expect(r.errors).toEqual([]);
  });

  it('prorates a mid-period hire on the 30-day basis', () => {
    const r = calculate(base({ employee: { ...base().employee, hireDate: '2026-10-16' } }));
    // employed 16 of 31 calendar days → 16/30 of monthly
    expect(amt(r, 'BASIC').toFixed(2)).toBe('3200.00');
  });

  it('splits a salary revision inside the period by calendar days', () => {
    const r = calculate(base({ revisions: [rev('2020-01-01', '3800'), rev('2026-10-15', '4300')] }));
    // 3800 × 14/31 + 4300 × 17/31
    expect(amt(r, 'BASIC').toFixed(2)).toBe('4074.19');
  });

  it('calculates approved overtime with day-type multipliers', () => {
    const r = calculate(base({ attendance: { overtime: { WORKDAY: 120, WEEKEND: 60 } } }));
    // hourly = 6000 / (30 × 8) = 25 → 2h × 1.5 × 25 + 1h × 2 × 25 = 75 + 50
    expect(amt(r, 'OVERTIME').toFixed(2)).toBe('125.00');
  });

  it('deducts absence using the flagged absence base', () => {
    const r = calculate(base({ attendance: { absentDays: 2, halfDays: 1 } }));
    // daily = 8100 / 30 = 270 → 2.5 days
    expect(amt(r, 'ABSENCE').toFixed(2)).toBe('675.00');
  });

  it('does not deduct lateness when the late policy is NONE', () => {
    const r = calculate(base({ attendance: { lateMinutes: 300 } }));
    expect(amt(r, 'LATE')).toBe(0);
  });

  it('deducts lateness per minute only beyond the free allowance', () => {
    const r = calculate(base({ settings: { ...settings, lateDeductionMode: 'PER_MINUTE', lateFreeMinutesPerPeriod: 60 }, attendance: { lateMinutes: 120 } }));
    // minute rate = 8100 / (30 × 8 × 60) = 0.5625 → 60 billable minutes
    expect(amt(r, 'LATE').toFixed(2)).toBe('33.75');
  });

  it('deducts unpaid and partially paid leave', () => {
    const r = calculate(base({ leaves: [{ days: 2, payPercent: 0, leaveTypeName: 'Unpaid' }, { days: 4, payPercent: 75, leaveTypeName: 'Sick' }] }));
    // 2 × 270 + 4 × 0.25 × 270
    expect(amt(r, 'UNPAID_LEAVE').toFixed(2)).toBe('810.00');
  });

  it('applies GOSI only to configured nationalities on flagged components', () => {
    const s = { ...settings, gosiEmployeeRate: 9.75, gosiNationalities: ['Saudi'] };
    const saudi = calculate(base({ settings: s, employee: { ...base().employee, gosiApplicable: true, nationality: 'Saudi' } }));
    expect(amt(saudi, 'GOSI').toFixed(2)).toBe('731.25'); // (6000 + 1500) × 9.75%
    const other = calculate(base({ settings: s, employee: { ...base().employee, gosiApplicable: true, nationality: 'Indian' } }));
    expect(amt(other, 'GOSI')).toBe(0);
  });

  it('caps installment deductions and reports the remainder instead of over-deducting', () => {
    const r = calculate(base({ settings: { ...settings, maxDeductionPercent: 10 }, installments: [{ id: 'i1', kind: 'LOAN', refId: 'L', due: '2000', label: 'L #1' }] }));
    expect(amt(r, 'LOAN').toFixed(2)).toBe('810.00'); // 10% of 8100
    expect(r.installmentsApplied[0].amount.toFixed(2)).toBe('810.00');
    expect(r.warnings.find((w) => w.code === 'INSTALLMENT_CAPPED')).toBeTruthy();
  });

  it('never deducts installments below zero net', () => {
    const r = calculate(base({ revisions: [rev('2020-01-01', '1000')], installments: [{ id: 'i1', kind: 'ADVANCE', refId: 'A', due: '5000', label: 'A #1' }] }));
    expect(r.net.toFixed(2)).toBe('0.00');
    expect(amt(r, 'ADVANCE').toFixed(2)).toBe('1000.00');
  });

  it('includes commissions and adjustments as earnings', () => {
    const r = calculate(base({ commissions: [{ id: 'c1', amount: '150.50', label: 'x' }], adjustments: [{ id: 'a1', type: 'EARNING', category: 'BONUS', amount: '500', reason: 'r' }, { id: 'a2', type: 'DEDUCTION', category: 'PENALTY', amount: '100', reason: 'p' }] }));
    expect(r.gross.toFixed(2)).toBe('8750.50');
    expect(r.deductions.toFixed(2)).toBe('100.00');
  });

  it('flags missing salary and negative net as errors', () => {
    expect(calculate(base({ revisions: [] })).errors).toContain('NO_ACTIVE_SALARY');
    const neg = calculate(base({ adjustments: [{ id: 'a', type: 'DEDUCTION', category: 'PENALTY', amount: '9000', reason: 'x' }] }));
    expect(neg.errors).toContain('NEGATIVE_NET');
  });

  it('uses only decimal arithmetic (no float drift)', () => {
    const r = calculate(base({ revisions: [rev('2020-01-01', '0.1', '0.2')] }));
    expect(r.gross.toFixed(2)).toBe('0.30');
  });

  it('segments: employment ending mid-period', () => {
    const s = segmentsFor({ period: { start: '2026-10-01', end: '2026-10-31' }, hireDate: '2020-01-01', terminationDate: '2026-10-10', revisions: [rev('2020-01-01', '3000')], settings });
    expect(s.employedFraction.toFixed(4)).toBe('0.3333');
  });
});
