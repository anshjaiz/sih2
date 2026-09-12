const mongoose = require('mongoose');

// Cancellation — the audit ledger/single source of truth for every booking
// cancellation. All cancellation endpoints funnel through
// cancellationService so penalties, fees, strike/merit effects and
// compensation are recorded here exactly once.
//
// Financial fields are kept separate and explicit:
//   - customerPenaltyAmount   what the CUSTOMER owes (outstanding balance)
//   - workerCompensationAmount what the WORKER should receive for wasted travel
// Money is NEVER moved automatically into a wallet unless the underlying
// payment system supports it; otherwise these stay as PENDING ledger entries
// for admin settlement.
const cancellationSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    bookingNumber: {
      type: String,
      default: '',
    },
    // 'customer' | 'worker' | 'admin' | 'system'
    cancelledBy: {
      type: String,
      enum: ['customer', 'worker', 'admin', 'system'],
      required: true,
    },
    cancelledByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Worker',
      index: true,
    },
    reason: {
      type: String,
      default: '',
    },
    reasonKey: {
      type: String,
      default: '',
    },
    stage: {
      type: String,
      enum: ['PRE_ACCEPT', 'POST_ACCEPT', 'JOURNEY', 'ARRIVED', 'WORK_STARTED'],
      required: true,
    },
    // Backend-determined eligibility: false when the cancellation was NOT the
    // canceler's fault (customer unavailable, unsafe situation, emergency,
    // worker delay, customer-caused, platform/system issue, etc.).
    penaltyEligible: {
      type: Boolean,
      default: false,
    },
    customerPenaltyAmount: {
      type: Number,
      default: 0,
    },
    workerCompensationAmount: {
      type: Number,
      default: 0,
    },
    customerStrikeApplied: {
      type: Boolean,
      default: false,
    },
    workerStrikeApplied: {
      type: Boolean,
      default: false,
    },
    workerMeritPoints: {
      type: Number,
      default: 0,
    },
    workerMeritEventType: {
      type: String,
      default: '',
    },
    // Customer-side settlement of the outstanding balance / worker comp.
    customerPenaltySettled: {
      type: Boolean,
      default: false,
    },
    compensationSettled: {
      type: Boolean,
      default: false,
    },
    compensationStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'NONE'],
      default: 'NONE',
    },
    cancelledAt: {
      type: Date,
      default: Date.now,
    },
    reviewed: {
      type: Boolean,
      default: false,
    },
    adminNote: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// A booking can only be cancelled once — idempotency guard for duplicate
// cancellation requests (duplicate strikes/fees are impossible).
cancellationSchema.index(
  { booking: 1, cancelledBy: 1 },
  { unique: true }
);
cancellationSchema.index({ createdAt: -1 });
cancellationSchema.index({ penaltyEligible: 1, createdAt: -1 });

module.exports = mongoose.model('Cancellation', cancellationSchema);