/**
 * adminPaymentController.js
 *
 * Admin-only payment & payout overview + payout lifecycle management.
 * Gates: every route is protected by authorize('admin') at the route layer.
 */

const Payment = require('../../models/Payment');
const Payout = require('../../models/Payout');
const Booking = require('../../models/Booking');
const WorkerWallet = require('../../models/WorkerWallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Worker = require('../../models/WorkerProfile');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const walletService = require('../../services/wallet/walletService');
const { createNotification } = require('../../services/notification/notificationService');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// GET /api/admin/payments/overview
const getPaymentOverview = asyncHandler(async (req, res) => {
  const [
    collectedAgg,
    platformAgg,
    workerAgg,
    refundAgg,
    failedAgg,
    payoutPendingAgg,
    payoutCompletedAgg,
    completedPaymentsAgg,
    compAgg,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ['PAID', 'SUCCESS'] } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: { $in: ['PAID', 'SUCCESS'] } } },
      { $group: { _id: null, total: { $sum: '$platformFee' } } },
    ]),
    Payment.aggregate([
      { $match: { status: { $in: ['PAID', 'SUCCESS'] } } },
      { $group: { _id: null, total: { $sum: '$workerNetEarnings' } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'REFUNDED' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'FAILED' } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { status: 'PENDING' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payout.aggregate([
      { $match: { status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Booking.countDocuments({ paymentStatus: 'PAID' }),
    // Cancellation travel compensation actually credited to workers
    WalletTransaction.aggregate([
      { $match: { type: 'ADJUSTMENT', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  // Recent payments, latest first.
  const recent = await Payment.find({})
    .populate('customer', 'name email')
    .populate('worker', 'user')
    .populate('booking', 'bookingNumber serviceSnapshot')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  res.json({
    success: true,
    data: {
      overview: {
        totalCollected: round2(collectedAgg[0]?.total || 0),
        paidPaymentsCount: collectedAgg[0]?.count || 0,
        platformRevenue: round2(platformAgg[0]?.total || 0),
        workerEarnings: round2(workerAgg[0]?.total || 0),
        refunds: round2(refundAgg[0]?.total || 0),
        refundCount: refundAgg[0]?.count || 0,
        failedCount: failedAgg[0]?.count || 0,
        pendingPayouts: round2(payoutPendingAgg[0]?.total || 0),
        pendingPayoutCount: payoutPendingAgg[0]?.count || 0,
        completedPayouts: round2(payoutCompletedAgg[0]?.total || 0),
        workerCompensationPaid: round2(compAgg[0]?.total || 0),
        workerCompensationCount: compAgg[0]?.count || 0,
        paidBookings: completedPaymentsAgg || 0,
      },
      recent,
    },
  });
});

// GET /api/admin/payments  (all payments, filtered)
const getAllPayments = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const payments = await Payment.find(filter)
    .populate('customer', 'name email')
    .populate('worker', 'user')
    .populate('booking', 'bookingNumber serviceSnapshot')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ success: true, data: payments });
});

// GET /api/admin/payments/compensations — travel compensation credited to workers
const getAllCompensations = asyncHandler(async (req, res) => {
  const compensations = await WalletTransaction.find({
    type: 'ADJUSTMENT',
    status: 'COMPLETED',
  })
    .populate('worker', 'user')
    .populate('booking', 'bookingNumber serviceSnapshot')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ success: true, data: compensations });
});

// GET /api/admin/payouts
const getAllPayouts = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const payouts = await Payout.find(filter)
    .populate('worker', 'user')
    .populate('payoutMethodId')
    .sort({ requestedAt: -1 })
    .limit(200);

  res.json({ success: true, data: payouts });
});

// PUT /api/admin/payouts/:id/status  { status, transactionReference, failureReason }
const updatePayoutStatus = asyncHandler(async (req, res) => {
  const { status, transactionReference, failureReason } = req.body;
  if (!['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
    throw new ApiError('Invalid payout status', 400);
  }

  let payout;
  try {
    payout = await walletService.setPayoutStatus({
      payoutId: req.params.id,
      status,
      adminId: req.user._id,
      transactionReference,
      failureReason,
    });
  } catch (err) {
    throw new ApiError(err.userMessage || 'Could not update payout', 400);
  }

  // Notify the worker.
  const workerUser = await Worker.findById(payout.worker).select('user');
  await createNotification({
    user: workerUser?.user,
    type: 'WITHDRAWAL_UPDATED',
    title:
      status === 'COMPLETED'
        ? 'Withdrawal completed'
        : status === 'FAILED'
        ? 'Withdrawal failed'
        : status === 'PROCESSING'
        ? 'Withdrawal is being processed'
        : 'Withdrawal cancelled',
    message:
      status === 'COMPLETED'
        ? `Withdrawal of ₹${payout.amount} has been paid out (${payout.payoutNumber}).`
        : status === 'FAILED'
        ? `Withdrawal of ₹${payout.amount} failed. Funds were returned to your wallet. ${failureReason || ''}`.trim()
        : status === 'PROCESSING'
        ? `Withdrawal of ₹${payout.amount} is being processed (${payout.payoutNumber}).`
        : `Withdrawal of ₹${payout.amount} was cancelled. Funds were returned to your wallet.`,
    data: { payoutId: payout._id, payoutNumber: payout.payoutNumber, status },
  });

  res.json({ success: true, message: `Payout ${status}`, data: payout });
});

module.exports = { getPaymentOverview, getAllPayments, getAllCompensations, getAllPayouts, updatePayoutStatus };