const Booking = require('../../models/Booking');
const Payment = require('../../models/Payment');
const Invoice = require('../../models/Invoice');
const Worker = require('../../models/WorkerProfile');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const paymentService = require('../../services/payment/paymentService');
const { computeWorkerEarnings } = require('../../utils/pricingUtils');
const Cooperative = require('../../models/Cooperative');
const { getIO } = require('../../config/socket');

// Initiate payment for a booking
const initiatePayment = asyncHandler(async (req, res) => {
  const { bookingId, method = 'MOCK_REDIRECT' } = req.body;

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);

  // Only customer or admin can initiate
  const isOwner = booking.customer.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    throw new ApiError('Not authorized', 403);
  }

  if (booking.status === 'COMPLETED' && !booking.customerConfirmed) {
    // Requires confirmation first
  }

  if (booking.status !== 'COMPLETED') {
    throw new ApiError('Booking must be completed before payment', 400);
  }

  // Idempotency guard: an already-processed payment must not be re-created
  if (booking.payment) {
    const existingPayment = await Payment.findById(booking.payment);
    if (existingPayment && existingPayment.status === 'SUCCESS') {
      const existingInvoice = booking.invoice ? await Invoice.findById(booking.invoice) : null;
      return res.json({
        success: true,
        message: 'Payment already processed',
        alreadyProcessed: true,
        data: {
          payment: existingPayment,
          invoice: existingInvoice,
          result: { status: 'SUCCESS', transactionId: existingPayment.transactionId },
        },
      });
    }
  }

  const coop = await Cooperative.findOne().sort({ createdAt: -1 });
  const workerProfile = booking.worker ? await Worker.findById(booking.worker) : null;
  const carriedAmount = Math.round((booking.carriedCancellationBalance || 0) * 100) / 100;

  // Create payment
  const payment = await paymentService.createPayment({
    booking: booking._id,
    customer: booking.customer,
    worker: booking.worker,
    amount: booking.priceBreakdown.total + carriedAmount,
    carriedCancellationBalance: carriedAmount,
    labourAmount: booking.priceBreakdown.labour,
    materialsAmount: booking.priceBreakdown.materials,
    cooperativeContribution: booking.priceBreakdown.cooperativeContribution,
    platformFee: booking.priceBreakdown.platformFee,
    method,
    gateway: 'mock',
    // Worker earnings
    workerGross: booking.priceBreakdown.labour,
    cooperativeDeduction: (booking.priceBreakdown.labour * (coop?.cooperativeContributionPercent || 2)) / 100,
    workerNetEarnings:
      booking.priceBreakdown.labour -
      (booking.priceBreakdown.labour * (coop?.cooperativeContributionPercent || 2)) / 100,
  });

  // Attach to booking
  booking.payment = payment._id;
  await booking.save();

  // Process payment (mock - instant success)
  const result = await paymentService.processPayment(payment, { amount: payment.amount });

  // Update booking payment status
  if (result.status === 'SUCCESS') {
    // Create invoice
    const invoice = await Invoice.create({
      booking: booking._id,
      customer: booking.customer,
      worker: booking.worker,
      service: booking.serviceSnapshot.name,
      serviceDate: booking.completedAt,
      labourCost: payment.labourAmount,
      materials: payment.materialsAmount,
      cooperativeContribution: payment.cooperativeContribution,
      fees: payment.platformFee,
      total: payment.amount,
      paymentStatus: 'PAID',
      payment: payment._id,
    });

    booking.invoice = invoice._id;
    await booking.save();

    // Update worker earnings and stats
    if (workerProfile) {
      workerProfile.totalEarnings = (workerProfile.totalEarnings || 0) + payment.workerNetEarnings;
      await workerProfile.save();
    }

    // Settle any cancellation balance carried from a previous cancelled
    // booking — now that this payment has actually succeeded.
    if (carriedAmount > 0) {
      const { settleCarriedCancellationBalance } = require('../../services/cancellation/cancellationService');
      const updated = await Booking.findById(booking._id).catch(() => null);
      if (updated) {
        await settleCarriedCancellationBalance({ booking: updated }).catch((e) =>
          console.error('[payment] cancellation settlement error:', e.message)
        );
      }
    }

    // Notify customer & worker
    await Notification.create([
      {
        user: booking.customer,
        type: 'PAYMENT_SUCCESS',
        title: 'Payment successful',
        message: `Payment of ₹${payment.amount} successful. Invoice: ${invoice.invoiceNumber}`,
        data: { bookingId: booking._id, invoiceId: invoice._id },
      },
      {
        user: workerProfile ? workerProfile.user : undefined,
        type: 'PAYMENT_RECEIVED',
        title: 'Payment received',
        message: `You earned ₹${payment.workerNetEarnings} for this job (₹${payment.workerGross} gross).`,
        data: { bookingId: booking._id, paymentId: payment._id },
      },
    ].filter((n) => n.user));

    const io = getIO();
    if (io) {
      io.to(`customer_${booking.customer}`).emit('payment_update', { bookingId: booking._id, status: 'SUCCESS', invoiceId: invoice._id });
      if (booking.worker) io.to(`worker_${booking.worker}`).emit('payment_update', { bookingId: booking._id, status: 'SUCCESS' });
    }

    return res.json({
      success: true,
      message: 'Payment successful',
      data: {
        payment,
        invoice,
        result,
      },
    });
  }

  res.json({
    success: false,
    message: 'Payment failed',
    data: { payment },
  });
});

// Payment status for booking
const getPaymentForBooking = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const payment = await require('../../models/Payment').findOne({ booking: bookingId });
  if (!payment) throw new ApiError('Payment not found', 404);

  // Authorization
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);
  const isOwner = booking.customer.toString() === req.user._id.toString();
  if (!isOwner && req.user.role !== 'admin') {
    // Check if worker
    const worker = await Worker.findOne({ user: req.user._id });
    if (!worker || booking.worker.toString() !== worker._id.toString()) {
      throw new ApiError('Not authorized', 403);
    }
  }

  res.json({ success: true, data: payment });
});

module.exports = {
  initiatePayment,
  getPaymentForBooking,
};
