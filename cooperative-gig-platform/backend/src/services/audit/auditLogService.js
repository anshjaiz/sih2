const AdminAuditLog = require('../../models/AdminAuditLog');

const ACTIONS = {
  CUSTOMER_AUTO_SUSPENDED: 'CUSTOMER_AUTO_SUSPENDED',
  CUSTOMER_UNSUSPENDED: 'CUSTOMER_UNSUSPENDED',
  WORKER_AUTO_SUSPENDED: 'WORKER_AUTO_SUSPENDED',
  WORKER_UNSUSPENDED: 'WORKER_UNSUSPENDED',
  CANCELLATION_PENALTY_APPLIED: 'CANCELLATION_PENALTY_APPLIED',
  WORKER_COMPENSATION_CREATED: 'WORKER_COMPENSATION_CREATED',
  MERIT_SCORE_CHANGED: 'MERIT_SCORE_CHANGED',
};

/**
 * Append an audit entry. Never throws — the audit trail must never take down
 * a live request. `metadata` is the ONLY free-form place; keep it small.
 */
const logAudit = async ({
  action,
  performedBy = null,
  targetUser = null,
  targetRole = null,
  targetProfile = null,
  reason = '',
  booking = null,
  metadata = {},
}) => {
  try {
    await AdminAuditLog.create({
      action,
      performedBy,
      targetUser,
      targetRole,
      targetProfile,
      reason: reason || '',
      booking,
      metadata,
    });
  } catch (e) {
    console.error('[audit] failed to record', action, e.message);
  }
  return null;
};

module.exports = { logAudit, ACTIONS, AdminAuditLog };