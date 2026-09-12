/**
 * reliabilityService.js
 *
 * Worker merit/reliability engine.
 *
 *  - Every eligible worker starts at initialScore (default 100).
 *  - Score changes require an explicit ReliabilityEvent row. Duplicate events
 *    for the same (worker, booking, eventType) are rejected so penalties are
 *    applied exactly once even when the scheduler and a controller race.
 *  - The score maps to a level and to the worker profile's accountStatus:
 *      >= GOOD        ACTIVE
 *      WARNING        WARNING
 *      LOW_RELIABILITY -> LOW_RELIABILITY
 *      TEMPORARILY_SUSPENDED -> TEMPORARILY_SUSPENDED
 *      DEACTIVATION_REVIEW -> DEACTIVATION_REVIEW
 *  - accountStatus is what matching / job acceptance checks; workers in
 *    TEMPORARILY_SUSPENDED or DEACTIVATION_REVIEW are blocked from earning.
 *  - No-show handling: after the scheduledEndTime + grace expires, the job is
 *    marked WORKER_NO_SHOW, the worker is penalised (with a repeat-offender
 *    extra penalty) and a replacement is sought using the EXISTING strict
 *    skill-matching pipeline.
 */

const Worker = require('../../models/WorkerProfile');
const Booking = require('../../models/Booking');
const Service = require('../../models/Service');
const User = require('../../models/User');
const WorkerReliability = require('../../models/WorkerReliability');
const ReliabilityEvent = require('../../models/ReliabilityEvent');
const { getSettings } = require('./reliabilityConfig');
const { matchWorkersForBooking } = require('../matching/matchingService');
const { createNotification, notifyUsers } = require('../notification/notificationService');
const { logAudit, ACTIONS } = require('../audit/auditLogService');

/**
 * Derive the reliability level for a score using configured thresholds.
 */
const deriveLevel = (score, thresholds) => {
  const t = thresholds || {};
  if (score >= (t.good ?? 80)) return 'GOOD';
  if (score >= (t.warning ?? 60)) return 'WARNING';
  if (score >= (t.lowReliability ?? 40)) return 'LOW_RELIABILITY';
  if (score >= (t.temporarySuspend ?? 20)) return 'TEMPORARILY_SUSPENDED';
  return 'DEACTIVATION_REVIEW';
};

/**
 * Map a reliability level to the worker profile's accountStatus.
 */
const accountStatusForLevel = (level) => {
  switch (level) {
    case 'GOOD':
      return 'ACTIVE';
    case 'WARNING':
      return 'WARNING';
    case 'LOW_RELIABILITY':
      return 'LOW_RELIABILITY';
    case 'TEMPORARILY_SUSPENDED':
      return 'TEMPORARILY_SUSPENDED';
    case 'DEACTIVATION_REVIEW':
      return 'DEACTIVATION_REVIEW';
    default:
      return 'ACTIVE';
  }
};

const isSuspendedStatus = (status) =>
  status === 'TEMPORARILY_SUSPENDED' || status === 'DEACTIVATION_REVIEW';

/**
 * Is this worker profile allowed to earn (match + accept jobs) right now?
 * Low-reliability workers may still work; suspended / deactivation-review
 * workers are blocked until an admin reacts.
 */
const isWorkerTakeableForJobs = (wp) => {
  if (!wp) return false;
  return (
    wp.isActive !== false &&
    wp.verificationStatus === 'VERIFIED' &&
    !isSuspendedStatus(wp.accountStatus)
  );
};

/**
 * Get (creating if necessary) the reliability aggregate row for a worker.
 */
