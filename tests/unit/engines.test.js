import { describe, it, expect } from 'vitest';

const leave = require('../../src/engines/leave');
const att = require('../../src/engines/attendance');
const comm = require('../../src/engines/commission');
const { buildSchedule } = require('../../src/engines/installments');
const formula = require('../../src/engines/formula');
const { toDateOnly } = require('../../src/utils/dates');

const policy = { graceMinutes: 10, lateCountFromShiftStart: true, earlyLeaveGraceMinutes: 5, overtimeEnabled: true, overtimeMinMinutes: 30, weekendWorkIsOvertime: true, holidayWorkIsOvertime: true };
const ev = (type, iso, extra = {}) => ({ type, occurredAt: new Date(iso), method: 'GPS', ...extra });

describe('leave engine', () => {
  it('excludes weekends and holidays per policy', () => {
    // 2026-10-04 (Sun) → 2026-10-10 (Sat); weekend Fri/Sat; holiday on Tue 6th
    const days = leave.countLeaveDays({ start: '2026-10-04', end: '2026-10-10', weekendDays: [5, 6], holidays: new Set(['2026-10-06']) });
    expect(days.toNumber()).toBe(4);
    const all = leave.countLeaveDays({ start: '2026-10-04', end: '2026-10-10', weekendDays: [5, 6], holidays: new Set(['2026-10-06']), countWeekends: true, countHolidays: true });
    expect(all.toNumber()).toBe(7);
  });
  it('supports half days', () => {
    expect(leave.countLeaveDays({ start: '2026-10-05', end: '2026-10-05', halfDay: true, weekendDays: [5, 6] }).toNumber()).toBe(0.5);
  });
  it('accrues upfront with first-year proration', () => {
    expect(leave.accruedFor({ entitlement: 21, method: 'UPFRONT', hireDate: '2020-01-01', year: 2026, asOf: '2026-03-01' }).toNumber()).toBe(21);
    const prorated = leave.accruedFor({ entitlement: 21, method: 'UPFRONT', hireDate: '2026-07-01', year: 2026, asOf: '2026-07-01' });
    expect(prorated.toNumber()).toBeCloseTo((21 * 184) / 365, 2);
  });
  it('accrues monthly per completed month and respects max balance', () => {
    expect(leave.accruedFor({ entitlement: 24, method: 'MONTHLY', hireDate: '2020-01-01', year: 2026, asOf: '2026-03-31' }).toNumber()).toBe(6);
    expect(leave.accruedFor({ entitlement: 24, method: 'MONTHLY', hireDate: '2020-01-01', year: 2026, asOf: '2026-12-31', maxBalance: 15 }).toNumber()).toBe(15);
  });
  it('balance formula keeps pending separate from used', () => {
    const b = { openingBalance: 2, accrued: 21, adjustments: 1, carriedForward: 5, used: 10, pending: 3 };
    expect(leave.currentBalance(b).toNumber()).toBe(19);
    expect(leave.availableBalance(b).toNumber()).toBe(16);
    expect(leave.carryForwardAmount(b, 10).toNumber()).toBe(10);
    expect(leave.carryForwardAmount(b, null).toNumber()).toBe(0);
  });
});

