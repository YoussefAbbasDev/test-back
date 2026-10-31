// Repayment schedule generation — unit tested in tests/unit/installments.test.js
const { D } = require('../utils/money');
const { dayjs, toDateOnly } = require('../utils/dates');

/**
 * buildSchedule({ total, count, firstDate, monthlyAmount? })
 * Equal installments rounded to 2 decimals; the last one absorbs the rounding remainder so the schedule always sums to total.
 * If monthlyAmount is given, count is derived from it.
 */
const buildSchedule = ({ total, count, firstDate, monthlyAmount }) => {
  const t = D(total);
  if (t.lessThanOrEqualTo(0)) return [];
  let n = count;
  let each;
  if (monthlyAmount) {
    each = D(monthlyAmount);
    n = t.dividedBy(each).ceil().toNumber();
  } else {
    n = Math.max(1, Number(count) || 1);
    each = t.dividedBy(n).toDecimalPlaces(2, 1); // round down so the last installment carries the remainder
  }
  const out = [];
  let allocated = D(0);
  for (let i = 1; i <= n; i++) {
    const amount = i === n ? t.minus(allocated) : each;
    allocated = allocated.plus(amount);
    out.push({ number: i, dueDate: toDateOnly(dayjs.utc(firstDate).add(i - 1, 'month').toDate()), amount: amount.toDecimalPlaces(2) });
  }
  return out;
};

module.exports = { buildSchedule };
