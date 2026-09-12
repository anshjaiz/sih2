/**
 * Payment Abstraction Layer
 *
 * For SIH prototype, uses a MOCK payment system.
 * Designed so Razorpay/other gateways can be plugged in later
 * via the same interface.
 *
 * Gateway implementations:
 *  - mock: instant success (can simulate failure)
 *  - razorpay: (future) - implement processPayment
 */

const Payment = require('../../models/Payment');
const Refund = require('../../models/Refund');
const Invoice = require('../../models/Invoice');
const Booking = require('../../models/Booking');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { razorpayKeyId, razorpayKeySecret } = require('../../config/env');
const { generateRef } = require('../../utils/authHelper');
const { asyncHandler } = require('../../middleware/errorMiddleware');
const { createNotification } = require('../notification/notificationService');
const { reverseEarning } = require('../wallet/walletService');

// A Razorpay client is only constructed when real keys exist.
let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
  razorpay = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
}

/**
 * Which gateway is active? 'razorpay' when test keys are configured,
 * otherwise the built-in 'mock' gateway (instant success, offline demo).
 */
const getGateway = () => (razorpay ? 'razorpay' : 'mock');

// ============ Gateway-agnostic interface ============

/**
 * Create a payment record
 * @param {Object} paymentData
 */
const createPayment = async (paymentData) => {
  const transactionId = `TXN-${Date.now()}-${Math.floor(100000 + Math.random() * 900000)}`;
  const payment = await Payment.create({
    ...paymentData,
    transactionId,
    status: 'PENDING',
  });
  return payment;
};

/**
 * Create the payment record + the gateway order.
 *
 * Razorpay orders are real TEST-mode orders (amount in paise). The amount is
 * ALWAYS taken from the booking's backend-computed priceBreakdown.total —
 * never from the client.
 *
 * @returns {Object} { payment, order, keyId }
 */
const createOrder = async ({ booking, customer, worker, method }) => {
  const serviceAmount = booking.priceBreakdown?.total || 0;
  const carriedAmount = Math.round((booking.carriedCancellationBalance || 0) * 100) / 100;
  const amount = serviceAmount + carriedAmount;
  if (!(amount > 0)) {
    const err = new Error('Invalid amount');
    err.userMessage = 'Could not compute a valid payment amount for this booking.';
    throw err;
  }

  // Earnings split computed on the backend so the frontend can never tamper.
  const { computeEarningsSplit } = require('../../utils/pricingUtils');
  const Cooperative = require('../../models/Cooperative');
  const coop = await Cooperative.findOne().sort({ createdAt: -1 });

  const split = computeEarningsSplit(
    booking.priceBreakdown.labour,
    booking.priceBreakdown.materials || 0,
    coop
  );

  const payment = await createPayment({
    booking: booking._id,
    customer,
    worker,
    amount,
    carriedCancellationBalance: carriedAmount,
    labourAmount: split.labour,
    materialsAmount: split.materials,
    cooperativeContribution: split.cooperativeContribution,
    platformFee: split.platformFee,
    method: method || 'UPI',
    gateway: getGateway(),
    workerGross: split.workerGross,
    cooperativeDeduction: split.cooperativeDeduction,
    workerNetEarnings: split.workerNetEarnings,
  });

  let order = null;
  let keyId = '';

  if (getGateway() === 'razorpay') {
    const rzOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `TX-${payment._id}`,
      notes: { booking: String(booking._id), customer: String(customer) },
    });
    order = { id: rzOrder.id, amount: rzOrder.amount, currency: rzOrder.currency };
    keyId = razorpayKeyId;
    payment.razorpayOrderId = rzOrder.id;
    payment.status = 'CREATED';
  } else {
    // MOCK gateway: a locally-signed pseudo order id.
    order = { id: `mock_${payment._id}`, amount: payment.amount, currency: 'INR' };
    payment.razorpayOrderId = order.id; // verifyOrder checks against this
    payment.status = 'CREATED';
  }

  // Booking paymentStatus → PENDING as soon as an order exists.
  booking.paymentStatus = 'PENDING';
  booking.payment = payment._id;
  await Promise.all([payment.save(), booking.save()]);

  return { payment, order, keyId, gateway: getGateway() };
};

/**
 * Server-side verification.
 *  - Razorpay: HMAC-SHA256 of `order_id|payment_id` signed by the secret.
 *  - MOCK:     order id owns the booking and hasn't been paid yet.
 * Returns the completed Payment.
 */
