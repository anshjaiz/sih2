const mongoose = require('mongoose');

// AdminAuditLog — immutable audit trail for suspension / cancellation
// admin-driven and automatic actions. Records WHO performed what (or that a
// system action fired), WHEN, and WHY. Used by the admin "Suspended accounts"
// dashboard and for regulatory transparency.
//
// Convention for `action` values (strings; documented, not a hard enum, so
// forward compatibility stays easy):
//   CUSTOMER_AUTO_SUSPENDED       system auto-suspended a customer
//   CUSTOMER_UNSUSPENDED          admin lifted a customer suspension
//   WORKER_AUTO_SUSPENDED         system auto-suspended a worker
//   WORKER_UNSUSPENDED            admin lifted a worker suspension
//   CANCELLATION_PENALTY_APPLIED  an eligible customer cancellation fee recorded
//   WORKER_COMPENSATION_CREATED   worker travel compensation recorded
//   MERIT_SCORE_CHANGED           a merit/reliability score change was applied
const adminAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    targetRole: {
      type: String,
      enum: ['customer', 'worker'],
      default: 'customer',
    },
    // The Customer/Worker profile document, when applicable.
    targetProfile: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    reason: {
      type: String,
      default: '',
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

adminAuditLogSchema.index({ action: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetUser: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);