const getOrCreateReliability = async (workerId) => {
  let rel = await WorkerReliability.findOne({ worker: workerId });
  if (rel) return rel;
  const settings = await getSettings();
  const wp = await Worker.findById(workerId).select('reliability');
  const initial = wp && Number.isFinite(wp.reliability) ? wp.reliability : settings.points.initialScore;
  rel = await WorkerReliability.findOneAndUpdate(
    { worker: workerId },
    {
      $setOnInsert: {
        score: Math.min(100, Math.max(0, initial)),
        level: deriveLevel(initial, settings.thresholds),
      },
    },
    { new: true, upsert: true }
  );
  if (wp) {
    const level = deriveLevel(rel.score, settings.thresholds);
    await Worker.updateOne(
      { _id: workerId },
      {
        $set: {
          reliability: rel.score,
          accountStatus: accountStatusForLevel(level),
        },
      }
    );
    rel.level = level;
  }
  return rel;
};

/**
 * Core mutation: change a worker's score by `points` and record the event.
 *
 * @returns {{skipped:boolean, event?:object, worker, reliability, level, accountStatus}}
 */
const applyScoreChange = async ({
  workerId,
  eventType,
  points,
  reason,
  bookingId = null,
  admin = null,
  adminNote = '',
  metadata = {},
  counterField = null,
  silent = false,
}) => {
  const rel = await getOrCreateReliability(workerId);
  const previousScore = rel.score;

  // Duplicate guard — never penalise a worker twice for the same booking+event.
  if (bookingId) {
    const existing = await ReliabilityEvent.findOne({
      worker: workerId,
      booking: bookingId,
      eventType,
    });
    if (existing) {
      return { skipped: true, duplicate: existing._id, reliability: rel, worker: rel.worker };
    }
  }

  const newScore = Math.min(100, Math.max(0, previousScore + points));
  const settings = await getSettings();
  const level = deriveLevel(newScore, settings.thresholds);
  const accountStatus = accountStatusForLevel(level);

  const updateOp = {
    score: newScore,
    level,
    lastEventAt: new Date(),
  };
  if (counterField) updateOp[counterField] = (rel[counterField] || 0) + 1;

  const updatedRel = await WorkerReliability.findOneAndUpdate(
    { _id: rel._id },
    { $set: updateOp },
    { new: true }
  );

  const event = await ReliabilityEvent.create({
    worker: workerId,
    booking: bookingId,
    eventType,
    points,
    previousScore,
    newScore,
    levelAfter: level,
    reason: reason || '',
    admin,
    adminNote: adminNote || '',
    metadata,
  });

  await Worker.updateOne(
    { _id: workerId },
    {
      $set: {
        reliability: newScore,
        accountStatus,
      },
    }
  );

  if (!silent) {
    const wpUser = await Worker.findById(workerId).select('user').lean();
    await createNotification({
      user: wpUser ? wpUser.user : undefined,
      type: 'RELIABILITY_UPDATE',
      title: 'Reliability update',
      message: `${reason || 'Your reliability score'} changed: ${previousScore} → ${newScore}.`,
      data: {
        eventId: event._id,
        eventType,
        points,
        previousScore,
        newScore,
        level,
        accountStatus,
      },
    });
    if (isSuspendedStatus(accountStatus)) {
      await createNotification({
        user: wpUser ? wpUser.user : undefined,
        type: 'RELIABILITY_SUSPENDED',
        title: 'Merit suspension',
        message:
          accountStatus === 'DEACTIVATION_REVIEW'
            ? 'Your reliability score is critically low. Your account is under deactivation review.'
            : 'Your reliability score is below the earning threshold. You cannot accept new jobs until an admin reviews your account.',
        data: { accountStatus, score: newScore },
      });
    }
  }

  if (points !== 0) {
    // Audit every non-trivial score change so the admin trail is complete.
    const wpUserForAudit = await Worker.findById(workerId)
      .select('user')
      .lean()
      .catch(() => null);
    await logAudit({
      action: ACTIONS.MERIT_SCORE_CHANGED,
      performedBy: admin,
      targetUser: wpUserForAudit?.user ?? null,
      targetRole: 'worker',
      targetProfile: workerId,
      booking: bookingId,
      reason: reason || '',
      metadata: {
        eventType,
        points,
        previousScore,
        newScore,
        level,
        accountStatus,
        ...metadata,
      },
    });
  }

  return {
    skipped: false,
    event,
    reliability: updatedRel,
    worker: workerId,
    level,
    accountStatus,
    previousScore,
    newScore,
    points,
  };
};

