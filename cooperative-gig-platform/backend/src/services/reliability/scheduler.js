/**
 * scheduler.js
 *
 * Background cron that enforces job expiry and no-show detection using ONLY
 * server time. It runs on a configurable interval (default 60s).
 *
 * Guarantees:
 *  - Idempotent: a global running-flag plus atomic findOneAndUpdate status
 *    guards mean overlapping ticks never double-process a booking.
 *  - Expiry  : jobs stuck in REQUESTED/MATCHING/ASSIGNED (never assigned to a
 *    worker that started) move to EXPIRED after scheduledStartTime + grace.
 *  - No-show : an ACCEPTED/ON_THE_WAY job with no worker check-in by
 *    scheduledEndTime + grace becomes WORKER_NO_SHOW, the worker is penalised
 *    and a replacement is sought. If replacement succeeds the booking moves to
 *    REASSIGNED; otherwise it expires.
 *  - Reassignment retry: REASSIGNED jobs with no acceptance within the
 *    reassignment grace are re-matched (up to maxRetries) then expire.
 *  - Reminders: workers get a gentle reminder before their accepted job.
 *  - Collaboration no-shows: a collaborator who ACCEPTED but never checked in
 *    (joinedAt null) after the collaboration window (+ grace) is penalised and
 *    their team member is marked NO_SHOW. Stale OPEN invitations whose window
 *    has passed are expired.
 */

const Booking = require('../../models/Booking');
const User = require('../../models/User');
const Worker = require('../../models/WorkerProfile');
const JobTeam = require('../../models/JobTeam');
const CollaborationRequest = require('../../models/CollaborationRequest');
const { resolveScheduleTimes, zonedFromParts, getCalendarParts } = require('../../utils/scheduleUtils');
const { getSettings } = require('./reliabilityConfig');
const {
  applyScoreChange,
  getOrCreateReliability,
  notifyNoShow,
  attemptReassignment,
} = require('./reliabilityService');
const { createNotification, notifyUsers } = require('../notification/notificationService');
const { sweepExpiredSuspensions } = require('../worker/workerSuspensionService');
const { sweepExpiredCustomerSuspensions } = require('../cancellation/cancellationService');
const { rematchAllOpenBookings } = require('../matching/matchingService');

let intervalHandle = null;
let running = false;
let lastRematchAt = 0;

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;

const markExceeded = async (booking, status, note, customerType, customerTitle, customerMessage) => {
  const claim = { _id: booking._id };
  if (booking.status) claim.status = booking.status;
  const updated = await Booking.findOneAndUpdate(
    claim,
    {
      $set: { status, expiredAt: new Date() },
      $push: {
        statusHistory: {
          status,
          updatedAt: new Date(),
          updatedBy: null,
          note,
        },
      },
    },
    { new: true }
  );
  if (!updated) return null;
  const adminUsers = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  const items = [
    {
      user: booking.customer,
      type: customerType,
      title: customerTitle,
      message: customerMessage,
      data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
    },
  ];
  adminUsers.forEach((a) =>
    items.push({
      user: a._id,
      type: customerType,
      title: customerTitle,
      message: `${customerMessage} (booking ${booking.bookingNumber})`,
      data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
    })
  );
  await notifyUsers(items);
  return updated;
};

/**
 * Expire stale, never-started jobs.
 * Uses the effective schedule END time (legacy null-schedule bookings derive
 * one from requestedDate + timeSlot), so pre-scheduling-phase jobs are
 * enforced too. Jobs are not expired until after their scheduled end time
 * plus the grace period.
 */
