/**
 * adminCancellationController.js
 *
 * Admin oversight for the central cancellation system:
 *  - list/search cancellations with filters
 *  - preview an admin-initiated cancellation before applying
 *  - cancel a booking on the customer's / platform's behalf
 *  - view the authoritative cancellation reason lists (customers + workers)
 */

const Booking = require('../../models/Booking');
const Cancellation = require('../../models/Cancellation');
const Customer = require('../../models/CustomerProfile');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const {
  applyCancellation,
  calculateCancellationOutcome,
  getCancellationReasons,
} = require('../../services/cancellation/cancellationService');
const { getSettings } = require('../../services/reliability/reliabilityConfig');

// GET /admin/cancellations
const listCancellations = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { cancelledBy, stage, penaltyEligible, search } = req.query;

  const q = {};
  if (cancelledBy) q.cancelledBy = cancelledBy;
  if (stage) q.stage = stage;
  if (penaltyEligible === 'true') q.penaltyEligible = true;
  if (penaltyEligible === 'false') q.penaltyEligible = false;
  if (search) {
    q.$or = [
      { bookingNumber: { $regex: search, $options: 'i' } },
      { reason: { $regex: search, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    Cancellation.find(q)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('customer', 'name email phone avatar')
      .populate('worker', 'user'),
    Cancellation.countDocuments(q),
  ]);

  const workers = await getWorkersById(items);

  res.json({
    success: true,
    data: {
      cancellations: items.map((c) => ({
        ...c.toObject(),
        workerUser: workers.get(String(c.worker?._id)) || null,
      })),
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    },
  });
});

const getWorkersById = async (items) => {
  const workerIds = items.map((c) => c.worker?._id).filter(Boolean);
  if (!workerIds.length) return new Map();
  const Worker = require('../../models/WorkerProfile');
  const docs = await Worker.find({ _id: { $in: workerIds } })
    .populate('user', 'name email phone')
    .lean();
  return new Map(docs.map((d) => [String(d._id), d]));
};

// GET /admin/cancellations/reasons — authoritative reason lists for the UI
const getReasons = asyncHandler(async (req, res) => {
  res.json({ success: true, data: getCancellationReasons() });
});

// GET /admin/cancellations/:id
const getCancellationDetail = asyncHandler(async (req, res) => {
  const c = await Cancellation.findById(req.params.id)
    .populate('booking')
    .populate('customer', 'name email phone avatar')
    .populate('worker', 'user');
  if (!c) throw new ApiError('Cancellation not found', 404);
  const settings = await getSettings();
  const balance = await Customer.findOne({ user: c.customer }).select(
    'outstandingCancellationBalance suspensionStatus suspendedUntil'
  );
  res.json({
    success: true,
    data: { cancellation: c, config: settings.cancellation, customer: balance },
  });
});

// POST /admin/cancellations/preview?bookingId=... on a booking
const previewAdminCancellation = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId || req.body.bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);

  const outcome = await calculateCancellationOutcome(
    booking,
    'admin',
    req.body.reasonKey || req.query.reasonKey || ''
  );
  res.json({ success: true, data: { outcome, currentStatus: booking.status } });
});

// POST /admin/cancellations/:bookingId
const cancelBookingForAdmin = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);

  const result = await applyCancellation({
    booking,
    cancelledBy: 'admin',
    reasonKey: req.body.reasonKey,
    reason: req.body.reason,
    actorId: req.user._id,
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

module.exports = {
  listCancellations,
  getCancellationDetail,
  getReasons,
  previewAdminCancellation,
  cancelBookingForAdmin,
};