/**
 * Job completed → +completeJob points, and +onTime when scheduledEndTime was met.
 * Every 5 completed jobs also earns the worker a MILESTONE_JOBS_COMPLETED bonus.
 */
const handleJobCompleted = async (booking, worker, { onTime = false } = {}) => {
  const settings = await getSettings();
  const completed = await applyScoreChange({
    workerId: worker._id,
    eventType: 'JOB_COMPLETED',
    points: settings.points.completeJob,
    reason: `Completed job ${booking.bookingNumber}`,
    bookingId: booking._id,
    counterField: 'completedCount',
  });

  const extras = [];
  if (!completed.skipped) {
    const newCount = completed.reliability.completedCount || 0;
    if (newCount > 0 && newCount % 5 === 0) {
      extras.push(
        await applyScoreChange({
          workerId: worker._id,
          eventType: 'MILESTONE_JOBS_COMPLETED',
          points: settings.points.jobMilestoneBonus,
          reason: `Completed ${newCount} jobs — milestone reward`,
          bookingId: booking._id,
          metadata: { completedCount: newCount },
          silent: true,
        })
      );
    }
    if (onTime) {
      extras.push(
        await applyScoreChange({
          workerId: worker._id,
          eventType: 'ON_TIME',
          points: settings.points.onTime,
          reason: `Completed job ${booking.bookingNumber} on time`,
          bookingId: booking._id,
          counterField: 'onTimeCount',
        })
      );
    }
  }
  return { completed, extras };
};

/**
 * Collaboration completed → every 5 completed collaborations earns the
 * collaborator a MILESTONE_COLLABS_COMPLETED bonus. Uses the worker's
 * collaborationsCount (worker profile) which completeTeam has already bumped.
 */
const handleCollaborationCompleted = async (workerId, bookingId) => {
  const settings = await getSettings();
  const worker = await Worker.findById(workerId).select('collaborationsCount').lean();
  const count = worker?.collaborationsCount || 0;
  if (count === 0 || count % 5 !== 0) return { skipped: true };
  return applyScoreChange({
    workerId,
    eventType: 'MILESTONE_COLLABS_COMPLETED',
    points: settings.points.collabMilestoneBonus,
    reason: `Completed ${count} collaborations — milestone reward`,
    bookingId,
    metadata: { collaborationsCount: count },
    silent: true,
  });
};

/**
 * Good customer rating (>= 4) → +goodRating points, once per worker.
 */
const handleGoodRating = async (workerId, bookingId, rating) => {
  const settings = await getSettings();
  if (Number(rating) < 4) return { skipped: true };
  return applyScoreChange({
    workerId,
    eventType: 'GOOD_RATING',
    points: settings.points.goodRating,
    reason: `Received a ${rating}-star rating`,
    bookingId,
    metadata: { rating },
    silent: true,
  });
};

/**
 * Collaborator accepted onto a job → +collaboration points, once per booking.
 */
const handleCollaboration = async (workerId, bookingId) => {
  const settings = await getSettings();
  return applyScoreChange({
    workerId,
    eventType: 'COLLABORATION_ACCEPTED',
    points: settings.points.collaboration,
    reason: 'Accepted a collaboration request',
    bookingId,
    silent: true,
  });
};

/**
 * Worker cancelled after accepting → cancelAfterAccept points (negative).
 */
const handleCancelledAfterAccept = async (workerId, bookingId) => {
  const settings = await getSettings();
  return applyScoreChange({
    workerId,
    eventType: 'CANCELLED_AFTER_ACCEPT',
    points: settings.points.cancelAfterAccept,
    reason: 'Cancelled a job after accepting it',
    bookingId,
    counterField: 'cancelledAfterAcceptCount',
    silent: true,
  });
};

