const Booking = require('../../models/Booking');
const Worker = require('../../models/WorkerProfile');
const JobTeam = require('../../models/JobTeam');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const Invoice = require('../../models/Invoice');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const syncWorkerLocation = require('../../utils/syncWorkerLocation');
const { getIO } = require('../../config/socket');
const { computeWorkerEarnings } = require('../../utils/pricingUtils');
const Cooperative = require('../../models/Cooperative');
const {
  recordCheckIn,
  handleLateArrival,
  handleJobCompleted,
  isWorkerTakeableForJobs,
} = require('../../services/reliability/reliabilityService');
const { getSettings } = require('../../services/reliability/reliabilityConfig');
const { resolveScheduleTimes, getNavigationTimes, formatTimeLabel } = require('../../utils/scheduleUtils');
const env = require('../../config/env');

// Time-based gating for navigation and job start, always evaluated on SERVER
// time (never the device clock). A booking with no derivable schedule (e.g.
// legacy job without a time slot) keeps both unlocked so existing flows are
// never broken for un-schedulable jobs.
const getJobWindowPolicy = (booking) => {
  const { scheduledStartTime, navigationAvailableTime } = getNavigationTimes(
    booking,
    env.preJobNavigationBufferMins
  );
  const now = new Date();
  if (!scheduledStartTime) {
    return {
      now,
      scheduledStartTime: null,
      navigationAvailableTime: null,
      navigationAllowed: true,
      startAllowed: true,
    };
  }
  return {
    now,
    scheduledStartTime,
    navigationAvailableTime,
    navigationAllowed: now >= navigationAvailableTime,
    startAllowed: now >= scheduledStartTime,
  };
};

const enforceNavigationAllowed = (booking) => {
  const p = getJobWindowPolicy(booking);
  if (!p.navigationAllowed) {
    throw new ApiError(
      `Navigation is available from ${formatTimeLabel(p.navigationAvailableTime)}.`,
      400
    );
  }
};

const enforceScheduledStart = (booking) => {
  const p = getJobWindowPolicy(booking);
  if (!p.startAllowed) {
    throw new ApiError(
      `You can start this job only after ${formatTimeLabel(p.scheduledStartTime)}.`,
      400
    );
  }
};

// Helper to get worker profile for current user
const getWorkerId = async (userId) => {
  const worker = await Worker.findOne({ user: userId });
  return worker ? worker._id : null;
};

// Worker dashboard
const getWorkerDashboard = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);
  const workerId = worker._id;

  const now = new Date();

  const [
    activeJobs,
    pendingRequests,
    upcomingJobs,
    recentCompleted,
    totalEarningsAgg,
    weeklyEarningsAgg,
  ] = await Promise.all([
    // Active/ongoing jobs
    Booking.find({
      worker: workerId,
      status: { $in: ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'] },
    })
      .populate('service', 'name category')
      .populate('customer', 'name phone avatar')
      .sort({ updatedAt: -1 }),

    // Jobs awaiting accept
    Booking.find({
      'candidateWorkers.worker': workerId,
      status: { $in: ['MATCHING', 'REASSIGNED'] },
    })
      .populate('service', 'name category')
      .populate('customer', 'name')
      .sort({ createdAt: -1 })
      .limit(10),

    // Future jobs
    Booking.find({
      worker: workerId,
      status: 'ACCEPTED',
      requestedDate: { $gte: now },
    })
      .populate('service', 'name')
      .sort({ requestedDate: 1 }),

    Booking.find({
      worker: workerId,
      status: 'COMPLETED',
    })
      .populate('service', 'name')
      .sort({ completedAt: -1 })
      .limit(5),

    // Total earnings
    Payment.aggregate([
      { $match: { worker: workerId, status: { $in: ['PAID', 'SUCCESS'] } } },
      { $group: { _id: null, total: { $sum: '$workerNetEarnings' } } },
    ]),

    // This week's earnings
    (() => {
      const startOfWeek = new Date(now);
      startOfWeek.setHours(0, 0, 0, 0);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      return Payment.aggregate([
        { $match: { worker: workerId, status: { $in: ['PAID', 'SUCCESS'] }, paymentDate: { $gte: startOfWeek } } },
        { $group: { _id: null, total: { $sum: '$workerNetEarnings' } } },
      ]);
    })(),
  ]);

  res.json({
    success: true,
    data: {
      profile: worker,
      stats: {
        totalEarnings: totalEarningsAgg.length ? totalEarningsAgg[0].total : 0,
        weeklyEarnings: weeklyEarningsAgg.length ? weeklyEarningsAgg[0].total : 0,
        activeJobs: activeJobs.length,
        pendingRequests: pendingRequests.length,
        completedJobs: worker.completedJobs,
        rating: worker.rating,
        ratingCount: worker.ratingCount,
      },
      activeJobs,
      pendingRequests,
      upcomingJobs,
      recentCompleted,
    },
  });
});

