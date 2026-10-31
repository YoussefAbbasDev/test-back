// Pure leave calculations — unit tested in tests/unit/leave.test.js
const { D } = require('../utils/money');
const { eachDay, weekday, fmtDate, dayjs, toDateOnly } = require('../utils/dates');

/**
 * Number of leave days between start and end (inclusive) according to policy.
 * holidays: Set of 'YYYY-MM-DD'. weekendDays: array of weekday numbers.
 */
const countLeaveDays = ({ start, end, halfDay = false, weekendDays = [], holidays = new Set(), countWeekends = false, countHolidays = false }) => {
  if (toDateOnly(end) < toDateOnly(start)) return D(0);
  let days = 0;
  for (const d of eachDay(start, end)) {
    if (!countWeekends && weekendDays.includes(weekday(d))) continue;
    if (!countHolidays && holidays.has(fmtDate(d))) continue;
    days++;
  }
  if (halfDay) return days >= 1 && fmtDate(start) === fmtDate(end) ? D(0.5) : D(days);
  return D(days);
};

/**
 * Entitlement accrued for `year` as of `asOf`.
 *  UPFRONT: full entitlement at the start of the year (prorated by hire month in the hire year when prorateFirstYear)
 *  MONTHLY: entitlement / 12 per completed month of service in the year
 *  NONE: 0 (balance managed by adjustments only, e.g. sick leave tracked by usage)
 */
const accruedFor = ({ entitlement, method, hireDate, year, asOf, prorateFirstYear = true, maxBalance = null }) => {
  const ent = D(entitlement);
  if (method === 'NONE' || ent.isZero()) return D(0);
  const yearStart = dayjs.utc(`${year}-01-01`);
  const yearEnd = dayjs.utc(`${year}-12-31`);
  const hire = dayjs.utc(hireDate);
  if (hire.isAfter(yearEnd)) return D(0);
  const effectiveStart = hire.isAfter(yearStart) ? hire : yearStart;
  let result;
  if (method === 'UPFRONT') {
    if (prorateFirstYear && hire.isAfter(yearStart)) {
      const remainingDays = yearEnd.diff(effectiveStart, 'day') + 1;
      const daysInYear = yearEnd.diff(yearStart, 'day') + 1;
      result = ent.times(remainingDays).dividedBy(daysInYear);
    } else result = ent;
  } else {
    const until = dayjs.utc(asOf).isAfter(yearEnd) ? yearEnd : dayjs.utc(asOf);
    if (until.isBefore(effectiveStart)) return D(0);
    // completed months of service inside the year (the day after asOf counts as the boundary)
    const months = Math.min(12, Math.max(0, until.add(1, 'day').diff(effectiveStart, 'month')));
    result = ent.dividedBy(12).times(months);
  }
  result = result.toDecimalPlaces(2);
  if (maxBalance != null && result.greaterThan(D(maxBalance))) result = D(maxBalance);
  return result;
};

// Current Balance = Opening + Accrued + Adjustments + Carried Forward − Used
const currentBalance = (b) => D(b.openingBalance).plus(b.accrued).plus(b.adjustments).plus(b.carriedForward).minus(b.used);
// Available = Current − Pending (pending days are reserved, not used)
const availableBalance = (b, reserveOnPending = true) => (reserveOnPending ? currentBalance(b).minus(b.pending) : currentBalance(b));

const carryForwardAmount = (balance, carryForwardMax) => {
  if (carryForwardMax == null) return D(0);
  const remaining = currentBalance(balance);
  if (remaining.lessThanOrEqualTo(0)) return D(0);
  return remaining.greaterThan(D(carryForwardMax)) ? D(carryForwardMax) : remaining;
};

module.exports = { countLeaveDays, accruedFor, currentBalance, availableBalance, carryForwardAmount };
