const mongoose = require('mongoose');

const customerProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    // Primary/default location
    address: {
      type: String,
      default: '',
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [78.4867, 17.385],
      },
    },
    city: {
      type: String,
      default: '',
    },
    defaultContact: {
      type: String,
      default: '',
    },
    savedAddresses: [
      {
        label: String,
        address: String,
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: [Number],
        },
      },
    ],
    bookingsCount: {
      type: Number,
      default: 0,
    },
    totalSpent: {
      type: Number,
      default: 0,
    },
    preferredLanguages: {
      type: [String],
      default: ['English', 'Hindi'],
    },
    // ── Reliability / cancellation system ──────────────────────────────
    // Customer-side merit — decays on eligible cancellations. Mirrors the
    // worker reliability score so cancellation outcomes are comparable.
    meritScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    reliabilityScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    // Unpaid cancellation fees owed by this customer. Shown transparently on
    // the next booking and collected with its payment. Never silently added.
    outstandingCancellationBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Auto-suspension from repeated eligible cancellations (configurable
    // threshold within a window). Separate from admin suspension.
    suspensionStatus: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    suspendedAt: Date,
    suspendedUntil: Date,
    suspensionReason: {
      type: String,
      default: '',
    },
    autoSuspended: {
      type: Boolean,
      default: false,
    },
    // Number of automatic (repeated-cancellation) suspensions received.
    // Drives escalating durations: 1st = first, 2nd = second, 3rd+ = repeated.
    suspensionCount: {
      type: Number,
      default: 0,
    },
    cancellationStats: {
      strikes: [
        {
          at: Date,
          booking: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Booking',
          },
          reason: String,
          stage: String,
        },
      ],
      eligibleCancellationCount: {
        type: Number,
        default: 0,
      },
      cancelledCount: {
        type: Number,
        default: 0,
      },
      lastCancelledAt: Date,
      lastSettledAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

customerProfileSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Customer', customerProfileSchema);
