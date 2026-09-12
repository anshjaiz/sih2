/**
 * adminSuspensionController.js
 *
 * Admin "Suspended accounts" dashboard + unsuspend endpoints. Operates on
 * the Customer/Worker PROFILE documents (like the rest of the admin routes),
 * and routes the unsuspend actions through the canonical service functions
 * so audit entries and notifications stay in one place.
 */

const User = require('../../models/User');
const Customer = require('../../models/CustomerProfile');
const Worker = require('../../models/WorkerProfile');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const {
  unsuspendCustomerByAdmin,
  isCustomerSuspended,
} = require('../../services/cancellation/cancellationService');
const { unsuspendWorkerByAdmin } = require('../../services/worker/workerSuspensionService');

const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPENDED_WORKER_STATUSES = ['TEMPORARILY_SUSPENDED', 'DEACTIVATION_REVIEW'];

const VALID_FILTERS = ['all', 'suspended', 'recent', 'highCancels', 'lowScore', 'auto'];

const assertAdmin = (req) => {
  if (!req.user || req.user.role !== 'admin') {
    throw new ApiError('Admin access required', 403);
  }
};

const clampPage = (v, def = 1) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
};

const clampLimit = (v, def = 20, max = 100) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
};

const filterClause = (base, filter, now) => {
  const clause = { ...base };
  switch (filter) {
    case 'suspended':
      clause.suspensionStatus = 'SUSPENDED';
      clause.$or = [{ suspendedUntil: null }, { suspendedUntil: { $gt: now } }];
      break;
    case 'recent':
      clause.$or = [
        { suspendedUntil: { $ne: null } },
        { suspendedAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } },
      ];
      break;
    case 'highCancels':
      clause['cancellationStats.eligibleCancellationCount'] = { $gte: 2 };
      break;
    case 'lowScore':
      clause.reliabilityScore = { $lte: 60 };
      break;
    case 'auto':
      clause.autoSuspended = true;
      break;
    default:
      break;
  }
  return clause;
};

const workerFilterClause = (base, filter, now) => {
  const clause = { ...base };
  switch (filter) {
    case 'suspended':
      clause.$or = [
        { accountStatus: { $in: SUSPENDED_WORKER_STATUSES } },
        { isActive: false },
      ];
      break;
    case 'recent':
      clause.$or = [
        { suspendedUntil: { $ne: null } },
        { suspendedFrom: { $gte: new Date(now.getTime() - 30 * DAY_MS) } },
      ];
      break;
    case 'highCancels':
      clause['cancellationStats.eligibleCancellationCount'] = { $gte: 2 };
      break;
    case 'lowScore':
      clause.reliability = { $lte: 60 };
      break;
    case 'auto':
      clause.autoSuspended = true;
      break;
    default:
      break;
  }
  return clause;
};

const searchUserIds = async (search) => {
  if (!search) return null;
  const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await User.find({
    $or: [{ name: regex }, { email: regex }, { phone: regex }],
  })
    .select('_id')
    .lean();
  return users.map((u) => u._id);
};

// -------------------- Customers --------------------