const verifyOrder = async ({ payment, razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
  if (!payment || !payment._id) {
    const err = new Error('Payment not found');
    err.userMessage = 'This booking has already been paid.';
    err.code = 'DUPLICATE';
    throw err;
  }

  // Idempotency: an already PAID payment short-circuits.
  if (payment.status === 'PAID' || payment.status === 'SUCCESS') {
    const dup = new Error('Duplicate payment');
    dup.userMessage = 'This booking has already been paid.';
    dup.code = 'DUPLICATE';
    throw dup;
  }
  if (!['CREATED', 'PENDING'].includes(payment.status)) {
    const err = new Error('Payment not payable');
    err.userMessage = `Payment is in ${payment.status} state and cannot be verified.`;
    throw err;
  }

  if (payment.gateway === 'razorpay') {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      const err = new Error('Missing verification payload');
      err.userMessage = 'Payment verification failed. Your booking has not been marked as paid.';
      throw err;
    }
    if (payment.razorpayOrderId && razorpay_order_id !== payment.razorpayOrderId) {
      const err = new Error('Order mismatch');
      err.userMessage = 'Payment verification failed. Your booking has not been marked as paid.';
      throw err;
    }
    const expected = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature) {
      const err = new Error('Signature mismatch');
      err.userMessage = 'Payment verification failed. Your booking has not been marked as paid.';
      throw err;
    }
    // Mark paid and persist via the shared completion helper below.
    await markPaid(payment, {
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      method: payment.method || 'UPI',
    });
  } else if (payment.gateway === 'mock') {
    if (!razorpay_order_id || razorpay_order_id !== payment.razorpayOrderId) {
      const err = new Error('Order mismatch');
      err.userMessage = 'Payment verification failed. Your booking has not been marked as paid.';
      throw err;
    }
    // MOCK gateway = simulated instant success AFTER backend checks.
    await markPaid(payment, {
      method: payment.method || 'MOCK_REDIRECT',
    });
  } else {
    const err = new Error('Unsupported gateway');
    err.userMessage = 'Payment could not be completed. Please try again.';
    throw err;
  }

  return payment;
};

// Shared post-verification side effects (only after signature/security checks).
const markPaid = async (payment, extra = {}) => {
  const paidAt = new Date();
  payment.status = 'PAID';
  payment.paymentDate = paidAt;
  payment.paidAt = paidAt;
  payment.completedAt = paidAt;
  Object.assign(payment, extra);
  await payment.save();

  await Booking.updateOne(
    { _id: payment.booking },
    { $set: { paymentStatus: 'PAID', paidAt } }
  );

  // Wallet: hold the worker earning as PENDING until the customer confirms.
  if (payment.worker && payment.workerNetEarnings > 0) {
    const { creditJobEarning } = require('../wallet/walletService');
    await creditJobEarning({
      bookingId: payment.booking,
      paymentId: payment._id,
      workerId: payment.worker,
      amount: payment.workerNetEarnings,
    });
  }

  // Invoice for the customer receipt.
  const BookingModel = require('../../models/Booking');
  const booking = await BookingModel.findById(payment.booking);
  await Invoice.create({
    booking: payment.booking,
    customer: payment.customer,
    worker: payment.worker,
    service: booking?.serviceSnapshot?.name || 'Service',
    serviceDate: paidAt,
    labourCost: payment.labourAmount || 0,
    materials: payment.materialsAmount || 0,
    cooperativeContribution: payment.cooperativeContribution || 0,
    fees: payment.platformFee || 0,
    total: payment.amount,
    paymentStatus: 'PAID',
    payment: payment._id,
  });

  // Settle any carried cancellation balance collected with this payment:
  // clears the customer's outstanding balance and pays pending worker
  // compensation now that funds are actually available. Idempotent.
  if (payment.carriedCancellationBalance > 0 && booking) {
    const { settleCarriedCancellationBalance } = require('../cancellation/cancellationService');
    await settleCarriedCancellationBalance({ booking }).catch((e) =>
      console.error('[payment] cancellation settlement error:', e.message)
    );
  }

  return payment;
};

/**
 * Process a payment through the configured gateway
 * @param {Object} payment - payment record
 * @param {Object} opts - { amount, method }
 */
const processPayment = async (payment, opts = {}) => {
  const gateway = payment.gateway || 'mock';
  const amount = opts.amount || payment.amount;

  try {
    switch (gateway) {
      case 'razorpay':
        // Placeholder for Razorpay integration
        // await razorpay.orders.create({ amount: amount * 100, ... });
        return await processMockPayment(payment, amount, opts);
      case 'mock':
      default:
        return await processMockPayment(payment, amount, opts);
    }
  } catch (err) {
    payment.status = 'FAILED';
    payment.notes = err.message;
    await payment.save();
    throw err;
  }
};

/**
 * Mock payment processing
 * Can simulate a failure if opts.shouldFail is true or method is 'CASH' handled differently
 */
const processMockPayment = async (payment, amount, opts = {}) => {
  // Simulate processing delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  const shouldFail = opts.shouldFail === true || (opts.failureRate && Math.random() < opts.failureRate);

  if (shouldFail) {
    payment.status = 'FAILED';
    payment.notes = 'Mock payment failed (simulated)';
    await payment.save();
    return { status: 'FAILED', transactionId: payment.transactionId };
  }

  payment.status = 'PAID';
  payment.paymentDate = new Date();
  payment.paidAt = payment.paymentDate;
  payment.completedAt = payment.paymentDate;
  await payment.save();

  return {
    status: 'PAID',
    transactionId: payment.transactionId,
    paymentId: payment._id,
    amount: payment.amount,
  };
};

