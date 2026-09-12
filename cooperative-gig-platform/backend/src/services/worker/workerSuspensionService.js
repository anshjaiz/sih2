/**
 * workerSuspensionService.js
 *
 * Single home for worker suspension lifecycle:
 *  - restoreIfExpired()       lazy, per-request auto-restore once suspendedUntil passes
 *  - sweepExpiredSuspensions() periodic DB sweep so matching/earning gates also unblock
 *  - unsuspendWorkerByAdmin() explicit admin action to lift a suspension early
 *
 * Covers BOTH suspension systems:
 *  - administrative/complaint suspensions (WorkerProfile.isActive === false)
 *  - merit/reliability suspensions (WorkerProfile.accountStatus = TEMPORARILY_SUSPENDED /
 *    DEACTIVATION_REVIEW)
 *
 * Permanent terminations (terminatedAt) are never auto-restored.
 */

const Worker = require('../../models/WorkerProfile');
const WorkerReliability = require('../../models/WorkerReliability');
const ReliabilityEvent = require('../../models/ReliabilityEvent');
const { ApiError } = require('../../middleware/errorMiddleware');
const reliabilityConfig = require('../reliability/reliabilityConfig');
const { deriveLevel } = require('../reliability/reliabilityService');
const { createNotification } = require('../notification/notificationService');
const { logAudit, ACTIONS } = require('../audit/auditLogService');

const SUSPENDED_STATUSES = ['TEMPORARILY_SUSPENDED', 'DEACTIVATION_REVIEW'];

const isExpired = (profile) =>
  profile.suspendedUntil && new Date(profile.suspendedUntil).getTime() <= Date.now();

// Recompute the reliability level when it was parked at a suspension status.
const recomputeLevel = async (workerId) => {
  const rel = await WorkerReliability.findOne({ worker: workerId });
  if (!rel) return;
  const settings = await reliabilityConfig.getSettings();
  const level = deriveLevel(rel.score >= 0 ? rel.score : 100, settings.thresholds);
  if (rel.level !== level) {
    await WorkerReliability.updateOne({ worker: workerId }, { $set: { level } });
  }
};

/**
 * Lazy auto-restore for a single profile after its suspension period ends.
 * Returns the (possibly updated) profile. Never mutates terminated workers.
 */
const restoreIfExpired = async (profile) => {
  if (!profile || profile.terminatedAt || !isExpired(profile)) return profile;

  const sets = {};
  if (profile.isActive === false) sets.isActive = true;
  if (SUSPENDED_STATUSES.includes(profile.accountStatus)) sets.accountStatus = 'ACTIVE';
  if (!Object.keys(sets).length) return profile; // deadline set but not actually blocked

  sets.suspendedUntil = null;
  sets.suspendedFrom = null;
  sets.suspensionNote = '';

  await Worker.updateOne({ _id: profile._id }, { $set: sets });
  await recomputeLevel(profile._id);
  Object.assign(profile, sets);
  return profile;
};

/**
 * Periodic sweep: restore every worker whose suspension deadline has passed so
 * matching / earning gates that read raw fields clear as well.
 */
const sweepExpiredSuspensions = async (now = new Date()) => {
  const expired = await Worker.find({
    suspendedUntil: { $ne: null, $lte: now },
  }).select('_id isActive accountStatus suspendedUntil terminatedAt');
  const restored = [];
  for (const profile of expired) {
    if (profile.terminatedAt) continue;
    await restoreIfExpired(profile);
    restored.push(profile._id);
  }
  return restored;
};

/**
 * Explicit admin unsuspend — clears both suspension systems (but never a
 * permanent termination), records the decision and notifies the worker.
 */
const unsuspendWorkerByAdmin = async ({ workerId, reason = '', byUserId = null }) => {
  const profile = await Worker.findById(workerId);
  if (!profile) throw new ApiError('Worker not found', 404);
  if (profile.terminatedAt) {
    throw new ApiError('This worker is permanently terminated and cannot be unsuspended.', 400);
  }

  const rel = await WorkerReliability.findOne({ worker: profile._id });
  const score = Number.isFinite(rel?.score) ? rel.score : Number.isFinite(profile.reliability) ? profile.reliability : 100;
  const settings = await reliabilityConfig.getSettings();
  const activeLevel = deriveLevel(score, settings.thresholds);
  const note = reason || 'Unsuspended by admin';

  await Worker.updateOne(
    { _id: profile._id },
    {
      $set: {
        isActive: true,
        accountStatus: 'ACTIVE',
        suspendedUntil: null,
        suspendedFrom: null,
        suspensionNote: '',
      },
    }
  );
  if (rel) await WorkerReliability.updateOne({ worker: profile._id }, { $set: { level: activeLevel } });

  await ReliabilityEvent.create({
    worker: profile._id,
    booking: null,
    eventType: 'ADMIN_REACTIVATION',
    points: 0,
    previousScore: score,
    newScore: score,
    levelAfter: activeLevel,
    reason: note,
    admin: byUserId,
    adminNote: reason || '',
  });

  await logAudit({
    action: ACTIONS.WORKER_UNSUSPENDED,
    performedBy: byUserId,
    targetUser: profile.user,
    targetRole: 'worker',
    targetProfile: profile._id,
    reason: reason || '',
    metadata: { wasSuspended: true, levelAfter: activeLevel },
  });

  await createNotification({
    user: profile.user,
    type: 'ACCOUNT_UNSUSPENDED',
    title: 'Your account has been unsuspended',
    message: `Your account is active again and you can accept new jobs. ${note}`,
    data: { workerId: profile._id, reason: reason || '' },
  });

  return { worker: profile, accountStatus: 'ACTIVE', restored: true };
};

module.exports = { restoreIfExpired, sweepExpiredSuspensions, unsuspendWorkerByAdmin };