const handleExpiredJobs = async (settings, now) => {
  const cutoff = new Date(now.getTime() - settings.jobExpiryGraceMinutes * minuteMs);
  const stale = await Booking.find({
    status: { $in: ['REQUESTED', 'MATCHING', 'ASSIGNED'] },
    $or: [
      { scheduledEndTime: { $lte: cutoff } },
      { scheduledEndTime: null },
    ],
  }).select('_id bookingNumber customer status requestedDate timeSlot isEmergency scheduledStartTime scheduledEndTime');
  const results = [];
  for (const b of stale) {
    const { scheduledEndTime: effectiveEnd } = resolveScheduleTimes(b);
    if (!effectiveEnd || effectiveEnd.getTime() > cutoff.getTime()) continue;
    const updated = await markExceeded(
      b,
      'EXPIRED',
      'Job expired — no worker started it in time',
      'WORKER_EXPIRED',
      'Job request expired',
      `Your job request ${b.bookingNumber} expired because no worker was confirmed in time. Please create a new request or contact support.`
    );
    if (updated) {
      results.push({ bookingId: b._id, outcome: 'EXPIRED' });
      // Never leave OPEN collaboration invites behind for an expired job.
      await require('../collaborator/teamFormationService')
        .closeCollaborationForBooking(b._id, { status: 'EXPIRED' })
        .catch((err) => console.error('[scheduler] collab cleanup on expiry error:', err.message));
    }
  }
  return results;
};

/**
 * Detect no-show: worker accepted/on-the-way but never checked in by the
 * deadline (scheduledEndTime + grace) and is not present. Legacy bookings
 * schedule their window from requestedDate + timeSlot.
 */
const handleNoShows = async (settings, now) => {
  const cutoff = new Date(now.getTime() - settings.noShowGraceMinutes * minuteMs);
  const due = await Booking.find({
    status: { $in: ['ACCEPTED', 'ON_THE_WAY'] },
    workerCheckInAt: null,
    $or: [
      { scheduledEndTime: { $lte: cutoff } },
      { scheduledEndTime: null },
    ],
  }).select('_id bookingNumber customer status worker serviceSnapshot requestedDate timeSlot isEmergency scheduledStartTime scheduledEndTime location city service candidateWorkers');

  const results = [];
  for (const booking of due) {
    const { scheduledEndTime: effectiveEnd } = resolveScheduleTimes(booking);
    if (!effectiveEnd || effectiveEnd.getTime() > cutoff.getTime()) continue;
    const claimed = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: { $in: ['ACCEPTED', 'ON_THE_WAY'] },
        workerCheckInAt: null,
      },
      {
        $set: {
          status: 'WORKER_NO_SHOW',
          noShowDetectedAt: now,
        },
        $push: {
          statusHistory: {
            status: 'WORKER_NO_SHOW',
            updatedAt: now,
            updatedBy: null,
            note: 'Worker did not arrive within the no-show grace period',
          },
        },
      },
      { new: true }
    );
    if (!claimed) continue;

    // The lead who no-showed is losing this job — their collaboration invites
    // and team are obsolete and must not linger in the feeds.
    await require('../collaborator/teamFormationService')
      .closeCollaborationForBooking(booking._id, { status: 'CANCELLED' })
      .catch((err) => console.error('[scheduler] collab cleanup on no-show error:', err.message));

    const worker = booking.worker ? await Worker.findById(booking.worker) : null;
    if (worker) {
      const rel = await getOrCreateReliability(worker._id);
      const base = await applyScoreChange({
        workerId: worker._id,
        eventType: 'NO_SHOW',
        points: settings.points.noShow,
        reason: `No-show for job ${booking.bookingNumber} (deadline ${effectiveEnd.toISOString()})`,
        bookingId: booking._id,
        counterField: 'noShowCount',
      });
      if (!base.skipped && (rel.noShowCount || 0) >= 1) {
        await applyScoreChange({
          workerId: worker._id,
          eventType: 'REPEATED_NO_SHOW',
          points: settings.points.repeatedNoShowExtra,
          reason: 'Repeated no-show offence',
          bookingId: booking._id,
        });
      }
      await createNotification({
        user: worker.user,
        type: 'WORKER_NO_SHOW',
        title: 'Marked as no-show',
        message: `You did not check in for job ${booking.bookingNumber}. A no-show penalty has been applied. Appeal if this is a mistake.`,
        data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
      });
      await notifyNoShow(booking, worker);
    }

    // Try to find a replacement (REASSIGNED) or expire.
    const res = await attemptReassignment(booking, { reason: 'NO_SHOW' });
    results.push({
      bookingId: booking._id,
      outcome: res.reassigned ? 'REASSIGNED' : 'EXPIRED',
      candidateCount: res.candidateCount || 0,
    });
  }
  return results;
};