/**
 * Process refund (for cancelled/disputed bookings)
 */
const processRefund = async (paymentId) => {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error('Payment not found');

  payment.status = 'REFUNDED';
  await payment.save();

  return { status: 'REFUNDED', transactionId: payment.transactionId };
};

/**
 * Initiate a (simulated) refund against a payment.
 *
 * Hackathon MVP: refund is simulated locally but every state and record
 * mirrors a real gateway flow (Refund doc + gateway/transactionId), so a
 * live gateway (e.g. Razorpay) can be swapped in later behind this method.
 *
 * @param {String} paymentId
 * @param {Object} opts { amount, complaintId, initiatedBy, method }
 */
const initiateRefund = async (paymentId, opts = {}) => {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error('Payment not found');

  const refundAmount = Math.min(opts.amount ?? payment.amount, payment.amount);
  if (refundAmount <= 0) throw new Error('Refund amount must be greater than 0');
  if (!['PAID', 'SUCCESS'].includes(payment.status)) {
    throw new Error(`Cannot refund payment in ${payment.status} state`);
  }

  const existing = await Refund.findOne({ payment: payment._id, status: { $in: ['PROCESSING', 'PENDING'] } });
  if (existing) return existing;

  const refund = await Refund.create({
    complaint: opts.complaintId,
    booking: payment.booking,
    payment: payment._id,
    customer: payment.customer,
    amount: refundAmount,
    status: 'PROCESSING',
    method: opts.method || 'MOCK_REFUND',
    initiatedBy: opts.initiatedBy,
    initiatedAt: new Date(),
  });

  // Reverse the wallet earning held/released for this booking (idempotent).
  if (payment.worker) {
    await reverseEarning({
      bookingId: payment.booking,
      workerId: payment.worker,
      reference: `REFUND-${refund.refundNumber}`,
    }).catch((e) => console.error('[wallet] reversal error:', e.message));
  }

  // For Razorpay, push a live TEST-mode refund through the gateway.
  if (getGateway() === 'razorpay') {
    try {
      const rzRefund = await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { booking: String(payment.booking) },
      });
      refund.gateway = 'razorpay';
      refund.transactionId = rzRefund.id;
      refund.status = 'PROCESSING';
      await refund.save();
    } catch (e) {
      console.error('[razorpay] refund error:', e.message);
      await failRefund(refund._id, e.message || 'Razorpay refund failed');
      throw e;
    }
  }

  // mark the payment + invoice so no double charge can occur
  payment.status = 'REFUNDED';
  payment.notes = `Refund ${refundAmount} initiated (${refund.refundNumber})`;
  payment.refundedAt = new Date();
  await payment.save();
  await Invoice.updateOne({ booking: payment.booking }, { $set: { paymentStatus: 'REFUNDED' } });
  await Booking.updateOne(
    { _id: payment.booking },
    { $set: { paymentStatus: 'REFUNDED' } }
  );

  // Simulated gateway callback — complete the refund shortly after,
  // the same way a payment-webhook would confirm a real transfer.
  if (getGateway() !== 'razorpay') {
    setTimeout(() => {
      completeRefund(refund._id).catch(() => {});
    }, 3000);
  }

  return refund;
};

/**
 * Complete a simulated refund (called by the mock gateway callback).
 */
const completeRefund = async (refundId) => {
  const refund = await Refund.findById(refundId).populate('payment').populate('customer', 'name email');
  if (!refund || refund.status === 'COMPLETED') return refund;
  refund.status = 'COMPLETED';
  refund.completedAt = new Date();
  refund.gateway = 'mock';
  await refund.save();

  // Push a live notification to the customer
  await createNotification({
    user: refund.customer?._id,
    type: 'REFUND_STATUS',
    title: 'Refund completed',
    message: `Refund of ₹${refund.amount} for ${refund.refundNumber} has been credited to your original payment method.`,
    data: { refundId: refund._id, refundNumber: refund.refundNumber, complaintId: refund.complaint?.toString() },
  });
  return refund;
};

/**
 * Abort a simulated refund (sets FAILED so admin can retry/investigate).
 */
const failRefund = async (refundId, reason) => {
  const refund = await Refund.findById(refundId);
  if (!refund) throw new Error('Refund not found');
  refund.status = 'FAILED';
  refund.failureReason = reason || 'Gateway error (simulated)';
  await refund.save();
  return refund;
};

/**
 * Verify a payment by transaction ID
 */
const verifyPayment = async (transactionId) => {
  const payment = await Payment.findOne({ transactionId });
  if (!payment) throw new Error('Payment not found');
  return payment;
};

/**
 * Get payment status for a booking
 */
const getPaymentStatus = async (bookingId) => {
  const payment = await Payment.findOne({ booking: bookingId });
  return payment ? payment.status : 'NOT_FOUND';
};

module.exports = {
  getGateway,
  createPayment,
  createOrder,
  verifyOrder,
  processPayment,
  processRefund,
  initiateRefund,
  completeRefund,
  failRefund,
  verifyPayment,
  getPaymentStatus,
};
