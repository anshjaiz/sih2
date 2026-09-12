const mongoose = require('mongoose');

// Singleton document holding tunable reliability/no-show settings.
// Seeded by scripts/migrate_reliability.js; falls back to env/config defaults
// in reliabilityConfig.js when the document is absent.
const reliabilitySettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'default',
      unique: true,
    },
    // Score thresholds => level buckets
    thresholds: {
      good: { type: Number, default: 80 },
      warning: { type: Number, default: 60 },
      lowReliability: { type: Number, default: 40 },
      temporarySuspend: { type: Number, default: 20 },
      deactivationReview: { type: Number, default: 0 },
    },
    points: {
      initialScore: { type: Number, default: 100 },
      completeJob: { type: Number, default: 2 },
      onTime: { type: Number, default: 1 },
      goodRating: { type: Number, default: 1 },
      collaboration: { type: Number, default: 1 },
      noShow: { type: Number, default: -10 },
      lateArrival: { type: Number, default: -3 },
      cancelAfterAccept: { type: Number, default: -5 },
      repeatedNoShowExtra: { type: Number, default: -5 },
    },
    // Scheduling / enforcement
    noShowGraceMinutes: { type: Number, default: 15 },
    jobExpiryGraceMinutes: { type: Number, default: 120 },
    lateToleranceMinutes: { type: Number, default: 30 },
    reassignmentGraceMinutes: { type: Number, default: 30 },
    reminderLeadMinutes: { type: Number, default: 60 },
    maxReassignmentAttempts: { type: Number, default: 2 },
    schedulerIntervalSeconds: { type: Number, default: 60 },
    // Cancellation policy (configurable). Rule: N eligible cancellations in
    // M days triggers an automatic suspension for the responsible party.
    cancellation: {
      // Customer cancellation fee (₹) charged when the customer cancels and
      // the reason is penalty-eligible. Credited to outstanding balance.
      customerCancelFee: { type: Number, default: 75 },
      // Worker compensation (₹) when the job is cancelled after the worker
      // started travelling (JOURNEY/ARRIVED/WORK_STARTED).
      workerCompensation: { type: Number, default: 50 },
      // Automatic-suspension thresholds: eligible cancellations within the
      // window → suspend for autoSuspendDurationDays.
      customerStrikeThreshold: { type: Number, default: 3 },
      workerStrikeThreshold: { type: Number, default: 3 },
      cancellationWindowDays: { type: Number, default: 30 },
      autoSuspendDurationDays: { type: Number, default: 7 },
      // Escalating automatic-suspension durations (days) by occurrence.
      // 1st automatic suspension = first, 2nd = second, 3rd+ = repeated.
      suspensionDurations: {
        first: { type: Number, default: 7 },
        second: { type: Number, default: 14 },
        repeated: { type: Number, default: 30 },
      },
      // Customer cancellations before a worker accepts are always free.
      freeCancelBeforeAccept: { type: Boolean, default: true },
      // Worker merit deduction per cancellation stage (negative points).
      workerCancelAfterAcceptPoints: { type: Number, default: -5 },
      workerCancelAfterJourneyPoints: { type: Number, default: -8 },
      workerCancelAfterArrivalPoints: { type: Number, default: -10 },
      workerCancelAfterWorkStartPoints: { type: Number, default: -12 },
      // Customer merit decay per eligible cancellation.
      customerCancelPoints: { type: Number, default: -10 },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  'ReliabilitySettings',
  reliabilitySettingsSchema
);