describe('attendance engine', () => {
  const schedule = { start: new Date('2026-10-05T05:00:00Z'), end: new Date('2026-10-05T14:00:00Z'), expectedMinutes: 480 };
  it('computes late, worked, breaks and overtime', () => {
    const r = att.computeRecord({
      policy, schedule, dayType: 'WORKDAY',
      events: [ev('CHECK_IN', '2026-10-05T05:20:00Z'), ev('BREAK_START', '2026-10-05T09:00:00Z'), ev('BREAK_END', '2026-10-05T10:00:00Z'), ev('CHECK_OUT', '2026-10-05T15:00:00Z')],
    });
    expect(r.lateMinutes).toBe(20);
    expect(r.breakMinutes).toBe(60);
    expect(r.workedMinutes).toBe(520);
    expect(r.overtimeMinutes).toBe(40);
    expect(r.status).toBe('LATE');
  });
  it('treats arrival within grace as on time and ignores voided events', () => {
    const r = att.computeRecord({ policy, schedule, events: [ev('CHECK_IN', '2026-10-05T04:30:00Z', { isVoided: true }), ev('CHECK_IN', '2026-10-05T05:08:00Z'), ev('CHECK_OUT', '2026-10-05T14:00:00Z')] });
    expect(r.lateMinutes).toBe(0);
    expect(r.status).toBe('PRESENT');
  });
  it('detects early leave and incomplete sessions', () => {
    const early = att.computeRecord({ policy, schedule, events: [ev('CHECK_IN', '2026-10-05T05:00:00Z'), ev('CHECK_OUT', '2026-10-05T13:00:00Z')] });
    expect(early.earlyLeaveMinutes).toBe(60);
    const open = att.computeRecord({ policy, schedule, events: [ev('CHECK_IN', '2026-10-05T05:00:00Z')] });
    expect(open.status).toBe('INCOMPLETE');
  });
  it('counts all weekend work as overtime when the policy says so', () => {
    const r = att.computeRecord({ policy, schedule: null, dayType: 'WEEKEND', events: [ev('CHECK_IN', '2026-10-09T05:00:00Z'), ev('CHECK_OUT', '2026-10-09T09:00:00Z')] });
    expect(r.overtimeMinutes).toBe(240);
  });
  it('builds shift windows across midnight in company timezone', () => {
    const w = att.shiftWindow({ startTime: '22:00', endTime: '06:00' }, toDateOnly('2026-10-05'), 'Asia/Riyadh');
    expect(w.start.toISOString()).toBe('2026-10-05T19:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-06T03:00:00.000Z');
    expect(att.overlaps(w.start, w.end, new Date('2026-10-06T02:00:00Z'), new Date('2026-10-06T10:00:00Z'))).toBe(true);
    expect(att.overlaps(w.start, w.end, new Date('2026-10-06T03:00:00Z'), new Date('2026-10-06T10:00:00Z'))).toBe(false);
  });
  it('allows only valid next punches', () => {
    expect(att.nextAllowed([]).checkIn).toBe(true);
    const a = att.nextAllowed([ev('CHECK_IN', '2026-10-05T05:00:00Z')]);
    expect(a.checkIn).toBe(false);
    expect(a.breakStart).toBe(true);
  });
  it('measures distance and geofence', () => {
    expect(att.haversine(24.7136, 46.6753, 24.7136, 46.6753)).toBe(0);
    const near = att.nearestLocation(24.7140, 46.6753, [{ id: 'x', latitude: 24.7136, longitude: 46.6753, radiusMeters: 100 }]);
    expect(near.inside).toBe(true);
    const far = att.nearestLocation(24.80, 46.6753, [{ id: 'x', latitude: 24.7136, longitude: 46.6753, radiusMeters: 100 }]);
    expect(far.inside).toBe(false);
  });
  it('flags impossible travel', () => {
    expect(att.impossibleTravel({ latitude: 24.7, longitude: 46.6, occurredAt: '2026-10-05T05:00:00Z' }, { latitude: 21.5, longitude: 39.1, occurredAt: '2026-10-05T05:30:00Z' })).toBe(true);
  });
});