// Get job requests (MATCHING / REASSIGNED)
const getJobRequests = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const requests = await Booking.find({
    'candidateWorkers.worker': worker._id,
    status: { $in: ['MATCHING', 'REASSIGNED'] },
  })
    .populate('service', 'name category basePrice')
    .populate('customer', 'name phone avatar')
    .sort({ isEmergency: -1, createdAt: -1 });

  // Attach match score
  const enriched = requests.map((booking) => {
    const candidate = booking.candidateWorkers.find(
      (c) => c.worker.toString() === worker._id.toString()
    );
    const b = booking.toObject();
    b.matchScore = candidate ? candidate.score : 0;
    b.matchReasons = candidate ? candidate.reasons : [];
    return b;
  });

  res.json({ success: true, data: enriched });
});

// Accept a job
const acceptJob = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);
  const workerId = worker._id;

  // Merit suspension gate: suspended / deactivation-review workers cannot earn.
  if (!isWorkerTakeableForJobs(worker)) {
    throw new ApiError(
      'Your reliability status blocks you from accepting jobs. Contact admin support.',
      403
    );
  }

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);

  if (!booking.candidateWorkers.some((c) => c.worker.toString() === workerId.toString())) {
    throw new ApiError('This job was not offered to you', 403);
  }

  if (!['MATCHING', 'ASSIGNED', 'REASSIGNED'].includes(booking.status)) {
    throw new ApiError(`Cannot accept job in ${booking.status} status`, 400);
  }

  booking.worker = workerId;
  booking.status = 'ACCEPTED';
  booking.acceptedAt = new Date();
  booking.matchedScore = booking.candidateWorkers.find(
    (c) => c.worker.toString() === workerId.toString()
  )?.score || 0;
  booking.matchReasons = booking.candidateWorkers.find(
    (c) => c.worker.toString() === workerId.toString()
  )?.reasons || [];
  booking.statusHistory.push({
    status: 'ACCEPTED',
    updatedAt: new Date(),
    updatedBy: req.user._id,
    note: booking.reassignedAt
      ? 'Replacement worker accepted the job'
      : 'Worker accepted the job',
  });
  await booking.save();

  // Notify customer
  await Notification.create({
    user: booking.customer,
    type: 'WORKER_ACCEPTED',
    title: 'Worker accepted your job',
    message: `${req.user.name} accepted your request for ${booking.serviceSnapshot.name}.`,
    data: { bookingId: booking._id },
  });
  const io = getIO();
  if (io) io.to(`customer_${booking.customer}`).emit('booking_update', { bookingId: booking._id, status: 'ACCEPTED' });

  res.json({ success: true, message: 'Job accepted', data: booking });
});

// Reject a job
const rejectJob = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);
  const workerId = worker._id;

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);

  // Remove from candidate list
  booking.candidateWorkers = booking.candidateWorkers.filter(
    (c) => c.worker.toString() !== workerId.toString()
  );
  await booking.save();

  res.json({ success: true, message: 'Job rejected' });
});

// Job history (completed + failed/no-show/expired/reassigned) for the worker
const getJobHistory = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const tab = req.query.tab; // 'completed' | 'failed' | undefined (all)

  const statusFilter =
    tab === 'completed'
      ? { $in: ['COMPLETED'] }
      : tab === 'failed'
      ? { $in: ['WORKER_NO_SHOW', 'EXPIRED', 'REASSIGNED', 'CANCELLED'] }
      : { $in: ['COMPLETED', 'WORKER_NO_SHOW', 'EXPIRED', 'REASSIGNED', 'CANCELLED'] };

  const [jobs, total] = await Promise.all([
    Booking.find({
      worker: worker._id,
      status: statusFilter,
    })
      .populate('service', 'name category')
      .populate('customer', 'name phone avatar')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Booking.countDocuments({
      worker: worker._id,
      status: statusFilter,
    }),
  ]);

  res.json({
    success: true,
    data: {
      jobs,
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    },
  });
});

