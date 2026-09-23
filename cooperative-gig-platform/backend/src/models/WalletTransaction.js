const mongoose = require('mongoose');

// WalletTransaction — the audit ledger behind every wallet movement.
// The wallet's balances are derived from the state of these records; never
// mutate the wallet directly from the client. Uniqueness on (payment, type)
// makes JOB_EARNING credit idempotent even if verification is replayed.
const walletTransactionSchema = new mongoose.Schema(
  {
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Worker',
      required: true,
      index: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      index: true,
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      index: true,
    },
    type: {
      type: String,
      enum: ['JOB_EARNING', 'WITHDRAWAL', 'REFUND', 'ADJUSTMENT', 'HELPER_EARNING', 'HELPER_PAYMENT'],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
      default: 'PENDING',
      index: true,
    },
    description: {
      type: String,
      default: '',
    },
    reference: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// A job earning can only be credited once per payment. Partial index: only
// rows that carry a payment (JOB_EARNING/REFUND) are covered, so withdrawals
// (payment absent) never collide on the (null, type) key.
walletTransactionSchema.index(
  { payment: 1, type: 1 },
  { unique: true, partialFilterExpression: { payment: { $type: 'objectId' } } }
);
walletTransactionSchema.index({ worker: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);