/**
 * A REASSIGNED booking whose candidate list produced no acceptance within the
 * reassignment grace either gets one more matching round or expires.
 */
const handleReassignmentRetries = async (settings, now) => {
  const cutoff = new Date(now.getTime() - settings.reassignmentGraceMinutes * minuteMs);
  const due = await Booking.find({
    status: 'REASSIGNED',
    reassignedAt: { $lte: cutoff },
  }).select('_id bookingNumber customer status worker serviceSnapshot scheduledEndTime isEmergency location city service candidateWorkers reassignmentAttempts');

  const results = [];
  for (const booking of due) {
    if ((booking.reassignmentAttempts || 0) >= settings.maxReassignmentAttempts) {
      await markExceeded(
        booking,
        'EXPIRED',
        'Replacement could not be confirmed',
        'WORKER_EXPIRED',
        'No replacement worker found',
        `We could not confirm a replacement for ${booking.bookingNumber}. Please request a new booking or contact support.`
      );
      results.push({ bookingId: booking._id, outcome: 'EXPIRED' });
      await require('../collaborator/teamFormationService')
        .closeCollaborationForBooking(booking._id, { status: 'EXPIRED' })
        .catch((err) => console.error('[scheduler] collab cleanup on reassign-expiry error:', err.message));
      continue;
    }
    const res = await attemptReassignment(booking, { reason: 'RETRY' });
    results.push({
      bookingId: booking._id,
      outcome: res.reassigned ? 'REASSIGNED' : 'EXPIRED',
      candidateCount: res.candidateCount || 0,
    });
  }
  return results;
};

/**
 * Gentle reminder before an accepted job starts (max ~2 per booking).
 * Legacy null-schedule bookings derive their start from requestedDate + slot.
 */
const handleReminders = async (settings, now) => {
  const leadCutoff = new Date(now.getTime() - settings.reminderLeadMinutes * minuteMs);
  const due = await Booking.find({
    status: 'ACCEPTED',
    workerCheckInAt: null,
    $or: [
      { scheduledStartTime: { $gte: leadCutoff } },
      { scheduledStartTime: null },
    ],
  }).select('_id bookingNumber customer worker serviceSnapshot requestedDate timeSlot isEmergency scheduledStartTime remindersSent');

  const results = [];
  for (const booking of due) {
    const { scheduledStartTime: effectiveStart } = resolveScheduleTimes(booking);
    if (!effectiveStart) continue;
    const startMs = effectiveStart.getTime();
    if (startMs < leadCutoff.getTime() || startMs > now.getTime()) continue;

    const last = booking.remindersSent?.length ? booking.remindersSent[booking.remindersSent.length - 1] : null;
    if (last && now.getTime() - new Date(last).getTime() < 55 * minuteMs) continue;
    if ((booking.remindersSent || []).length >= 2) continue;

    await Booking.updateOne(
      { _id: booking._id },
      { $push: { remindersSent: now } }
    );

    const worker = booking.worker ? await Worker.findById(booking.worker).select('user') : null;
    if (worker) {
      await createNotification({
        user: worker.user,
        type: 'REMINDER_UPCOMING_JOB',
        title: 'Upcoming job reminder',
        message: `${booking.isEmergency ? '⚠️ EMERGENCY: ' : ''}You have an upcoming ${booking.serviceSnapshot?.name || 'job'} (${booking.bookingNumber}) scheduled for ${effectiveStart.toLocaleString()}. Please be on time.`,
        data: { bookingId: booking._id, bookingNumber: booking.bookingNumber, scheduledStartTime: booking.scheduledStartTime },
      });
    }
    results.push({ bookingId: booking._id, reminded: true });
  }
  return results;
};