/**
 * Record numeric lateness (customer/worker reported or scheduled).
 */
const handleLateArrival = async (workerId, bookingId, { minutes } = {}) => {
  const settings = await getSettings();
  return applyScoreChange({
    workerId,
    eventType: 'LATE_ARRIVAL',
    points: settings.points.lateArrival,
    reason: `Late arrival (${minutes ?? 'over tolerance'} minutes)`,
    bookingId,
    metadata: { minutes },
    counterField: 'lateCount',
    silent: true,
  });
};

/**
 * Set workerCheckInAt + location on a booking (arrival). Idempotent — the
 * first explicit check-in wins, so opening the app never counts as arrived.
 */
const recordCheckIn = async (booking, worker, { coordinates } = {}) => {
  const updates = {};
  if (!booking.workerCheckInAt) updates.workerCheckInAt = new Date();
  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    updates['workerLocation.coordinates'] = coordinates;
    updates['workerLocation.type'] = 'Point';
    updates['workerLocation.lastUpdatedAt'] = new Date();
  }
  if (Object.keys(updates).length) {
    await Booking.updateOne({ _id: booking._id }, { $set: updates });
  }
  return { checkedInAt: updates.workerCheckInAt || booking.workerCheckInAt };
};

/**
 * Notify customer + admins about a no-show.
 */
const notifyNoShow = async (booking, worker) => {
  const adminUsers = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  const serviceName = booking.serviceSnapshot?.name || 'Service';
  const workerName = worker?.user ? await User.findById(worker.user).select('name').lean() : null;

  const items = [
    {
      user: booking.customer,
      type: 'WORKER_NO_SHOW',
      title: 'Worker did not arrive',
      message: `The assigned ${serviceName} worker did not arrive for booking ${booking.bookingNumber}. We are arranging a replacement.`,
      data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
    },
  ];
  adminUsers.forEach((a) =>
    items.push({
      user: a._id,
      type: 'WORKER_NO_SHOW',
      title: 'Worker no-show',
      message: `${workerName?.name || 'A worker'} did not arrive for ${serviceName} booking ${booking.bookingNumber}.`,
      data: { bookingId: booking._id, bookingNumber: booking.bookingNumber, workerId: worker?._id },
    })
  );
  return notifyUsers(items);
};

/**
 * Attempt a replacement worker for a failed booking using the EXISTING strict
 * skill-matching pipeline. Workers already offered (candidateWorkers) and the
 * offending worker are excluded. If matches exist the booking moves to
 * REASSIGNED with a fresh candidate set; otherwise it expires.
 */
