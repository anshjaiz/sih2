/**
 * scheduleUtils.js
 *
 * Derive an absolute schedule window for a booking from requestedDate + timeSlot
 * (or explicit customer-provided times). The reliability scheduler uses these
 * instants — never wall-clock assumptions — for no-show detection and expiry.
 *
 * IMPORTANT: A customer's "Afternoon (12–4pm)" is a WALL-CLOCK window in the
 * app's timezone, not the host's. All slot→instant derivation is therefore done
 * in `env.timeZone` (default Asia/Kolkata) so the worker's "can start at noon"
 * gate stays correct even when the server runs on UTC.
 */

const { timeZone } = require('../config/env');

const SLOT_RANGES = {
  Morning: [9, 12],
  Afternoon: [12, 17],
  Evening: [17, 21],
  Flexible: [9, 21],
  Night: [21, 23],
};

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const getZoneFormatter = (tz) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

// Render any instant as {year,month,day,hour,minute,second} in the given tz.
const zonedWallClock = (date, tz) => {
  const out = {};
  for (const p of getZoneFormatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
};

// Convert wall-clock fields (year, monthIndex, day, hour, minute) intended to
// be read IN tz into an absolute instant. Dependent only on the tz, never on
// the host's local timezone.
const zonedFromParts = (year, monthIndex, day, hour, minute, second = 0, tz = timeZone) => {
  const asUtc = Date.UTC(year, monthIndex, day, hour, minute, second);
  const wall = zonedWallClock(new Date(asUtc), tz);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  return new Date(asUtc - (wallAsUtc - asUtc));
};

// Which calendar day does the requested date fall on in tz? ISO date-only
// strings ("2026-09-23") are taken literally; anything else is parsed as an
// instant and converted into tz (so a full browser datetime from the customer
// maps to their intended local day).
const getCalendarParts = (requestedDate, tz = timeZone) => {
  if (typeof requestedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    const [y, m, d] = requestedDate.split('-').map(Number);
    return { year: y, monthIndex: m - 1, day: d };
  }
  const dt = toDate(requestedDate);
  if (!dt) return null;
  const wall = zonedWallClock(dt, tz);
  return { year: wall.year, monthIndex: wall.month - 1, day: wall.day };
};

// "9:00 AM"-style label used in worker-facing error messages and UI hints,
// rendered in the app timezone so the server never reports a host-shifted time.
const formatTimeLabel = (date) => {
  const d = toDate(date);
  if (!d) return '';
  const wall = zonedWallClock(d, timeZone);
  let h = wall.hour % 24;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = String(wall.minute).padStart(2, '0');
  return `${h}:${m} ${ampm}`;
};

/**
 * @param {Date|string} requestedDate
 * @param {String} timeSlot
 * @param {{isEmergency?:boolean, explicitStartTime?:Date|string, explicitEndTime?:Date|string}} opts
 */
const deriveScheduleWindow = (requestedDate, timeSlot, { isEmergency = false, explicitStartTime, explicitEndTime } = {}) => {
  const date = toDate(requestedDate);
  if (!date) return { scheduledDate: null, scheduledStartTime: null, scheduledEndTime: null };

  // Emergency jobs are immediate — now + a nominal 90 minute window.
  if (isEmergency) {
    const now = new Date();
    const end = new Date(now.getTime() + 90 * 60 * 1000);
    return { scheduledDate: now, scheduledStartTime: now, scheduledEndTime: end };
  }

  const explicitStart = toDate(explicitStartTime);
  const explicitEnd = toDate(explicitEndTime);
  if (explicitStart && explicitEnd && explicitEnd.getTime() >= explicitStart.getTime()) {
    return {
      scheduledDate: explicitStart,
      scheduledStartTime: explicitStart,
      scheduledEndTime: explicitEnd,
    };
  }

  const range = SLOT_RANGES[timeSlot] || SLOT_RANGES.Flexible;
  const parts = getCalendarParts(requestedDate);
  if (!parts) return { scheduledDate: null, scheduledStartTime: null, scheduledEndTime: null };
  const start = zonedFromParts(parts.year, parts.monthIndex, parts.day, range[0], 0, 0);
  const end = zonedFromParts(parts.year, parts.monthIndex, parts.day, range[1], 0, 0);

  return { scheduledDate: start, scheduledStartTime: start, scheduledEndTime: end };
};

/**
 * Effective schedule for a booking. Uses the stored absolute window when
 * present; otherwise derives one from requestedDate + timeSlot so LEGACY
 * bookings (created before scheduling fields existed) are still enforced by
 * the reliability scheduler. Returns null fields when nothing can be derived.
 *
 * @param {{scheduledStartTime?:Date, scheduledEndTime?:Date, requestedDate?:Date|string, timeSlot?:String, isEmergency?:Boolean}} booking
 */
const resolveScheduleTimes = (booking) => {
  if (!booking) return { scheduledStartTime: null, scheduledEndTime: null };
  const start = toDate(booking.scheduledStartTime);
  const end = toDate(booking.scheduledEndTime);
  if (start && end && end.getTime() >= start.getTime()) {
    return { scheduledStartTime: start, scheduledEndTime: end };
  }
  const derived = deriveScheduleWindow(booking.requestedDate, booking.timeSlot, {
    isEmergency: !!booking.isEmergency,
  });
  return {
    scheduledStartTime: derived.scheduledStartTime,
    scheduledEndTime: derived.scheduledEndTime,
  };
};

/**
 * Effective pre-job navigation window for a booking.
 * navigationAvailableTime = scheduledStartTime - bufferMinutes.
 * Returns null fields when no schedule can be derived (e.g. emergency or
 * legacy booking with no time slot) — callers treat null as "never blocked".
 *
 * @param {Object} booking
 * @param {Number} bufferMinutes navigation buffer in minutes (default 60)
 */
const getNavigationTimes = (booking, bufferMinutes = 60) => {
  const { scheduledStartTime } = resolveScheduleTimes(booking);
  if (!scheduledStartTime) {
    return { scheduledStartTime: null, navigationAvailableTime: null };
  }
  const mins = Number.isFinite(bufferMinutes) && bufferMinutes >= 0 ? bufferMinutes : 60;
  return {
    scheduledStartTime,
    navigationAvailableTime: new Date(scheduledStartTime.getTime() - mins * 60000),
  };
};

module.exports = {
  deriveScheduleWindow,
  resolveScheduleTimes,
  getNavigationTimes,
  formatTimeLabel,
  zonedFromParts,
  getCalendarParts,
  timeZone,
  SLOT_RANGES,
};