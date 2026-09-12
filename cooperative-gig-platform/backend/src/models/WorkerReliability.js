const mongoose = require('mongoose');

const workerReliabilitySchema = new mongoose.Schema(
  {
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkerProfile',
      required: true,
      unique: true,
      index: true,
    },
    score: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    level: {
      type: String,
      enum: [
        'GOOD',
        'WARNING',
        'LOW_RELIABILITY',
        'TEMPORARILY_SUSPENDED',
        'DEACTIVATION_REVIEW',
      ],
      default: 'GOOD',
    },
    // namespaced counters for repeated-offence penalties
    noShowCount: {
      type: Number,
      default: 0,
    },
    lateCount: {
      type: Number,
      default: 0,
    },
    cancelledAfterAcceptCount: {
      type: Number,
      default: 0,
    },
    cancelledAfterJourneyCount: {
      type: Number,
      default: 0,
    },
    cancelledAfterArrivalCount: {
      type: Number,
      default: 0,
    },
    cancelledAfterWorkStartCount: {
      type: Number,
      default: 0,
    },
    collabNoShowCount: {
      type: Number,
      default: 0,
    },
    completedCount: {
      type: Number,
      default: 0,
    },
    onTimeCount: {
      type: Number,
      default: 0,
    },
    penaltiesCount: {
      type: Number,
      default: 0,
    },
    lastEventAt: Date,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('WorkerReliability', workerReliabilitySchema);