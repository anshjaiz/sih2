const Booking = require('../../models/Booking');
const Service = require('../../models/Service');
const Worker = require('../../models/WorkerProfile');
const Customer = require('../../models/CustomerProfile');
const Cancellation = require('../../models/Cancellation');
const Payment = require('../../models/Payment');
const { asyncHandler } = require('../../middleware/errorMiddleware');
const { haversineDistance } = require('../../utils/geoUtils');
const {
  isCustomerSuspended,
  restoreCustomerIfExpired,
} = require('../../services/cancellation/cancellationService');

// Customer dashboard data
const getDashboard = asyncHandler(async (req, res) => {
  const customerId = req.user._id;
  const customer = await Customer.findOne({ user: customerId });

  const now = new Date();

  // Recent/active bookings
  const [upcomingBooking, activeJob, previousJobs, allJobs] = await Promise.all([
    Booking.findOne({
      customer: customerId,
      status: { $in: ['MATCHING', 'REASSIGNED', 'ASSIGNED', 'ACCEPTED'] },
      requestedDate: { $gte: now },
    })
      .populate('service', 'name category icon')
      .sort({ requestedDate: 1 }),

    Booking.findOne({
      customer: customerId,
      status: { $in: ['ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'] },
    })
      .populate('service', 'name category icon')
      .populate('worker', 'rating')
      .sort({ updatedAt: -1 }),

    Booking.find({
      customer: customerId,
      status: { $in: ['COMPLETED', 'CANCELLED', 'DISPUTED'] },
    })
      .populate('service', 'name category')
      .sort({ createdAt: -1 })
      .limit(5),

    Booking.find({ customer: customerId }),
  ]);

  // Total spending
  const payments = await Payment.find({
    customer: customerId,
    status: { $in: ['PAID', 'SUCCESS'] },
  });

  const totalSpending = payments.reduce((sum, p) => sum + p.amount, 0);

  // Recommended services based on history
  const pastCategories = await Booking.distinct('serviceSnapshot.category', {
    customer: customerId,
  });
  let recommendedServices = [];
  if (pastCategories.length) {
    recommendedServices = await Service.find({
      category: { $in: pastCategories },
      isActive: true,
    }).limit(4);
  }
  if (!recommendedServices.length) {
    recommendedServices = await Service.find({ isActive: true }).limit(4);
  }

  // Nearby workers (verified)
  let nearbyWorkers = [];
  if (customer && customer.location && customer.location.coordinates) {
    nearbyWorkers = await Worker.find({
      isActive: true,
      verificationStatus: 'VERIFIED',
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: customer.location.coordinates },
          $maxDistance: 15000,
        },
      },
    })
      .select('user location skills rating completedJobs experienceYears')
      .limit(4);
  }

  res.json({
    success: true,
    data: {
      stats: {
        totalBookings: allJobs.length,
        totalSpending,
        completedBookings: allJobs.filter((b) => b.status === 'COMPLETED').length,
      },
      cancellation: {
        outstandingCancellationBalance: customer?.outstandingCancellationBalance || 0,
        suspensionStatus: customer?.suspensionStatus || 'ACTIVE',
        autoSuspended: customer?.autoSuspended || false,
        suspendedUntil: customer?.suspendedUntil || null,
        suspensionReason: customer?.suspensionReason || '',
        meritScore: customer?.meritScore ?? 100,
        strikesCount: (customer?.cancellationStats?.strikes || []).length,
      },
      upcomingBooking,
      activeJob,
      previousJobs,
      recommendedServices,
      nearbyWorkers: nearbyWorkers.map((w) => {
        let distance = null;
        if (customer?.location) {
          distance = haversineDistance(customer.location.coordinates, w.location.coordinates);
        }
        return { ...w.toObject(), distanceKm: distance ? +distance.toFixed(1) : null };
      }),
    },
  });
});

// Get customer bookings
const getBookings = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = { customer: req.user._id };
  if (status) filter.status = status;

  const bookings = await Booking.find(filter)
    .populate('service', 'name category icon')
    .populate('worker', 'rating verificationStatus completedJobs')
    .sort({ createdAt: -1 });

  res.json({ success: true, data: bookings });
});

// Get customer profile
const getCustomerProfile = asyncHandler(async (req, res) => {
  let customer = await Customer.findOne({ user: req.user._id }).lean();
  if (customer) {
    customer = await restoreCustomerIfExpired(customer);
  }
  res.json({
    success: true,
    data: customer,
    suspension: customer
      ? {
          currentlySuspended: isCustomerSuspended(customer),
          suspendedUntil: customer.suspendedUntil,
          suspensionReason: customer.suspensionReason,
        }
      : null,
  });
});

// Cancellation history for the logged-in customer (audit-trail / profile page).
const getCustomerCancellations = asyncHandler(async (req, res) => {
  const list = await Cancellation.find({ customer: req.user._id })
    .populate('booking', 'bookingNumber serviceSnapshot')
    .sort({ cancelledAt: -1 });

  res.json({
    success: true,
    data: list.map((c) => ({
      id: c._id,
      bookingNumber: c.bookingNumber,
      serviceName: c.booking?.serviceSnapshot?.name || c.booking?.serviceSnapshot?.serviceName || '—',
      cancelledAt: c.cancelledAt,
      stage: c.stage,
      penaltyEligible: c.penaltyEligible,
      customerPenaltyAmount: c.customerPenaltyAmount,
      customerPenaltySettled: c.customerPenaltySettled,
      workerCompensationAmount: c.workerCompensationAmount,
      reasonKey: c.reasonKey,
      reason: c.reason,
      cancelledBy: c.cancelledBy,
    })),
  });
});

// Update customer profile
const updateCustomerProfile = asyncHandler(async (req, res) => {
  const customer = await Customer.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: {
        address: req.body.address ?? undefined,
        location: req.body.location ?? undefined,
        city: req.body.city ?? undefined,
        defaultContact: req.body.defaultContact ?? undefined,
        preferredLanguages: req.body.preferredLanguages ?? undefined,
      },
    },
    { new: true, upsert: true }
  );

  res.json({ success: true, message: 'Profile updated', data: customer });
});

module.exports = {
  getDashboard,
  getBookings,
  getCustomerProfile,
  getCustomerCancellations,
  updateCustomerProfile,
};
