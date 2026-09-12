const Booking = require('../../models/Booking');
const Service = require('../../models/Service');
const Worker = require('../../models/WorkerProfile');
const Notification = require('../../models/Notification');
const Customer = require('../../models/CustomerProfile');
const Invoice = require('../../models/Invoice');
const Payment = require('../../models/Payment');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const { matchWorkersForBooking } = require('../../services/matching/matchingService');
const { computePriceBreakdown } = require('../../utils/pricingUtils');
const { deriveScheduleWindow } = require('../../utils/scheduleUtils');
const Cooperative = require('../../models/Cooperative');
const { getIO } = require('../../config/socket');

// Create a service request
const createServiceRequest = asyncHandler(async (req, res) => {
  const {
    serviceId,
    description,
    address,
    location,
    area,
    city,
    requestedDate,
    timeSlot,
    startTime,
    endTime,
    isEmergency,
    emergencyType,
  } = req.body;

  if (!serviceId) throw new ApiError('Service is required', 400);

  const service = await Service.findById(serviceId);
  if (!service) throw new ApiError('Service not found', 404);

  if (!location || !location.coordinates) {
    throw new ApiError('Location is required', 400);
  }

  // ── Cancellation-policy gate ──────────────────────────────────────────
  // Auto-suspended customers (repeated eligible cancellations) cannot start
  // new bookings until the suspension window passes. Uses the single shared
  // enforcement helper so create/confirm/reassign all behave identically.
  // (Thrown as 429 to preserve the earlier contract of this endpoint.)
  const { enforceCustomerNotSuspended } = require('../../services/cancellation/cancellationService');
  let custProfile;
  try {
    custProfile = await enforceCustomerNotSuspended(req.user._id);
  } catch (e) {
    if (e.code === 'ACCOUNT_SUSPENDED') {
      throw new ApiError(
        `Your account is temporarily suspended until ${e.suspendedUntil ? new Date(e.suspendedUntil).toLocaleDateString() : 'an unknown date'} due to repeated eligible cancellations.`,
        429
      );
    }
    throw e;
  }

  // Compute price. No material estimate at booking time — the customer is not
  // expected to know material costs before the worker visits. Materials are
  // added later only via the worker's + customer-approved material request.
  const coop = await Cooperative.findOne().sort({ createdAt: -1 });
  const priceBreakdown = computePriceBreakdown(
    service.basePrice,
    0,
    coop
  );

  // Absolute schedule window used by the reliability scheduler
  const schedule = deriveScheduleWindow(requestedDate, timeSlot, {
    isEmergency,
    explicitStartTime: startTime,
    explicitEndTime: endTime,
  });

  // Create booking with REQUESTED status
  const outstanding = custProfile?.outstandingCancellationBalance || 0;
  const carriedFrom = await require('../../models/Cancellation')
    .findOne({ customer: req.user._id, customerPenaltySettled: false, customerPenaltyAmount: { $gt: 0 } })
    .sort({ createdAt: -1 })
    .select('booking bookingNumber')
    .lean();

  const booking = await Booking.create({
    customer: req.user._id,
    service: service._id,
    carriedCancellationBalance: Math.round(outstanding * 100) / 100,
    carriedFromBooking: carriedFrom?.booking || null,
    serviceSnapshot: {
      name: service.name,
      category: service.category,
      basePrice: service.basePrice,
      unit: service.unit,
    },
    requiredSkillIds: service.requiredSkillRefs || [],
    requiredSkillNames: service.requiredSkills || [],
    description,
    problemImages: req.files ? req.files.map((f) => f.path) : [],
    location: {
      type: 'Point',
      coordinates: location.coordinates,
    },
    address,
    area,
    city,
    requestedDate: new Date(requestedDate),
    timeSlot,
    scheduledDate: schedule.scheduledDate,
    scheduledStartTime: schedule.scheduledStartTime,
    scheduledEndTime: schedule.scheduledEndTime,
    isEmergency,
    emergencyType,
    priceBreakdown,
    status: 'REQUESTED',
    statusHistory: [
      {
        status: 'REQUESTED',
        updatedAt: new Date(),
        updatedBy: req.user._id,
        note: isEmergency ? 'Emergency request created' : 'Service request created',
      },
    ],
  });

  // Update customer stats
  await Customer.findOneAndUpdate(
    { user: req.user._id },
    { $inc: { bookingsCount: 1 } },
    { upsert: true }
  );

  // Notify customer
  await Notification.create({
    user: req.user._id,
    type: 'BOOKING_CREATED',
    title: 'Booking created',
    message: `Your request for ${service.name} has been created (${booking.bookingNumber}). We are finding workers.`,
    data: { bookingId: booking._id, bookingNumber: booking.bookingNumber },
  });

  // Notify admins for emergency
  if (isEmergency) {
    const adminUsers = await require('../../models/User').find({ role: 'admin' });
    if (adminUsers.length) {
      await Notification.create(
        adminUsers.map((a) => ({
          user: a._id,
          type: 'EMERGENCY_REQUEST',
          title: 'Emergency request',
          message: `Emergency: ${service.name} requested by customer. Need priority action.`,
          data: { bookingId: booking._id },
        }))
      );
    }
  }

  // Queue matching to happen
  // Since this may take time, we set status to MATCHING and do matching
  // asynchronously (in real system would use a job queue)
  booking.status = 'MATCHING';
  booking.statusHistory.push({
    status: 'MATCHING',
    updatedAt: new Date(),
    note: 'Looking for suitable workers',
  });

  // Find matching workers
  const candidates = await matchWorkersForBooking(
    {
      service,
      location: location.coordinates,
      requestedDate: new Date(requestedDate),
      isEmergency,
      city,
    },
    isEmergency ? 3 : 10
  );

  booking.candidateWorkers = candidates.map((c) => ({
    worker: c.worker,
    score: c.score,
    reasons: c.reasons,
  }));

  await booking.save();

  // Notify candidate workers via socket
  const io = getIO();
  if (io) {
    for (const candidate of candidates) {
      io.to(`worker_${candidate.worker}`).emit('new_job', {
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
        serviceName: service.name,
        isEmergency,
        score: candidate.score,
      });
    }
  }

  // Notify workers in DB
  const workerNotifications = [];
  for (const c of candidates) {
    const candidateWorker = await Worker.findById(c.worker).select('user');
    if (candidateWorker && candidateWorker.user) {
      workerNotifications.push({
        user: candidateWorker.user,
        type: 'NEW_JOB',
        title: 'New job available',
        message: `${isEmergency ? '⚠️ EMERGENCY: ' : ''}${service.name} job in your area. Match score ${c.score}/100.`,
        data: { bookingId: booking._id, score: c.score },
      });
    }
  }
  await Notification.create(workerNotifications);

  res.status(201).json({
    success: true,
    message: 'Service request created. Finding suitable workers...',
    data: {
      booking,
      candidateWorkers: booking.candidateWorkers,
      priceBreakdown,
    },
  });
});