const attemptReassignment = async (booking, { reason = 'REPLACEMENT' } = {}) => {
  const settings = await getSettings();
  const service = await Service.findById(booking.service);
  if (!service) {
    return { reassigned: false, reason: 'NO_SERVICE' };
  }

  const excludeIds = new Set(
    booking.candidateWorkers.map((c) => c.worker.toString())
  );
  if (booking.worker) excludeIds.add(booking.worker.toString());

  const candidateLimit = booking.isEmergency ? 3 : 10;
  let candidates = [];
  try {
    candidates = await matchWorkersForBooking(
      {
        service,
        location: booking.location ? booking.location.coordinates : undefined,
        requestedDate: booking.scheduledDate || booking.requestedDate,
        isEmergency: booking.isEmergency,
        city: booking.city,
      },
      candidateLimit
    );
  } catch (e) {
    candidates = [];
  }

  const fresh = candidates.filter((c) => !excludeIds.has(c.worker.toString()));

  if (fresh.length === 0) {
    // No replacement found → expire.
    await Booking.updateOne(
      { _id: booking._id, status: { $in: ['WORKER_NO_SHOW', 'REASSIGNED', 'ACCEPTED', 'MATCHING', 'ASSIGNED'] } },
      {
        $set: {
          status: 'EXPIRED',
          expiredAt: new Date(),
        },
        $push: {
          statusHistory: {
            status: 'EXPIRED',
            updatedAt: new Date(),
            updatedBy: null,
            note: 'No replacement worker found',
          },
        },
      }
    );
    await createNotification({
      user: booking.customer,
      type: 'WORKER_EXPIRED',
      title: 'No replacement worker found',
      message: `We could not find a replacement for ${booking.bookingNumber}. Please request a new booking or contact support.`,
      data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
    });
    return { reassigned: false, expired: true, candidates: 0 };
  }

  const nextAttempts = (booking.reassignmentAttempts || 0) + 1;
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        status: 'REASSIGNED',
        reassignmentAttempts: nextAttempts,
        reassignedAt: new Date(),
        candidateWorkers: fresh.map((c) => ({
          worker: c.worker,
          score: c.score,
          reasons: c.reasons,
        })),
      },
      $push: {
        statusHistory: {
          status: 'REASSIGNED',
          updatedAt: new Date(),
          updatedBy: null,
          note: reason === 'NO_SHOW' ? 'Worker no-show — looking for replacement' : 'Looking for replacement worker',
        },
      },
    }
  );

  // Notify each new candidate (NEW_JOB) + customer + admins.
  const newWorkers = await Worker.find({ _id: { $in: fresh.map((c) => c.worker) } }).select('user').lean();
  const userByWorkerId = new Map(newWorkers.map((w) => [w._id.toString(), w.user]));
  const items = [];
  for (const c of fresh) {
    const userId = userByWorkerId.get(c.worker.toString());
    if (userId) {
      items.push({
        user: userId,
        type: 'NEW_JOB',
        title: 'New job available (replacement)',
        message: `${booking.isEmergency ? '⚠️ EMERGENCY: ' : ''}${service.name} job needs a replacement worker. Match score ${c.score}/100.`,
        data: { bookingId: booking._id, bookingNumber: booking.bookingNumber, score: c.score, reassigned: true },
      });
    }
  }
  items.push({
    user: booking.customer,
    type: 'REASSIGNED',
    title: 'Replacement worker found',
    message: `A replacement ${service.name} worker has been requested for your booking ${booking.bookingNumber}.`,
    data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
  });
  await notifyUsers(items);

  const io = require('../../config/socket').getIO();
  if (io) {
    for (const c of fresh) {
      io.to(`worker_${c.worker}`).emit('new_job', {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
        serviceName: service.name,
        isEmergency: booking.isEmergency,
        score: c.score,
        reassigned: true,
      });
    }
  }

  return { reassigned: true, candidateCount: fresh.length, workers: fresh };
};

/**
 * Worker snapshot for the worker-facing reliability endpoint.
 */
const getWorkerReliabilitySnapshot = async (workerId) => {
  const rel = await getOrCreateReliability(workerId);
  const events = await ReliabilityEvent.find({ worker: workerId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  return { reliability: rel, recentEvents: events };
};

/**
 * Full event history (paginated).
 */
const listWorkerReliabilityEvents = async (workerId, { page = 1, limit = 20 } = {}) => {
  const skip = (page - 1) * limit;
  const [events, total] = await Promise.all([
    ReliabilityEvent.find({ worker: workerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ReliabilityEvent.countDocuments({ worker: workerId }),
  ]);
  return { events, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
};

module.exports = {
  deriveLevel,
  accountStatusForLevel,
  isSuspendedStatus,
  isWorkerTakeableForJobs,
  getOrCreateReliability,
  applyScoreChange,
  handleJobCompleted,
  handleGoodRating,
  handleCollaboration,
  handleCollaborationCompleted,
  handleCancelledAfterAccept,
  handleLateArrival,
  recordCheckIn,
  notifyNoShow,
  attemptReassignment,
  getWorkerReliabilitySnapshot,
  listWorkerReliabilityEvents,
};