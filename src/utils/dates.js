const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isBetween = require('dayjs/plugin/isBetween');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);
dayjs.extend(customParseFormat);

// Calendar dates (@db.Date) are represented as UTC-midnight Date objects and as 'YYYY-MM-DD' strings in the API.
const toDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const s = String(value).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmtDate = (d) => (d ? dayjs.utc(d).format('YYYY-MM-DD') : null);
const addDays = (date, n) => dayjs.utc(date).add(n, 'day').toDate();
const eachDay = (start, end) => {
  const out = [];
  let cur = dayjs.utc(toDateOnly(start));
  const last = dayjs.utc(toDateOnly(end));
  while (!cur.isAfter(last)) {
    out.push(cur.toDate());
    cur = cur.add(1, 'day');
  }
  return out;
};
const weekday = (date) => dayjs.utc(date).day(); // 0 = Sunday

// Local work date for an instant in the company timezone
const localDate = (instant, tz) => toDateOnly(dayjs(instant).tz(tz).format('YYYY-MM-DD'));
// UTC instant for a local date + 'HH:mm' in company timezone
const localTimeToUtc = (date, hhmm, tz) => dayjs.tz(`${fmtDate(date)} ${hhmm}`, 'YYYY-MM-DD HH:mm', tz).toDate();
const minutesBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const daysBetweenInclusive = (a, b) => dayjs.utc(toDateOnly(b)).diff(dayjs.utc(toDateOnly(a)), 'day') + 1;
const overlapDays = (aStart, aEnd, bStart, bEnd) => {
  const s = Math.max(toDateOnly(aStart).getTime(), toDateOnly(bStart).getTime());
  const e = Math.min(toDateOnly(aEnd).getTime(), toDateOnly(bEnd).getTime());
  return e < s ? 0 : Math.round((e - s) / 86400000) + 1;
};

module.exports = { dayjs, toDateOnly, fmtDate, addDays, eachDay, weekday, localDate, localTimeToUtc, minutesBetween, daysBetweenInclusive, overlapDays };