const getBookingById = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('service')
    .populate('customer', 'name phone avatar')
    .populate('worker', 'verificationStatus rating')
    .populate('payment');

  if (!booking) throw new ApiError('Booking not found', 404);

  // Check authorization
  const workerProfile = await Worker.findOne({ user: req.user._id });
  const isWorker = req.user.role === 'worker';
  // 'customer' is populated -> compare by ._id, not toString() of the doc
  const customerId = booking.customer ? booking.customer._id || booking.customer : null;
  const bookingWorkerId = booking.worker ? booking.worker._id || booking.worker : null;
  const isOwner = customerId ? customerId.toString() === req.user._id.toString() : false;

  if (req.user.role === 'admin') {
    // admin can access all
  } else if (isWorker) {
    const candidate = booking.candidateWorkers.some(
      (c) => c.worker && c.worker.toString() === workerProfile?._id.toString()
    );
    if (bookingWorkerId && bookingWorkerId.toString() === workerProfile?._id.toString()) {
      // worker of this booking
    } else if (candidate) {
      // candidate
    } else {
      throw new ApiError('Not authorized to view this booking', 403);
    }
  } else if (!isOwner) {
    throw new ApiError('Not authorized to view this booking', 403);
  }

  res.json({ success: true, data: booking });
});

const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);

  const isOwner = booking.customer.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    throw new ApiError('Not authorized', 403);
  }

  const { applyCancellation } = require('../../services/cancellation/cancellationService');
  const result = await applyCancellation({
    booking,
    cancelledBy: req.user.role === 'admin' ? 'admin' : 'customer',
    reasonKey: req.body.reasonKey,
    reason: req.body.reason,
    actorId: req.user._id,
    // Money already paid for this booking is refunded through the payment
    // service after the central outcome is recorded.
    refundHandler: async (claimedBooking, outcome) => {
      if (claimedBooking.payment && ['PAID', 'SUCCESS'].includes(claimedBooking.paymentStatus)) {
        const { initiateRefund } = require('../../services/payment/paymentService');
        const refund = await initiateRefund(claimedBooking.payment, {
          initiatedBy: req.user._id,
          method: 'MOCK_REFUND',
          amount: claimedBooking.priceBreakdown?.total || undefined,
        });
        await Booking.updateOne(
          { _id: claimedBooking._id },
          {
            $push: {
              statusHistory: {
                status: 'CANCELLED',
                updatedAt: new Date(),
                updatedBy: req.user._id,
                note: `Refund initiated (${refund.refundNumber || refund._id})`,
              },
            },
          }
        );
        await Notification.create({
          user: booking.customer,
          type: 'REFUND_STATUS',
          title: 'Refund initiated',
          message: `Your refund of ₹${refund.amount} for ${booking.bookingNumber} is being processed.`,
          data: { bookingId: booking._id, refundId: refund._id, refundNumber: refund.refundNumber },
        });
      }
    },
  });

  if (result.skipped && result.duplicate) {
    return res.status(200).json({
      success: true,
      message: 'Booking was already cancelled',
      data: { booking: result.booking, cancellation: result.cancellation },
    });
  }

  res.json({
    success: true,
    message: 'Booking cancelled',
    data: { booking: result.booking, cancellation: result.cancellation, outcome: result.outcome },
  });
});