// Get active jobs
const getActiveJobs = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const jobs = await Booking.find({
    worker: worker._id,
    status: { $in: ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'] },
  })
    .populate('service', 'name category')
    .populate('customer', 'name phone avatar')
    .sort({ updatedAt: -1 });

  // Server-side expiry on the read path: a job whose scheduled window has
  // ended and whose worker never checked in must not surface as an active
  // job (the reliability scheduler later formalises it to EXPIRED / no-show).
  // Genuinely underway jobs (arrived/started/in progress) stay active.
  const nowMs = Date.now();
  const activeReady = jobs.filter((b) => {
    if (b.workerCheckInAt || ['WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(b.status)) return true;
    const { scheduledEndTime } = resolveScheduleTimes(b);
    return !scheduledEndTime || scheduledEndTime.getTime() >= nowMs;
  });

  // Expose the effective schedule + navigation windows (server-derived) so the
  // UI can gate the Navigate / Start buttons from server-authoritative data,
  // including after refresh, app restart or re-login.
  const active = activeReady.map((b) => {
    const { scheduledStartTime, scheduledEndTime } = resolveScheduleTimes(b);
    const { navigationAvailableTime } = getNavigationTimes(b, env.preJobNavigationBufferMins);
    const obj = b.toObject();
    obj.effectiveScheduledStartTime = scheduledStartTime ? scheduledStartTime.toISOString() : null;
    obj.effectiveScheduledEndTime = scheduledEndTime ? scheduledEndTime.toISOString() : null;
    obj.effectiveNavigationAvailableTime = navigationAvailableTime
      ? navigationAvailableTime.toISOString()
      : null;
    obj.navigationBufferMinutes = env.preJobNavigationBufferMins;
    return obj;
  });

  res.json({ success: true, data: active });
});

// Start job
const startJob = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }
  if (booking.status !== 'ACCEPTED' && booking.status !== 'ON_THE_WAY' && booking.status !== 'WORKER_ARRIVED') {
    throw new ApiError(`Cannot start job in ${booking.status} status`, 400);
  }

  // Scheduled jobs can only be started once the scheduled start time arrives.
  enforceScheduledStart(booking);

  // Explicit check-in: only the Start button (not app open) records arrival.
  await recordCheckIn(booking, worker, {
    coordinates: req.body && req.body.coordinates,
  });

  booking.status = 'STARTED';
  booking.statusHistory.push({
    status: 'STARTED',
    updatedAt: new Date(),
    updatedBy: req.user._id,
    note: 'Work started',
  });
  await booking.save();

  res.json({ success: true, message: 'Job started', data: booking });
});

// Worker marks themself as arrived at the customer location (explicit check-in)
const arriveBooking = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }
  if (!['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED'].includes(booking.status)) {
    throw new ApiError(`Cannot mark arrival in ${booking.status} status`, 400);
  }

  const coordinates =
    req.body && (req.body.coordinates || (req.body.location && req.body.location.coordinates));

  const { checkedInAt } = await recordCheckIn(booking, worker, { coordinates });

  if (booking.status !== 'WORKER_ARRIVED') {
    booking.status = 'WORKER_ARRIVED';
    booking.statusHistory.push({
      status: 'WORKER_ARRIVED',
      updatedAt: new Date(),
      updatedBy: req.user._id,
      note: 'Worker arrived at location',
    });
    await booking.save();
  }

  // Late-arrival penalty: arrived past start + tolerance, but before the
  // no-show deadline (else the scheduler marks it as no-show instead).
  const latestBooking = await Booking.findById(booking._id);
  if (latestBooking) {
    const { scheduledStartTime, scheduledEndTime } = resolveScheduleTimes(latestBooking);
    if (scheduledStartTime && scheduledEndTime) {
      const settings = await getSettings();
      const toleranceCutoff = new Date(
        scheduledStartTime.getTime() + settings.lateToleranceMinutes * 60000
      );
      const deadline = new Date(
        scheduledEndTime.getTime() + settings.noShowGraceMinutes * 60000
      );
      if (checkedInAt && checkedInAt > toleranceCutoff && checkedInAt <= deadline) {
        const minutesLate = Math.max(
          1,
          Math.round((checkedInAt.getTime() - scheduledStartTime.getTime()) / 60000)
        );
        await handleLateArrival(worker._id, latestBooking._id, { minutes: minutesLate }).catch(
          (e) => console.error('[reliability] late arrival error:', e.message)
        );
      }
    }
  }

  const io = getIO();
  if (io) io.to(`customer_${booking.customer}`).emit('booking_update', { bookingId: booking._id, status: 'WORKER_ARRIVED' });

  res.json({ success: true, message: 'Arrival recorded', data: { checkedInAt } });
});

