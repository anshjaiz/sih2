/**
 * scheduleUtils.js
 *
 * Derive an absolute schedule window for a booking from requestedDate + timeSlot
 * (or explicit customer-provided times). The reliability scheduler uses these
 * instants — never wall-clock assumptions — for no-show detection and expiry.
 */

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

// "9:00 AM"-style label used in worker-facing error messages and UI hints.
const formatTimeLabel = (date) => {
  const d = toDate(date);
  if (!d) return '';
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
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
  const start = new Date(date);
  start.setHours(range[0], 0, 0, 0);
  const end = new Date(start);
  end.setHours(range[1], 0, 0, 0);
  if (range[1] <= range[0]) end.setDate(end.getDate() + 1);

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

module.exports = { deriveScheduleWindow, resolveScheduleTimes, getNavigationTimes, formatTimeLabel, SLOT_RANGES };