// Preview what a cancellation would mean WITHOUT applying it. Lets the UI
// show the fee / compensation / strike before the customer commits.
const previewCancellation = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);

  const isOwner = booking.customer.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    throw new ApiError('Not authorized', 403);
  }

  const { calculateCancellationOutcome } = require('../../services/cancellation/cancellationService');
  const outcome = await calculateCancellationOutcome(
    booking,
    req.user.role === 'admin' ? 'admin' : 'customer',
    req.body.reasonKey || req.query.reasonKey || ''
  );
  const settings = await require('../../services/reliability/reliabilityConfig').getSettings();

  res.json({
    success: true,
    data: {
      outcome,
      currentStatus: booking.status,
      outstandingAfterPreview: outcome.customerPenaltyAmount,
      compensationToWorker: outcome.workerCompensationAmount,
      config: {
        customerCancelFee: settings.cancellation.customerCancelFee,
        workerCompensation: settings.cancellation.workerCompensation,
        freeCancelBeforeAccept: settings.cancellation.freeCancelBeforeAccept,
      },
    },
  });
});

// Request a replacement worker after a no-show / worker failure
const requestReassignment = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError('Booking not found', 404);

  // Suspended customers cannot use restricted account actions (reassignment
  // re-enters the job market on their behalf).
  const { enforceCustomerNotSuspended } = require('../../services/cancellation/cancellationService');
  await enforceCustomerNotSuspended(req.user._id).catch((e) => {
    if (e.code === 'ACCOUNT_SUSPENDED') {
      throw new ApiError(`Your account is temporarily suspended. ${e.message}`, 429);
    }
    throw e;
  });

  const isOwner = booking.customer.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    throw new ApiError('Not authorized', 403);
  }

  if (!['WORKER_NO_SHOW', 'REASSIGNED', 'EXPIRED'].includes(booking.status)) {
    throw new ApiError(`Cannot request a replacement in ${booking.status} status`, 400);
  }

  const { attemptReassignment } = require('../../services/reliability/reliabilityService');
  const result = await attemptReassignment(booking, { reason: 'CUSTOMER_REQUEST' });

  if (result.reassigned) {
    return res.json({
      success: true,
      message: 'Looking for a replacement worker',
      data: { status: 'REASSIGNED', candidateCount: result.candidateCount },
    });
  }
  return res.json({
    success: false,
    message: 'No replacement worker available right now. Please try later or contact support.',
    data: { status: 'EXPIRED' },
  });
});

module.exports = {
  createServiceRequest,
  getBookingById,
  cancelBooking,
  previewCancellation,
  requestReassignment,
};
