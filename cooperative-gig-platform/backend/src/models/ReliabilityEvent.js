const mongoose = require('mongoose');

const reliabilityEventSchema = new mongoose.Schema(
  {
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkerProfile',
      required: true,
      index: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      index: true,
      default: null,
    },
    eventType: {
      type: String,
      enum: [
        'INITIAL_SCORE',
        'JOB_COMPLETED',
        'ON_TIME',
        'GOOD_RATING',
        'COLLABORATION_ACCEPTED',
        'NO_SHOW',
        'COLLAB_NO_SHOW',
        'LATE_ARRIVAL',
        'CANCELLED_AFTER_ACCEPT',
        'CANCELLED_AFTER_JOURNEY',
        'CANCELLED_AFTER_ARRIVAL',
        'CANCELLED_AFTER_WORK_START',
        'REPEATED_NO_SHOW',
        'MILESTONE_JOBS_COMPLETED',
        'MILESTONE_COLLABS_COMPLETED',
        'ADMIN_ADJUSTMENT',
        'ADMIN_SUSPENSION',
        'ADMIN_REACTIVATION',
        'APPEAL_APPROVED',
        'PENALTY_WAIVED',
        'DEACTIVATION_REVIEW',
      ],
      required: true,
    },
    points: {
      type: Number,
      default: 0, // positive = increase, negative = penalty
    },
    previousScore: Number,
    newScore: Number,
    levelAfter: String,
    reason: {
      type: String,
      default: '',
    },
    // Who triggered the change (admin for manual adjustments / reviews)
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    adminNote: {
      type: String,
      default: '',
    },
    // Extra structured context (e.g. rating value, check-in dt, location)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Guards against double-penalising the same worker for the same booking+event
reliabilityEventSchema.index(
  { worker: 1, booking: 1, eventType: 1 },
  { unique: true, partialFilterExpression: { booking: { $type: 'objectId' } } }
);
reliabilityEventSchema.index({ worker: 1, createdAt: -1 });

module.exports = mongoose.model('ReliabilityEvent', reliabilityEventSchema);