const listSuspendedCustomers = asyncHandler(async (req, res) => {
  assertAdmin(req);
  const { filter = 'all', search = '', page = 1, limit = 20 } = req.query;
  if (!VALID_FILTERS.includes(filter)) throw new ApiError('Invalid filter', 400);

  const now = new Date();
  const base = {};
  const ids = await searchUserIds(search);
  if (ids !== null) base.user = { $in: ids };

  const clause = filterClause(base, filter, now);
  const skip = (clampPage(page) - 1) * clampLimit(limit);

  const [profiles, total] = await Promise.all([
    Customer.find(clause)
      .populate('user', 'name email phone avatar')
      .sort({ suspendedAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(clampLimit(limit)),
    Customer.countDocuments(clause),
  ]);

  res.json({
    success: true,
    data: profiles.map((p) => ({
      id: p._id,
      userId: p.user?._id,
      name: p.user?.name,
      email: p.user?.email,
      phone: p.user?.phone,
      avatar: p.user?.avatar,
      reliabilityScore: p.reliabilityScore,
      meritScore: p.meritScore,
      outstandingCancellationBalance: p.outstandingCancellationBalance,
      eligibleCancellationCount: p.cancellationStats?.eligibleCancellationCount ?? 0,
      cancelledCount: p.cancellationStats?.cancelledCount ?? 0,
      suspensionStatus: p.suspensionStatus,
      suspendedAt: p.suspendedAt,
      suspendedUntil: p.suspendedUntil,
      suspensionReason: p.suspensionReason,
      autoSuspended: p.autoSuspended,
      suspensionCount: p.suspensionCount ?? 0,
      currentlySuspended: isCustomerSuspended(p),
    })),
    meta: { page: clampPage(page), limit: clampLimit(limit), total, filter },
  });
});

const unsuspendCustomer = asyncHandler(async (req, res) => {
  assertAdmin(req);
  const { reason = '' } = req.body || {};
  const result = await unsuspendCustomerByAdmin({
    customerId: req.params.id,
    reason,
    byUserId: req.user._id,
  });
  res.json({
    success: true,
    message: result.wasSuspended
      ? 'Customer unsuspended successfully'
      : 'Customer was not actively suspended',
    data: { id: result.profile._id, suspensionStatus: 'ACTIVE', wasSuspended: result.wasSuspended },
  });
});

// -------------------- Workers --------------------

const listSuspendedWorkers = asyncHandler(async (req, res) => {
  assertAdmin(req);
  const { filter = 'all', search = '', page = 1, limit = 20 } = req.query;
  if (!VALID_FILTERS.includes(filter)) throw new ApiError('Invalid filter', 400);

  const now = new Date();
  const base = {};
  const ids = await searchUserIds(search);
  if (ids !== null) base.user = { $in: ids };

  const clause = workerFilterClause(base, filter, now);
  const skip = (clampPage(page) - 1) * clampLimit(limit);

  const [profiles, total] = await Promise.all([
    Worker.find(clause)
      .populate('user', 'name email phone avatar')
      .sort({ suspendedFrom: -1, updatedAt: -1 })
      .skip(skip)
      .limit(clampLimit(limit)),
    Worker.countDocuments(clause),
  ]);

  res.json({
    success: true,
    data: profiles.map((p) => ({
      id: p._id,
      userId: p.user?._id,
      name: p.user?.name,
      email: p.user?.email,
      phone: p.user?.phone,
      avatar: p.user?.avatar,
      reliability: p.reliability,
      meritScore: p.meritScore,
      accountStatus: p.accountStatus,
      isActive: p.isActive,
      suspendedFrom: p.suspendedFrom,
      suspendedUntil: p.suspendedUntil,
      suspensionNote: p.suspensionNote,
      autoSuspended: p.autoSuspended,
      autoSuspensionCount: p.autoSuspensionCount ?? 0,
      eligibleCancellationCount: p.cancellationStats?.eligibleCancellationCount ?? 0,
      cancelledCount: p.cancellationStats?.cancelledCount ?? 0,
    })),
    meta: { page: clampPage(page), limit: clampLimit(limit), total, filter },
  });
});

const unsuspendWorker = asyncHandler(async (req, res) => {
  assertAdmin(req);
  const { reason = '' } = req.body || {};
  const result = await unsuspendWorkerByAdmin({
    workerId: req.params.id,
    reason,
    byUserId: req.user._id,
  });
  res.json({
    success: true,
    message: 'Worker unsuspended successfully',
    data: { id: result.worker._id, accountStatus: result.accountStatus },
  });
});

// -------------------- Audit log --------------------

const getAuditLogs = asyncHandler(async (req, res) => {
  assertAdmin(req);
  const { action = '', page = 1, limit = 50 } = req.query;
  const filter = {};
  if (action) filter.action = action;

  const skip = (clampPage(page) - 1) * clampLimit(limit, 50, 200);
  const [logs, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .populate('performedBy', 'name email role')
      .populate('targetUser', 'name email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(clampLimit(limit, 50, 200)),
    AdminAuditLog.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: logs,
    meta: { page: clampPage(page), limit: clampLimit(limit, 50, 200), total, action },
  });
});

module.exports = {
  listSuspendedCustomers,
  listSuspendedWorkers,
  unsuspendCustomer,
  unsuspendWorker,
  getAuditLogs,
};