// Update worker location (for tracking)
const updateLocation = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  let { coordinates } = req.body;
  if (!coordinates && req.body.location && Array.isArray(req.body.location.coordinates)) {
    coordinates = req.body.location.coordinates;
  }
  if (!coordinates || !Array.isArray(coordinates)) {
    throw new ApiError('Invalid coordinates', 400);
  }

  worker.location = { type: 'Point', coordinates };
  await worker.save();

  await syncWorkerLocation(worker, coordinates);

  res.json({ success: true, message: 'Location updated' });
});

// Complete job
const completeJob = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }
  if (booking.status !== 'STARTED' && booking.status !== 'WORKER_ARRIVED' && booking.status !== 'IN_PROGRESS') {
    throw new ApiError(`Cannot complete job in ${booking.status} status`, 400);
  }

  booking.status = 'COMPLETED';
  booking.completedAt = new Date();
  booking.afterImages = req.files ? req.files.map((f) => f.path) : booking.afterImages;
  booking.statusHistory.push({
    status: 'COMPLETED',
    updatedAt: new Date(),
    updatedBy: req.user._id,
    note: 'Work completed and awaiting customer confirmation',
  });
  await booking.save();

  // Update worker stats
  worker.completedJobs = (worker.completedJobs || 0) + 1;
  await worker.save();

  // Reliability merit points: +completeJob, and +onTime when finished by the
  // effective end time (legacy bookings derive their window from the slot).
  const { scheduledEndTime: effectiveEndTime } = resolveScheduleTimes(booking);
  const onTime = effectiveEndTime ? booking.completedAt <= effectiveEndTime : true;
  try {
    await handleJobCompleted(booking, worker, { onTime });
  } catch (e) {
    console.error('[reliability] completion bonus error:', e.message);
  }

  // Finalize collaboration team (credits collaborators)
  const { completeTeam } = require('../../services/collaborator/teamFormationService');
  await completeTeam(booking._id);

  // New historical data → AI models refresh shortly after
  require('../../services/ai/aiPipelineService').scheduleRetrain();

  // Notify customer
  await Notification.create({
    user: booking.customer,
    type: 'JOB_COMPLETED',
    title: 'Job completed',
    message: `${req.user.name} marked the job as completed. Please confirm.`,
    data: { bookingId: booking._id },
  });
  const io = getIO();
  if (io) io.to(`customer_${booking.customer}`).emit('booking_update', { bookingId: booking._id, status: 'COMPLETED' });

  res.json({ success: true, message: 'Job completed', data: booking });
});

// Confirm completion (customer confirms) → releases the worker's pending
// earning into the wallet. Idempotent: a second call is a no-op.
const confirmCompletion = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id).populate('service', 'name');
  if (!booking) throw new ApiError('Booking not found', 404);
  if (booking.customer.toString() !== req.user._id.toString()) {
    throw new ApiError('Not authorized', 403);
  }
  if (booking.status !== 'COMPLETED') {
    throw new ApiError('Booking not in completed state', 400);
  }

  const wasConfirmed = booking.customerConfirmed;
  booking.customerConfirmed = true;
  booking.customerConfirmedAt = new Date();
  await booking.save();

  // Release the held earning exactly once (ledger CAS guard inside).
  let release = { released: false };
  if (booking.worker) {
    const { releaseEarning } = require('../../services/wallet/walletService');
    release = await releaseEarning({
      bookingId: booking._id,
      workerId: booking.worker,
    });
  }

  // Complete the collaboration team credits (finance finalization).
  const { completeTeam } = require('../../services/collaborator/teamFormationService');
  await completeTeam(booking._id).catch(() => {});

  const io = getIO();
  if (io) io.to(`worker_${booking.worker}`).emit('earning_update', { bookingId: booking._id, released: release.released, amount: release.amount });

  if (!wasConfirmed) {
    await Notification.create({
      user: booking.worker ? (await Worker.findById(booking.worker).select('user'))?.user : undefined,
      type: 'EARNING_RELEASED',
      title: 'Earning released',
      message: release.released
        ? `₹${release.amount} for ${booking.serviceSnapshot?.name || 'your job'} was added to your wallet.`
        : 'Your job was confirmed.',
      data: { bookingId: booking._id },
    });
  }

  res.json({
    success: true,
    message: 'Completion confirmed. Earning released to worker wallet.',
    data: { customerConfirmed: true, earningReleased: release.released, amountReleased: release.amount || 0 },
  });
});

