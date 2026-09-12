const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Worker',
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Cancellation balance (₹) carried from a previous cancelled booking and
    // collected with this payment. Shown explicitly on receipts/invoices.
    carriedCancellationBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Break down payments for transparency
    labourAmount: {
      type: Number,
      default: 0,
    },
    materialsAmount: {
      type: Number,
      default: 0,
    },
    cooperativeContribution: {
      type: Number,
      default: 0,
    },
    platformFee: {
      type: Number,
      default: 0,
    },
    method: {
      type: String,
      enum: ['CASH', 'UPI', 'CARD', 'NET_BANKING', 'WALLET', 'MOCK_REDIRECT'],
      default: 'MOCK_REDIRECT',
    },
    gateway: {
      type: String,
      default: 'mock', // 'mock' | 'razorpay' | 'other'
    },
    // Razorpay order + verification (server-side signature check)
    razorpayOrderId: {
      type: String,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
    },
    razorpaySignature: {
      type: String,
    },
    transactionId: {
      type: String,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      // 'PAID' is the new canonical success status; 'SUCCESS' is kept so
      // records created by the earlier mock gateway stay readable.
      enum: ['PENDING', 'CREATED', 'PAID', 'FAILED', 'REFUNDED', 'CANCELLED', 'SUCCESS'],
      default: 'PENDING',
      index: true,
    },
    paymentDate: Date,
    completedAt: Date,
    paidAt: Date,
    refundedAt: Date,
    cancelledAt: Date,
    failureReason: {
      type: String,
      default: '',
    },
    // Shared earnings breakdown with worker
    workerGross: {
      type: Number,
      default: 0,
    },
    cooperativeDeduction: {
      type: Number,
      default: 0,
    },
    workerNetEarnings: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

paymentSchema.index({ customer: 1, status: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