describe('commission engine', () => {
  const tiers = [{ fromAmount: 0, toAmount: 10000, rate: 2 }, { fromAmount: 10000, toAmount: 20000, rate: 3 }, { fromAmount: 20000, toAmount: null, rate: 5 }];
  it('tiered: whole amount vs incremental are different and explicit', () => {
    expect(comm.tieredAmount(25000, tiers, 'WHOLE_AMOUNT').toNumber()).toBe(1250);
    expect(comm.tieredAmount(25000, tiers, 'INCREMENTAL').toNumber()).toBe(200 + 300 + 250);
    expect(() => comm.tieredAmount(25000, tiers, null)).toThrow();
  });
  it('validates distribution totals 100%', () => {
    expect(comm.validateDistribution([{ sharePercent: 50 }, { sharePercent: 30 }, { sharePercent: 20 }])).toBe(true);
    expect(() => comm.validateDistribution([{ sharePercent: 50 }, { sharePercent: 30 }])).toThrow();
  });
  it('splits a 10,000 job 50/30/20', () => {
    const rule = { type: 'PERCENT_SALES', calculationBase: 'SALES_AMOUNT', value: 5 };
    const src = { salesAmount: 10000 };
    expect([50, 30, 20].map((s) => comm.perTransactionAmount(rule, src, s).toNumber())).toEqual([250, 150, 100]);
  });
  it('target rules pay nothing below target and cap above max', () => {
    const rule = { type: 'TARGET', calculationBase: 'SALES_AMOUNT', value: 10, minTarget: 5000, maxTarget: 20000, maxCommission: null };
    expect(comm.perPeriodAmount(rule, 4000).toNumber()).toBe(0);
    expect(comm.perPeriodAmount(rule, 30000).toNumber()).toBe(2000);
  });
  it('checks eligibility conditions', () => {
    const rule = { conditions: { requireQuality: true, requireCollection: true } };
    expect(comm.isEligible(rule, { isCompleted: true, qualityApproved: true, invoiceCollected: true }, { status: 'ACTIVE' }).eligible).toBe(true);
    const r = comm.isEligible(rule, { isCompleted: true, qualityApproved: false, invoiceCollected: true, isRefunded: true }, { status: 'TERMINATED' });
    expect(r.reasons).toEqual(expect.arrayContaining(['QUALITY_NOT_APPROVED', 'REFUNDED', 'EMPLOYEE_INACTIVE']));
  });
  it('enforces lifecycle transitions', () => {
    expect(comm.canTransition('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(comm.canTransition('PAID', 'APPROVED')).toBe(false);
    expect(comm.canTransition('INCLUDED_IN_PAYROLL', 'CANCELLED')).toBe(false);
  });
});

describe('installments', () => {
  it('schedule always sums to the total and the last installment absorbs rounding', () => {
    const s = buildSchedule({ total: '1000', count: 3, firstDate: '2026-10-27' });
    expect(s.map((x) => x.amount.toFixed(2))).toEqual(['333.33', '333.33', '333.34']);
    expect(s[2].dueDate.toISOString().slice(0, 10)).toBe('2026-12-27');
  });
  it('derives count from monthly amount', () => {
    const s = buildSchedule({ total: '12000', monthlyAmount: '5000', firstDate: '2026-10-27' });
    expect(s.map((x) => x.amount.toFixed(2))).toEqual(['5000.00', '5000.00', '2000.00']);
  });
});

describe('safe formula evaluator', () => {
  it('evaluates arithmetic, variables and functions', () => {
    expect(formula.evaluate('BASIC * 0.25 + max(100, TRANSPORT)', { BASIC: 4000, TRANSPORT: 50 }).toNumber()).toBe(1100);
    expect(formula.evaluate('round(10 / 3, 2)').toNumber()).toBe(3.33);
    expect(formula.evaluate('if(SERVICE_YEARS - 5, 1000, 0)', { SERVICE_YEARS: 6 }).toNumber()).toBe(1000);
  });
  it('rejects code injection and unknown identifiers', () => {
    expect(() => formula.evaluate('process.exit(1)')).toThrow();
    expect(() => formula.evaluate('constructor("return 1")()')).toThrow();
    expect(() => formula.evaluate("1; DROP TABLE users")).toThrow();
    expect(() => formula.validateFormula('BASIC * FOO', ['BASIC'])).toThrow();
  });
});