/**
 * Parse an "HH:mm" clock string into [hours, minutes] (defaults 09:00).
 */
const parseClock = (clock) => {
  const parts = String(clock || '09:00').split(':');
  return [parseInt(parts[0], 10) || 9, parseInt(parts[1], 10) || 0];
};

/**
 * Collaboration end instant = request.date + startTime + durationHours. The
 * wall-clock parts are anchored to the app timezone (see scheduleUtils), not
 * the host's local timezone, mirroring the booking slot derivation.
 */
const collabEndTime = (request) => {
  if (!request || !request.date) return null;
  const [h, m] = parseClock(request.startTime);
  const parts = getCalendarParts(request.date);
  if (!parts) return null;
  const start = zonedFromParts(parts.year, parts.monthIndex, parts.day, h, m, 0);
  return new Date(start.getTime() + ((request.durationHours ?? 4) || 0) * hourMs);
};

/**
 * Detect collaboration no-shows and expire stale invitations.
 *
 * No-show: a team member who is still ACCEPTED with no joinedAt (never checked
 * in) once the collaboration window + grace has passed → member marked NO_SHOW
 * and penalised collabNoShow points. applyScoreChange's per-booking dedup makes
 * repeated ticks idempotent.
 *
 * Stale invites: OPEN requests whose window has fully passed without being
 * filled are closed (EXPIRED) and still-pending candidates marked DECLINED.
 */
const handleCollaboratorNoShows = async (settings, now) => {
  const graceMs = (settings.noShowGraceMinutes ?? 15) * minuteMs;
  const results = [];

  // 1) Close stale OPEN collaboration requests whose job already happened.
  const staleOpen = await CollaborationRequest.find({ status: 'OPEN' })
    .select('_id date startTime durationHours status candidates');
  const staleIds = [];
  for (const req of staleOpen) {
    const end = collabEndTime(req);
    if (!end || now.getTime() <= end.getTime() + graceMs) continue;
    req.status = 'EXPIRED';
    req.candidates.forEach((c) => {
      if (c.status === 'PENDING') {
        c.status = 'DECLINED';
        c.respondedAt = now;
      }
    });
    await req.save();
    staleIds.push(req._id);
  }
  if (staleIds.length) {
    results.push({ requestsExpired: staleIds.length });
  }

  // 2) Penalise ACCEPTED collaborators that never checked in.
  const teams = await JobTeam.find({ 'members.status': 'ACCEPTED' }).select(
    '_id booking collaborationRequest members'
  );
  for (const team of teams) {
    const request = team.collaborationRequest
      ? await CollaborationRequest.findById(team.collaborationRequest).select(
          '_id date startTime durationHours status role'
        )
      : null;
    if (!request || ['CANCELLED', 'EXPIRED'].includes(request.status)) continue;
    const end = collabEndTime(request);
    if (!end || now.getTime() <= end.getTime() + graceMs) continue;

    for (const member of team.members) {
      if (member.status !== 'ACCEPTED' || member.joinedAt) continue;
      const claimed = await JobTeam.updateOne(
        {
          _id: team._id,
          'members.worker': member.worker,
          'members.status': 'ACCEPTED',
          'members.joinedAt': null,
        },
        { $set: { 'members.$.status': 'NO_SHOW', 'members.$.noShowDetectedAt': now } }
      );
      if (claimed.matchedCount === 0) continue;

      // Mirror the no-show onto the invitation so the lead sees who flaked.
      await CollaborationRequest.updateOne(
        { _id: request._id, 'candidates.worker': member.worker, 'candidates.status': 'ACCEPTED' },
        { $set: { 'candidates.$.status': 'NO_SHOW', 'candidates.$.respondedAt': now } }
      );

      const applied = await applyScoreChange({
        workerId: member.worker,
        eventType: 'COLLAB_NO_SHOW',
        points: settings.points.collabNoShow,
        reason: `No-show for collaboration ${request.role || 'job'} (deadline ${end.toISOString()})`,
        bookingId: team.booking,
        counterField: 'collabNoShowCount',
        silent: true,
      });
      if (!applied.skipped) {
        results.push({ workerId: member.worker, bookingId: team.booking, outcome: 'NO_SHOW' });
      }
    }
  }
  return results;
};