// Worker earnings summary
const getEarnings = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const payments = await Payment.find({
    worker: worker._id,
    status: { $in: ['PAID', 'SUCCESS'] },
  }).populate('booking', 'serviceSnapshot');

  const totalGross = payments.reduce((s, p) => s + (p.workerGross || p.amount), 0);
  const totalCoopDeduction = payments.reduce((s, p) => s + (p.cooperativeDeduction || 0), 0);
  const totalNet = payments.reduce((s, p) => s + (p.workerNetEarnings || 0), 0);

  res.json({
    success: true,
    data: {
      payments,
      summary: {
        totalGross,
        totalCoopDeduction,
        totalNet,
        count: payments.length,
      },
    },
  });
});

// Get worker reviews
const getWorkerReviews = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const Review = require('../../models/Review');
  const reviews = await Review.find({
    reviewee: req.user._id,
    reviewType: 'CUSTOMER_TO_WORKER',
  })
    .populate('reviewer', 'name avatar')
    .sort({ createdAt: -1 });

  res.json({ success: true, data: reviews });
});

// Update job status (worker) - generic for ON_THE_WAY etc.
const updateJobStatus = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }

  const { status } = req.body;
  const allowed = {
    ASSIGNED: ['ACCEPTED'],
    ACCEPTED: ['ON_THE_WAY'],
    ON_THE_WAY: ['WORKER_ARRIVED', 'STARTED'],
    WORKER_ARRIVED: ['STARTED'],
    STARTED: ['IN_PROGRESS'],
    IN_PROGRESS: ['IN_PROGRESS'],
  };

  const next = allowed[booking.status];
  if (!next || !next.includes(status)) {
    throw new ApiError(`Cannot transition from ${booking.status} to ${status}`, 400);
  }

  // Navigation/travel and starting work are each gated on the scheduled times
  // (server time), with their own windows.
  if (status === 'ON_THE_WAY') {
    enforceNavigationAllowed(booking);
  }
  if (status === 'STARTED') {
    enforceScheduledStart(booking);
  }

  // Arrival / work started = explicit check-in.
  if (['WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(status)) {
    await recordCheckIn(booking, worker);
  }

  booking.status = status;
  booking.statusHistory.push({
    status,
    updatedAt: new Date(),
    updatedBy: req.user._id,
    note: `Status updated to ${status}`,
  });
  await booking.save();

  res.json({ success: true, message: `Status updated to ${status}`, data: booking });
});

// Worker cancels a job they had accepted (or are already travelling to / on).
// Note: this is distinct from `rejectJob`, which only ever fires BEFORE
// acceptance. All cancellation policy lives in cancellationService.
const cancelJob = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (!booking.worker || booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }

  const { applyCancellation } = require('../../services/cancellation/cancellationService');
  const result = await applyCancellation({
    booking,
    cancelledBy: 'worker',
    reasonKey: req.body.reasonKey,
    reason: req.body.reason,
    actorId: req.user._id,
  });

  if (result.skipped && result.duplicate) {
    return res.status(200).json({
      success: true,
      message: 'Job was already cancelled',
      data: { booking: result.booking, cancellation: result.cancellation },
    });
  }

  const io = getIO();
  if (io) {
    io.to(`customer_${booking.customer}`).emit('booking_update', {
      bookingId: booking._id,
      status: 'CANCELLED',
      cancelledBy: 'worker',
    });
  }

  res.json({
    success: true,
    message: 'Job cancelled',
    data: { booking: result.booking, cancellation: result.cancellation, outcome: result.outcome },
  });
});

// Preview the merit/financial impact of a worker cancellation before applying.
const previewJobCancel = asyncHandler(async (req, res) => {
  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);
  if (!booking.worker || booking.worker.toString() !== worker._id.toString()) {
    throw new ApiError('Not your job', 403);
  }

  const { calculateCancellationOutcome } = require('../../services/cancellation/cancellationService');
  const outcome = await calculateCancellationOutcome(
    booking,
    'worker',
    req.body.reasonKey || req.query.reasonKey || ''
  );

  res.json({
    success: true,
    data: {
      outcome,
      currentStatus: booking.status,
      meritDelta: outcome.workerMeritPoints,
      compensation: outcome.workerCompensationAmount,
    },
  });
});

module.exports = {
  getWorkerDashboard,
  getJobRequests,
  acceptJob,
  rejectJob,
  getActiveJobs,
  startJob,
  arriveBooking,
  updateLocation,
  completeJob,
  getJobHistory,
  confirmCompletion,
  getEarnings,
  getWorkerReviews,
  updateJobStatus,
  cancelJob,
  previewJobCancel,
  getWorkerId,
};
