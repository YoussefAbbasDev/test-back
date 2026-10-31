// Pure attendance calculations (no DB access) — unit tested in tests/unit/attendance.test.js
const { localTimeToUtc, addDays, minutesBetween } = require('../utils/dates');

const EARTH_RADIUS_M = 6371000;
const haversine = (lat1, lng1, lat2, lng2) => {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
};

// Nearest geofence and whether the point is inside it (radius + reported accuracy is NOT added: accuracy is checked separately)
const nearestLocation = (lat, lng, locations) => {
  let best = null;
  for (const loc of locations) {
    const distance = haversine(lat, lng, Number(loc.latitude), Number(loc.longitude));
    if (!best || distance < best.distance) best = { location: loc, distance, inside: distance <= loc.radiusMeters };
  }
  return best;
};

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const crossesMidnight = (startTime, endTime) => toMinutes(endTime) <= toMinutes(startTime);

const shiftDurationMinutes = (startTime, endTime) => {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  return e > s ? e - s : 24 * 60 - s + e;
};

// UTC window of a shift on a local work date (handles shifts past midnight)
const shiftWindow = (shift, date, tz) => {
  const start = localTimeToUtc(date, shift.startTime, tz);
  const endDate = crossesMidnight(shift.startTime, shift.endTime) ? addDays(date, 1) : date;
  const end = localTimeToUtc(endDate, shift.endTime, tz);
  return { start, end };
};

const overlaps = (aStart, aEnd, bStart, bEnd) => new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);

// Pairs CHECK_IN/CHECK_OUT into sessions and BREAK_START/BREAK_END into breaks
const buildSessions = (events) => {
  const sorted = [...events].filter((e) => !e.isVoided).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  const sessions = [];
  const breaks = [];
  let open = null;
  let openBreak = null;
  for (const e of sorted) {
    if (e.type === 'CHECK_IN' && !open) open = { in: e.occurredAt, out: null, inEvent: e };
    else if (e.type === 'CHECK_OUT' && open) {
      if (openBreak) { breaks.push({ start: openBreak, end: e.occurredAt }); openBreak = null; }
      sessions.push({ ...open, out: e.occurredAt, outEvent: e });
      open = null;
    } else if (e.type === 'BREAK_START' && open && !openBreak) openBreak = e.occurredAt;
    else if (e.type === 'BREAK_END' && openBreak) { breaks.push({ start: openBreak, end: e.occurredAt }); openBreak = null; }
  }
  return { sessions, breaks, open, onBreak: !!openBreak, sorted };
};

/**
 * computeRecord({ events, schedule: { start, end, expectedMinutes, graceMinutes } | null, dayType, policy })
 * dayType: WORKDAY | WEEKEND | HOLIDAY
 */
const computeRecord = ({ events, schedule, dayType = 'WORKDAY', policy }) => {
  const { sessions, breaks, open, sorted } = buildSessions(events);
  const ins = sorted.filter((e) => e.type === 'CHECK_IN');
  const outs = sorted.filter((e) => e.type === 'CHECK_OUT');
  const firstIn = ins[0] || null;
  const lastOut = open ? null : outs[outs.length - 1] || null;

  const gross = sessions.reduce((s, x) => s + Math.max(0, minutesBetween(x.in, x.out)), 0);
  const breakMinutes = breaks.reduce((s, b) => s + Math.max(0, minutesBetween(b.start, b.end)), 0);
  const worked = Math.max(0, gross - breakMinutes);

  let late = 0;
  let early = 0;
  const grace = schedule?.graceMinutes ?? policy.graceMinutes ?? 0;
  if (schedule && dayType === 'WORKDAY' && firstIn) {
    const diff = minutesBetween(schedule.start, firstIn.occurredAt);
    if (diff > grace) late = policy.lateCountFromShiftStart === false ? diff - grace : diff;
  }
  if (schedule && dayType === 'WORKDAY' && lastOut) {
    const diff = minutesBetween(lastOut.occurredAt, schedule.end);
    if (diff > (policy.earlyLeaveGraceMinutes ?? 0)) early = diff;
  }

  let overtime = 0;
  if (policy.overtimeEnabled) {
    if (dayType === 'WEEKEND' && policy.weekendWorkIsOvertime) overtime = worked;
    else if (dayType === 'HOLIDAY' && policy.holidayWorkIsOvertime) overtime = worked;
    else if (dayType === 'WORKDAY' && schedule) {
      const extra = worked - schedule.expectedMinutes;
      if (extra >= (policy.overtimeMinMinutes ?? 0)) overtime = extra;
    }
  }
  const regular = Math.max(0, worked - overtime);

  let status;
  if (!firstIn) status = 'ABSENT';
  else if (open) status = 'INCOMPLETE';
  else if (dayType !== 'WORKDAY') status = 'PRESENT';
  else if ((policy.halfDayThresholdMinutes && late > policy.halfDayThresholdMinutes) || (policy.minWorkingMinutes && worked < policy.minWorkingMinutes)) status = 'HALF_DAY';
  else if (late > 0) status = 'LATE';
  else status = 'PRESENT';

  return {
    firstCheckIn: firstIn?.occurredAt || null,
    lastCheckOut: lastOut?.occurredAt || null,
    checkInMethod: firstIn?.method || null,
    checkOutMethod: lastOut?.method || null,
    workedMinutes: worked,
    breakMinutes,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    overtimeMinutes: overtime,
    regularMinutes: regular,
    status,
    isOpen: !!open,
  };
};

// Next allowed punch type given the event history
const nextAllowed = (events) => {
  const { open, onBreak, sessions } = buildSessions(events);
  if (!open) return { checkIn: true, checkOut: false, breakStart: false, breakEnd: false, sessions: sessions.length };
  return { checkIn: false, checkOut: true, breakStart: !onBreak, breakEnd: onBreak, sessions: sessions.length };
};

// Impossible-travel heuristic: > 250 km/h between two located punches
const impossibleTravel = (prev, cur) => {
  if (!prev?.latitude || !cur?.latitude) return false;
  const meters = haversine(Number(prev.latitude), Number(prev.longitude), Number(cur.latitude), Number(cur.longitude));
  const hours = Math.max(1 / 60, Math.abs(new Date(cur.occurredAt) - new Date(prev.occurredAt)) / 3600000);
  return meters / 1000 / hours > 250;
};

module.exports = { haversine, nearestLocation, shiftWindow, overlaps, crossesMidnight, shiftDurationMinutes, toMinutes, buildSessions, computeRecord, nextAllowed, impossibleTravel };