/**
 * Lift suspensions whose deadline has passed so workers rejoin matching and
 * earning automatically once their suspension period is over.
 */
const handleExpiredSuspensions = async () => {
  const restored = await sweepExpiredSuspensions();
  return restored.map(String);
};

/**
 * Lift auto-suspensions for customers whose suspension window has passed
 * (repeated eligible cancellations) so they can book again.
 */
const handleExpiredCustomerSuspensions = async () => {
  return await sweepExpiredCustomerSuspensions();
};

/**
 * Re-run smart matching for every open MATCHING booking so candidate lists
 * stay fresh as eligibility data changes (new worker verified, skill
 * verified/backfilled, worker moved, etc.). Without this pass a booking
 * snapshotted before a worker became eligible would never surface to them.
 *
 * Throttled — runs on the first scheduler tick, then at most once every
 * rematchIntervalMs (default 4 minutes) to keep the tick cheap when nothing
 * is open.
 */
const REMATCH_INTERVAL_MS = 4 * minuteMs;

const handleRematchOpenBookings = async (now = new Date()) => {
  const nowMs = now.getTime();
  if (nowMs - lastRematchAt < REMATCH_INTERVAL_MS) {
    return { skipped: true, reason: 'throttled' };
  }
  try {
    const result = await rematchAllOpenBookings();
    lastRematchAt = nowMs;
    return { skipped: false, ...result };
  } catch (e) {
    // Never let a rematch failure take down the tick; retry on the next pass.
    lastRematchAt = nowMs - REMATCH_INTERVAL_MS + minuteMs;
    throw e;
  }
};

/**
 * Run one full pass of the scheduler. Returns a summary object (for tests).
 */
const runSchedulerOnce = async () => {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;
  try {
    const settings = await getSettings();
    const now = new Date();
    const [expired, noShows, retries, reminders, collabNoShows, suspensions, customerSuspensions, rematch] =
      await Promise.all([
        handleExpiredJobs(settings, now),
        handleNoShows(settings, now),
        handleReassignmentRetries(settings, now),
        handleReminders(settings, now),
        handleCollaboratorNoShows(settings, now),
        handleExpiredSuspensions(),
        handleExpiredCustomerSuspensions(),
        handleRematchOpenBookings(now),
      ]);
    return {
      skipped: false,
      expired,
      noShows,
      retries,
      reminders,
      collabNoShows,
      suspensions,
      customerSuspensions,
      rematch,
    };
  } finally {
    running = false;
  }
};

/**
 * Start the background loop (guarded so hot-restarts don't stack timers).
 */
const startScheduler = () => {
  if (intervalHandle) return intervalHandle;
  const start = async () => {
    try {
      await runSchedulerOnce();
    } catch (e) {
      console.error('[reliability-scheduler] tick error:', e.message);
    }
  };
  const loop = async () => {
    const settings = await getSettings();
    const interval = Math.max(20, settings.schedulerIntervalSeconds || 60) * 1000;
    intervalHandle = setInterval(start, interval);
    start();
  };
  loop();
  return intervalHandle;
};

const stopScheduler = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
};

module.exports = { startScheduler, stopScheduler, runSchedulerOnce };