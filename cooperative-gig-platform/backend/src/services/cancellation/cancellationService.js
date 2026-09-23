/**
 * cancellationService.js
 *
 * THE single home for all cancellation logic. Every cancellation endpoint
 * (customer, worker, admin) must go through `applyCancellation`, which is
 * itself built on the pure `calculateCancellationOutcome`.
 *
 * Design goals:
 *  - Fairness: a penalty is applied only when the BACKEND determines the
 *    canceler is responsible, based on WHO cancelled + BOOKING STAGE +
 *    CANCELLATION REASON. Worker cancellations never put a strike on the
 *    customer and vice-versa.
 *  - Centralized: fees, worker compensation, merit deductions, strike and
 *    suspension eligibility all come from one function.
 *  - Idempotent: the booking status transition is claimed atomically and a
 *    unique (booking, cancelledBy) ledger row is enforced, so duplicate
 *    requests can never create duplicate penalties.
 *  - Honest money: fees/compensation are recorded as ledger balances unless
 *    the payment system actually settles them. Nothing pretends to be paid.
 */

const Booking = require('../../models/Booking');
const Customer = require('../../models/CustomerProfile');
const Worker = require('../../models/WorkerProfile');
const WorkerReliability = require('../../models/WorkerReliability');
const Cancellation = require('../../models/Cancellation');
const { getSettings } = require('../reliability/reliabilityConfig');
const { applyScoreChange } = require('../reliability/reliabilityService');
const { createNotification } = require('../notification/notificationService');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const numOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Escalating duration (days) for automatic suspensions.
 * 1st suspension = `first`, 2nd = `second`, 3rd and later = `repeated`.
 * Falls back to the legacy flat `autoSuspendDurationDays` for stored docs
 * that predate the escalating configuration. Always returns a positive value.
 */
const suspendDurationForCount = (settings, count) => {
  const d = settings.cancellation?.suspensionDurations || {};
  const fallback = numOr(settings.cancellation?.autoSuspendDurationDays, 7);
  const n = Number(count) || 0;
  if (n <= 1) return numOr(d.first, fallback);
  if (n === 2) return numOr(d.second, fallback);
  return numOr(d.repeated, fallback);
};

const TERMINAL_STATUSES = ['COMPLETED', 'DISPUTED', 'CANCELLED', 'WORKER_NO_SHOW', 'EXPIRED'];
const CANCELLABLE_STATUSES = [
  'REQUESTED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'ON_THE_WAY',
  'WORKER_ARRIVED',
  'STARTED',
  'IN_PROGRESS',
  'REASSIGNED',
];

/**
 * Customer cancellation reasons. `eligible` means the reason DOES make the
 * customer responsible (so a fee/strike may apply). Reasons that describe a
 * platform/worker problem are never penalty-eligible for the customer.
 */
const CUSTOMER_CANCELLATION_REASONS = [
  { key: 'changed_mind', label: 'Changed my mind', eligible: true },
  { key: 'no_longer_need', label: 'No longer need service', eligible: true },
  { key: 'worker_delayed', label: 'Worker is delayed', eligible: false },
  { key: 'worker_asked_cancel', label: 'Worker asked me to cancel', eligible: false },
  { key: 'emergency', label: 'Emergency', eligible: false },
  { key: 'found_other_solution', label: 'Found another solution', eligible: true },
  { key: 'other', label: 'Other', eligible: true },
];

/**
 * Worker cancellation reasons. `eligible` means the reason is the WORKER's
 * responsibility. Causes outside the worker's control (customer unavailable,
 * wrong address, unsafe situation, customer-requested, emergency, platform
 * issues) are never penalty-eligible. "Other" is treated as a legitimate
 * reason (no automatic penalty) but is recorded for admin review.
 */
const WORKER_CANCELLATION_REASONS = [
  { key: 'customer_unavailable', label: 'Customer unavailable', eligible: false },
  { key: 'incorrect_address', label: 'Incorrect address', eligible: false },
  { key: 'unsafe_situation', label: 'Unsafe situation', eligible: false },
  { key: 'customer_requested_cancellation', label: 'Customer requested cancellation', eligible: false },
  { key: 'transport_problem', label: 'Transport problem', eligible: true },
  { key: 'emergency', label: 'Emergency', eligible: false },
  { key: 'other', label: 'Other', eligible: false },
];

const REASON_MAP = {
  customer: CUSTOMER_CANCELLATION_REASONS.reduce((m, r) => ({ ...m, [r.key]: r }), {}),
  worker: WORKER_CANCELLATION_REASONS.reduce((m, r) => ({ ...m, [r.key]: r }), {}),
};

const getCancellationReasons = () => ({
  customer: CUSTOMER_CANCELLATION_REASONS,
  worker: WORKER_CANCELLATION_REASONS,
});

/** Booking stage at the moment of cancellation. */
const resolveCancellationStage = (booking = {}) => {
  const status = booking.status;
  if (status === 'ACCEPTED') return 'POST_ACCEPT';
  if (status === 'ON_THE_WAY') return 'JOURNEY';
  if (status === 'WORKER_ARRIVED') return 'ARRIVED';
  if (status === 'STARTED' || status === 'IN_PROGRESS') return 'WORK_STARTED';
  // No accepted worker yet.
  if (!booking.acceptedAt) return 'PRE_ACCEPT';
  return 'PRE_ACCEPT';
};

const STAGE_ORDER = { PRE_ACCEPT: 0, POST_ACCEPT: 1, JOURNEY: 2, ARRIVED: 3, WORK_STARTED: 4 };
const stageAtLeast = (stage, min) => (STAGE_ORDER[stage] ?? 0) >= STAGE_ORDER[min];

const assertCancellable = (booking) => {
  if (!booking) {
    const err = new Error('Booking not found');
    err.statusCode = 404;
    throw err;
  }
  if (booking.status === 'CANCELLED') {
    const err = new Error('Booking was already cancelled');
    err.statusCode = 400;
    throw err;
  }
  if (TERMINAL_STATUSES.includes(booking.status) || !CANCELLABLE_STATUSES.includes(booking.status)) {
    const err = new Error(`Cannot cancel booking in ${booking.status} status`);
    err.statusCode = 400;
    throw err;
  }
};

/**
 * Pure outcome calculation — no writes. Safe for previews. `settings` is the
 * resolved settings object (as returned by reliabilityConfig.getSettings).
 */
const buildOutcome = (booking, cancelledBy, reasonKey, settings) => {
  const c = settings.cancellation;
  const stage = resolveCancellationStage(booking);
  const reasons = REASON_MAP[cancelledBy] || {};
  const info = reasons[reasonKey] || { key: reasonKey || 'other', label: reasonKey || 'Other', eligible: false };
  const reasonEligible = !!info.eligible;

  // Worker compensation: the worker is compensated for wasted travel when
  // SOMEONE ELSE cancels after the worker has started travelling.
  const workerCompensationAmount =
    cancelledBy !== 'worker' && stageAtLeast(stage, 'JOURNEY') ? round2(c.workerCompensation) : 0;

  // Customer fee: only when the customer cancelled, before-accept cancels are
  // free, and the backend deems the reason penalty-eligible.
  const freePreAccept = stage === 'PRE_ACCEPT' && c.freeCancelBeforeAccept;
  const customerPenaltyAmount =
    cancelledBy === 'customer' && !freePreAccept && reasonEligible ? round2(c.customerCancelFee) : 0;

  // Worker merit: only penalise a worker who cancels after accepting AND for a
  // reason the backend deems their responsibility.
  let workerMeritPoints = 0;
  let workerMeritEventType = '';
  if (cancelledBy === 'worker' && stageAtLeast(stage, 'POST_ACCEPT') && reasonEligible) {
    if (stage === 'POST_ACCEPT') {
      workerMeritPoints = c.workerCancelAfterAcceptPoints;
      workerMeritEventType = 'CANCELLED_AFTER_ACCEPT';
    } else if (stage === 'JOURNEY') {
      workerMeritPoints = c.workerCancelAfterJourneyPoints;
      workerMeritEventType = 'CANCELLED_AFTER_JOURNEY';
    } else if (stage === 'ARRIVED') {
      workerMeritPoints = c.workerCancelAfterArrivalPoints;
      workerMeritEventType = 'CANCELLED_AFTER_ARRIVAL';
    } else {
      workerMeritPoints = c.workerCancelAfterWorkStartPoints;
      workerMeritEventType = 'CANCELLED_AFTER_WORK_START';
    }
  }

  const customerStrikeApplied = customerPenaltyAmount > 0;
  const workerStrikeApplied =
    cancelledBy === 'worker' && stageAtLeast(stage, 'POST_ACCEPT') && reasonEligible;

  const penaltyEligible =
    cancelledBy === 'customer'
      ? customerStrikeApplied
      : cancelledBy === 'worker'
      ? workerStrikeApplied
      : false;

  return {
    cancelledBy,
    reasonKey: info.key,
    reasonLabel: info.label,
    reasonEligible,
    stage,
    penaltyEligible,
    customerPenaltyAmount,
    workerCompensationAmount,
    workerMeritPoints,
    workerMeritEventType,
    customerMeritPoints: customerStrikeApplied ? c.customerCancelPoints : 0,
    customerStrikeApplied,
    workerStrikeApplied,
    freePreAccept,
  };
};

// ── Suspension helpers ──────────────────────────────────────────────────

const isCustomerSuspended = (profile) => {
  if (!profile || profile.suspensionStatus !== 'SUSPENDED') return false;
  if (profile.suspendedUntil && new Date(profile.suspendedUntil).getTime() <= Date.now()) return false;
  return true;
};

/**
 * Lazy auto-restore for a customer once their suspension period ends.
 * Returns the (possibly updated) profile.
 */
const restoreCustomerIfExpired = async (profile) => {
  if (!profile || profile.suspensionStatus !== 'SUSPENDED') return profile;
  if (!profile.suspendedUntil || new Date(profile.suspendedUntil).getTime() > Date.now()) return profile;
  const sets = {
    suspensionStatus: 'ACTIVE',
    autoSuspended: false,
    suspensionReason: '',
  };
  await Customer.updateOne({ _id: profile._id }, { $set: sets });
  Object.assign(profile, sets);
  // Inform the customer their suspension period has ended.
  await createNotification({
    user: profile.user,
    type: 'ACCOUNT_UNSUSPENDED',
    title: 'Suspension period over',
    message: 'Your temporary suspension has ended. You can create new bookings again.',
    data: { autoRestored: true },
  }).catch(() => {});
  return profile;
};

/** Restore every customer whose suspension deadline has passed (scheduler). */
const sweepExpiredCustomerSuspensions = async (now = new Date()) => {
  const expired = await Customer.find({
    suspensionStatus: 'SUSPENDED',
    suspendedUntil: { $ne: null, $lte: now },
  }).select('_id suspensionStatus suspendedUntil');
  for (const profile of expired) {
    await restoreCustomerIfExpired(profile);
  }
  return expired.map((p) => p._id);
};

/**
 * Enforcement gate used by booking-creation, confirmation and other customer
 * actions. Lazily expires the suspension first so an already-finished
 * suspension never blocks a customer. Throws (403) when genuinely suspended.
 * Returns the customer profile when active.
 */
const enforceCustomerNotSuspended = async (userId) => {
  const profile = await Customer.findOne({ user: userId });
  if (!profile) return null;
  await restoreCustomerIfExpired(profile);
  if (isCustomerSuspended(profile)) {
    const err = new Error('Your account is temporarily suspended from creating or confirming bookings.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_SUSPENDED';
    err.suspendedUntil = profile.suspendedUntil;
    throw err;
  }
  return profile;
};

/**
 * Admin unsuspend for customers. Idempotent — advisory-only when the customer
 * was never suspended, but still clears stale suspension fields and audits the
 * admin action. History (strikes, suspensionCount) is intentionally preserved.
 */
const unsuspendCustomerByAdmin = async ({ customerId, reason = '', byUserId = null }) => {
  let profile = null;
  try {
    profile = await Customer.findById(customerId);
  } catch (e) {
    /* not an ObjectId → treat as a user id */
  }
  if (!profile) profile = await Customer.findOne({ user: customerId });
  if (!profile) {
    const err = new Error('Customer profile not found');
    err.statusCode = 404;
    throw err;
  }
  const wasSuspended = isCustomerSuspended(profile);
  const sets = {
    suspensionStatus: 'ACTIVE',
    autoSuspended: false,
    suspensionReason: reason || profile.suspensionReason || '',
    suspendedUntil: null,
    suspendedAt: null,
  };
  await Customer.updateOne({ _id: profile._id }, { $set: sets });

  await logAudit({
    action: ACTIONS.CUSTOMER_UNSUSPENDED,
    performedBy: byUserId,
    targetUser: profile.user,
    targetRole: 'customer',
    targetProfile: profile._id,
    reason: reason || '',
    metadata: { wasSuspended },
  });
  if (wasSuspended) {
    await createNotification({
      user: profile.user,
      type: 'ACCOUNT_UNSUSPENDED',
      title: 'Account unsuspended',
      message: reason
        ? `Your account suspension has been lifted by the support team. ${reason}`
        : 'Your account suspension has been lifted by the support team.',
      data: { unsuspendedBy: 'admin' },
    }).catch(() => {});
  }
  return { profile, wasSuspended };
};

const { logAudit, ACTIONS } = require('../audit/auditLogService');

const suspendCustomer = async ({ customerUserId, reason, count }) => {
  const settings = await getSettings();

  // `count` = which automatic suspension this is (drives escalation). The
  // profile-owned counter is the source of truth when the caller does not
  // supply one; it is incremented atomically below.
  let profile =
    typeof count === 'number' && count >= 1 ? null : await Customer.findOne({ user: customerUserId });
  if (!profile) {
    profile = await Customer.findOneAndUpdate(
      { user: customerUserId },
      { $setOnInsert: { user: customerUserId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).catch(() => null);
  }
  const suspensionNumber =
    typeof count === 'number' && count >= 1
      ? count
      : (profile?.suspensionCount ?? 0) + 1;
  const durationDays = suspendDurationForCount(settings, suspensionNumber);
  const until = new Date(Date.now() + durationDays * DAY_MS);

  await Customer.updateOne(
    { user: customerUserId },
    {
      $inc: { suspensionCount: 1 },
      $set: {
        suspensionStatus: 'SUSPENDED',
        autoSuspended: true,
        suspendedAt: new Date(),
        suspendedUntil: until,
        suspensionReason: reason,
      },
    }
  ).catch(() => {});
  await createNotification({
    user: customerUserId,
    type: 'ACCOUNT_SUSPENDED',
    title: 'Account temporarily suspended',
    message: `Your account has been suspended for ${durationDays} day${durationDays === 1 ? '' : 's'} (until ${until.toLocaleDateString()}) because of repeated eligible cancellations. ${reason}`,
    data: { suspendedUntil: until, autoSuspended: true, durationDays },
  });
  await logAudit({
    action: ACTIONS.CUSTOMER_AUTO_SUSPENDED,
    targetUser: customerUserId,
    targetRole: 'customer',
    targetProfile: profile ? profile._id : null,
    reason: reason || '',
    metadata: { suspensionNumber, durationDays, suspendedUntil: until },
  });
  return { until, durationDays };
};

const suspendWorkerByStrikes = async ({ workerId, reason, count }) => {
  const settings = await getSettings();

  const wp =
    typeof count === 'number' && count >= 1
      ? await Worker.findById(workerId).select('user autoSuspensionCount').lean()
      : await Worker.findById(workerId);
  const suspensionNumber =
    typeof count === 'number' && count >= 1
      ? count
      : (wp?.autoSuspensionCount ?? 0) + 1;
  const durationDays = suspendDurationForCount(settings, suspensionNumber);
  const until = new Date(Date.now() + durationDays * DAY_MS);

  await Worker.updateOne(
    { _id: workerId },
    {
      $inc: { autoSuspensionCount: 1 },
      $set: {
        accountStatus: 'TEMPORARILY_SUSPENDED',
        autoSuspended: true,
        suspendedFrom: new Date(),
        suspendedUntil: until,
        suspensionNote: reason,
      },
    }
  );
  await WorkerReliability.updateOne(
    { worker: workerId },
    { $set: { level: 'TEMPORARILY_SUSPENDED' } }
  ).catch(() => {});
  const workerUser = wp?.user ?? (await Worker.findById(workerId).select('user').lean())?.user;
  await createNotification({
    user: workerUser,
    type: 'RELIABILITY_SUSPENDED',
    title: 'Merit suspension',
    message: `Your account is suspended for ${durationDays} day${durationDays === 1 ? '' : 's'} (until ${until.toLocaleDateString()}) because of repeated eligible cancellations. ${reason}`,
    data: { suspendedUntil: until, autoSuspended: true, durationDays },
  });
  await logAudit({
    action: ACTIONS.WORKER_AUTO_SUSPENDED,
    targetUser: workerUser,
    targetRole: 'worker',
    targetProfile: workerId,
    reason: reason || '',
    metadata: { suspensionNumber, durationDays, suspendedUntil: until },
  });
  return { until, durationDays };
};

// ── Strike recording ────────────────────────────────────────────────────

const recordCustomerStrike = async ({ booking, outcome, settings }) => {
  const now = new Date();
  const profile = await Customer.findOneAndUpdate(
    { user: booking.customer },
    {
      $push: {
        'cancellationStats.strikes': {
          at: now,
          booking: booking._id,
          reason: outcome.reasonKey,
          stage: outcome.stage,
        },
      },
      $inc: { 'cancellationStats.eligibleCancellationCount': 1 },
      $set: { 'cancellationStats.lastCancelledAt': now },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  if (!profile) return null;

  // Customer merit decay (denormalized, floored at 0).
  const nextMerit = Math.max(0, round2((profile.meritScore ?? 100) + outcome.customerMeritPoints));
  await Customer.updateOne(
    { _id: profile._id },
    { $set: { meritScore: nextMerit, reliabilityScore: nextMerit } }
  );

  // Auto-suspension: N eligible cancellations within the configured window.
  if (!isCustomerSuspended(profile)) {
    const windowStart = now.getTime() - settings.cancellation.cancellationWindowDays * DAY_MS;
    const strikesInWindow = (profile.cancellationStats?.strikes || []).filter(
      (s) => s.at && new Date(s.at).getTime() >= windowStart
    ).length;
    if (strikesInWindow >= settings.cancellation.customerStrikeThreshold) {
      await suspendCustomer({
        customerUserId: booking.customer,
        reason: `${strikesInWindow} eligible cancellations in the last ${settings.cancellation.cancellationWindowDays} days.`,
        count: (profile.suspensionCount ?? 0) + 1,
      });
    }
  }
  return { meritScore: nextMerit };
};

const recordWorkerStrike = async ({ booking, outcome, settings }) => {
  const now = new Date();
  const workerId = booking.worker;
  if (!workerId) return null;

  const profile = await Worker.findOneAndUpdate(
    { _id: workerId },
    {
      $push: {
        'cancellationStats.strikes': {
          at: now,
          booking: booking._id,
          reason: outcome.reasonKey,
          stage: outcome.stage,
        },
      },
      $inc: { 'cancellationStats.eligibleCancellationCount': 1 },
      $set: { 'cancellationStats.lastCancelledAt': now },
    },
    { new: true }
  );
  if (!profile) return null;

  const windowStart = now.getTime() - settings.cancellation.cancellationWindowDays * DAY_MS;
  const strikesInWindow = (profile.cancellationStats?.strikes || []).filter(
    (s) => s.at && new Date(s.at).getTime() >= windowStart
  ).length;
  if (
    strikesInWindow >= settings.cancellation.workerStrikeThreshold &&
    !['TEMPORARILY_SUSPENDED', 'DEACTIVATION_REVIEW'].includes(profile.accountStatus)
  ) {
    await suspendWorkerByStrikes({
      workerId,
      reason: `${strikesInWindow} eligible cancellations in the last ${settings.cancellation.cancellationWindowDays} days.`,
      count: (profile.autoSuspensionCount ?? 0) + 1,
    });
  }
  return { strikesInWindow };
};

// ── Core apply ──────────────────────────────────────────────────────────

/**
 * Apply a cancellation idempotently.
 *
 * @param {Object} opts
 * @param {Object} opts.booking  loaded booking document
 * @param {'customer'|'worker'|'admin'|'system'} opts.cancelledBy
 * @param {string} opts.reasonKey
 * @param {string} [opts.reason] free-text/display reason
 * @param {ObjectId} [opts.actorId] the user id that requested it
 * @param {boolean} [opts.refundHandler] optional fn(booking, outcome) invoked for paid bookings
 */
const applyCancellation = async ({
  booking,
  cancelledBy,
  reasonKey,
  reason = '',
  actorId = null,
  refundHandler = null,
}) => {
  if (!booking) {
    const err = new Error('Booking not found');
    err.statusCode = 404;
    throw err;
  }
  if (booking.status === 'CANCELLED') {
    const existing = await Cancellation.findOne({ booking: booking._id });
    return { skipped: true, duplicate: true, cancellation: existing, booking };
  }
  assertCancellable(booking);

  const settings = await getSettings();
  const outcome = buildOutcome(booking, cancelledBy, reasonKey, settings);

  // Atomically claim the cancellation. The status guard is what makes
  // concurrent/duplicate requests safe: only one caller wins.
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: booking.status },
    {
      $set: {
        status: 'CANCELLED',
        cancelledBy,
        cancellationReason: reason || outcome.reasonLabel,
        cancelledAt: new Date(),
        cancellationStage: outcome.stage,
        cancellationPenalty: outcome.customerPenaltyAmount,
        cancellationPenaltyEligible: outcome.penaltyEligible,
        workerCompensation: outcome.workerCompensationAmount,
        cancellationStrikeApplied: outcome.customerStrikeApplied || outcome.workerStrikeApplied,
      },
      $push: {
        statusHistory: {
          status: 'CANCELLED',
          updatedAt: new Date(),
          updatedBy: actorId,
          note: reason || outcome.reasonLabel,
        },
      },
    },
    { new: true }
  );

  if (!claimed) {
    const existing = await Cancellation.findOne({ booking: booking._id });
    return { skipped: true, duplicate: true, cancellation: existing, booking };
  }

  // Ledger row (unique per booking+cancelledBy). Guard against a race with a
  // differently-attributed concurrent request.
  let cancellation;
  try {
    cancellation = await Cancellation.create({
      booking: booking._id,
      bookingNumber: booking.bookingNumber,
      cancelledBy,
      cancelledByUser: actorId,
      customer: booking.customer,
      worker: booking.worker || null,
      reason: reason || outcome.reasonLabel,
      reasonKey: outcome.reasonKey,
      stage: outcome.stage,
      penaltyEligible: outcome.penaltyEligible,
      customerPenaltyAmount: outcome.customerPenaltyAmount,
      workerCompensationAmount: outcome.workerCompensationAmount,
      customerStrikeApplied: outcome.customerStrikeApplied,
      workerStrikeApplied: outcome.workerStrikeApplied,
      workerMeritPoints: outcome.workerMeritPoints,
      workerMeritEventType: outcome.workerMeritEventType,
      compensationStatus: outcome.workerCompensationAmount > 0 ? 'PENDING' : 'NONE',
      cancelledAt: new Date(),
    });
  } catch (e) {
    if (e && e.code === 11000) {
      cancellation = await Cancellation.findOne({ booking: booking._id });
    } else {
      throw e;
    }
  }

  if (cancellation) {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { cancellationLedger: cancellation._id } }
    );
  }

  // ── Financial ledgers (never silently folded into service price) ──
  if (outcome.customerPenaltyAmount > 0) {
    await Customer.updateOne(
      { user: booking.customer },
      { $inc: { outstandingCancellationBalance: outcome.customerPenaltyAmount } },
      { upsert: true, setDefaultsOnInsert: true }
    ).catch((e) => console.error('[cancellation] balance update error:', e.message));
  }

  // ── Worker travel compensation: credit IMMEDIATELY so the worker's wallet
  //     reflects the money now, instead of waiting for the (possibly never
  //     arriving) next paid booking. creditCompensation is idempotent by
  //     reference (COMP-<cancellationId>); if this credit fails, the ledger
  //     stays PENDING and settleCarriedCancellationBalance remains the fallback.
  if (outcome.workerCompensationAmount > 0 && booking.worker && cancellation) {
    try {
      const { creditCompensation } = require('../wallet/walletService');
      const res = await creditCompensation({
        workerId: booking.worker,
        amount: outcome.workerCompensationAmount,
        bookingId: booking._id,
        reference: `COMP-${cancellation._id}`,
      });
      if (res && res.created) {
        outcome.compensationCredited = true;
        await Cancellation.updateOne(
          { _id: cancellation._id },
          { $set: { compensationStatus: 'PAID', compensationSettled: true } }
        );
      }
    } catch (e) {
      console.error('[cancellation] immediate compensation credit error:', e.message);
    }
  }

  // ── Merchant / merit effects ──
  if (outcome.workerMeritPoints !== 0 && booking.worker) {
    try {
      await applyScoreChange({
        workerId: booking.worker,
        eventType: outcome.workerMeritEventType,
        points: outcome.workerMeritPoints,
        reason: `Cancelled after accepting (${outcome.stage.toLowerCase().replace('_', ' ')}): ${reason || outcome.reasonLabel}`,
        bookingId: booking._id,
        counterField:
          outcome.stage === 'POST_ACCEPT'
            ? 'cancelledAfterAcceptCount'
            : outcome.stage === 'JOURNEY'
            ? 'cancelledAfterJourneyCount'
            : outcome.stage === 'ARRIVED'
            ? 'cancelledAfterArrivalCount'
            : 'cancelledAfterWorkStartCount',
      });
    } catch (e) {
      console.error('[cancellation] worker merit error:', e.message);
    }
  }

  if (outcome.customerStrikeApplied) {
    await recordCustomerStrike({ booking, outcome, settings }).catch((e) =>
      console.error('[cancellation] customer strike error:', e.message)
    );
  }
  if (outcome.workerStrikeApplied) {
    await recordWorkerStrike({ booking, outcome, settings }).catch((e) =>
      console.error('[cancellation] worker strike error:', e.message)
    );
  }

  // ── Audit trail (never blocks the request) ──
  if (outcome.customerPenaltyAmount > 0) {
    const custProfile = await Customer.findOne({ user: booking.customer })
      .select('_id')
      .lean()
      .catch(() => null);
    await logAudit({
      action: ACTIONS.CANCELLATION_PENALTY_APPLIED,
      performedBy: actorId,
      targetUser: booking.customer,
      targetRole: 'customer',
      targetProfile: custProfile?._id ?? null,
      booking: booking._id,
      reason: outcome.reasonLabel,
      metadata: { amount: outcome.customerPenaltyAmount, stage: outcome.stage, reasonKey: outcome.reasonKey },
    });
  }
  if (outcome.workerCompensationAmount > 0 && booking.worker) {
    const wpUser = await Worker.findById(booking.worker)
      .select('user')
      .lean()
      .catch(() => null);
    await logAudit({
      action: ACTIONS.WORKER_COMPENSATION_CREATED,
      performedBy: actorId,
      targetUser: wpUser?.user ?? null,
      targetRole: 'worker',
      targetProfile: booking.worker,
      booking: booking._id,
      reason: 'Travel compensation from a cancellation',
      metadata: { amount: outcome.workerCompensationAmount, stage: outcome.stage, cancelledBy },
    });
  }

  // ── Collaboration cleanup ────────────────────────────────────────────
  // A cancelled booking must never keep surfacing in the collaboration feeds
  // or active team views. Close any OPEN/FILLED collaboration requests and drop
  // the team so no stale helper invitations remain.
  try {
    await require('../collaborator/teamFormationService')
      .closeCollaborationForBooking(booking._id, { status: 'CANCELLED' });
  } catch (e) {
    console.error('[cancellation] collaboration cleanup error:', e.message);
  }

  // ── Notifications ──
  await notifyCancellation({ booking, outcome, cancelledBy, actorId }).catch(() => {});

  // ── Optional refund handler (paid bookings) ──
  if (refundHandler) {
    try {
      await refundHandler(claimed, outcome);
    } catch (e) {
      console.error('[cancellation] refund handler error:', e.message);
    }
  }

  return { skipped: false, outcome, cancellation, booking: claimed };
};

const notifyCancellation = async ({ booking, outcome, cancelledBy }) => {
  const items = [];
  const serviceName = booking.serviceSnapshot?.name || 'service';
  const who =
    cancelledBy === 'worker'
      ? 'The worker'
      : cancelledBy === 'customer'
      ? 'The customer'
      : cancelledBy === 'admin'
      ? 'The platform'
      : 'The system';

  if (cancelledBy === 'worker' && booking.worker) {
    const wp = await Worker.findById(booking.worker).select('user').lean();
    items.push({
      user: booking.customer,
      type: 'BOOKING_CANCELLED',
      title: 'Worker cancelled',
      message: `${who} cancelled ${booking.bookingNumber} (${serviceName}). Reason: ${outcome.reasonLabel}.`,
      data: { bookingId: booking._id, cancelledBy, outcome: outcome.stage },
    });
    if (wp) {
      items.push({
        user: wp.user,
        type: 'BOOKING_CANCELLED',
        title: 'You cancelled a job',
        message: `You cancelled ${booking.bookingNumber}. ${outcome.penaltyEligible ? `A merit deduction of ${outcome.workerMeritPoints} was applied.` : 'No penalty was applied for this reason.'}`,
        data: { bookingId: booking._id, outcome },
      });
    }
  } else if (cancelledBy === 'customer') {
    items.push({
      user: booking.customer,
      type: 'BOOKING_CANCELLED',
      title: 'Booking cancelled',
      message:
        outcome.customerPenaltyAmount > 0
          ? `Your booking ${booking.bookingNumber} was cancelled. A cancellation fee of ₹${outcome.customerPenaltyAmount} will be added to your next booking.`
          : `Your booking ${booking.bookingNumber} was cancelled. No cancellation fee was applied.`,
      data: { bookingId: booking._id, outcome },
    });
    if (booking.worker) {
      const wp = await Worker.findById(booking.worker).select('user').lean();
      if (wp) {
        items.push({
          user: wp.user,
          type: 'BOOKING_CANCELLED',
          title: 'Customer cancelled',
          message: `The customer cancelled ${booking.bookingNumber}.${
            outcome.workerCompensationAmount > 0
              ? outcome.compensationCredited
                ? ` ₹${outcome.workerCompensationAmount} travel compensation was credited to your wallet.`
                : ` You are eligible for ₹${outcome.workerCompensationAmount} travel compensation (recorded for settlement).`
              : ''
          }`,
          data: { bookingId: booking._id, compensation: outcome.workerCompensationAmount },
        });
      }
    }
  }
  if (items.length) {
    const { notifyUsers } = require('../notification/notificationService');
    await notifyUsers(items);
  }
};

// ── Settlement of carried balances (called on successful payment) ───────

/**
 * When a booking that carries an outstanding cancellation balance is PAID,
 * clear the customer's balance, mark the source penalties settled and settle
 * any pending worker compensation from those cancellations.
 * Idempotent via the booking's collectedCancellationBalance CAS guard.
 */
const settleCarriedCancellationBalance = async ({ booking }) => {
  const amount = round2(booking?.carriedCancellationBalance || 0);
  if (!(amount > 0) || booking.collectedCancellationBalance) {
    return { settled: false };
  }

  // Only one payment may win the right to settle this balance.
  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, collectedCancellationBalance: false },
    { $set: { collectedCancellationBalance: true } },
    { new: true }
  );
  if (!claimed) return { settled: false };

  const customerUserId = booking.customer;
  await Customer.updateOne(
    { user: customerUserId },
    {
      $inc: { outstandingCancellationBalance: -amount },
      $set: { 'cancellationStats.lastSettledAt': new Date() },
    }
  );
  const cust = await Customer.findOne({ user: customerUserId }).select('outstandingCancellationBalance');
  if (cust && cust.outstandingCancellationBalance < 0) {
    await Customer.updateOne(
      { user: customerUserId },
      { $set: { outstandingCancellationBalance: 0 } }
    );
  }

  await Cancellation.updateMany(
    { customer: customerUserId, customerPenaltyAmount: { $gt: 0 }, customerPenaltySettled: false },
    { $set: { customerPenaltySettled: true } }
  );

  // Pay out worker compensation that is now funded by the collected fee.
  const pending = await Cancellation.find({
    customer: customerUserId,
    compensationStatus: 'PENDING',
    compensationSettled: false,
  });
  for (const c of pending) {
    // CAS claim so a concurrent settlement can never double-pay.
    const claimed = await Cancellation.findOneAndUpdate(
      { _id: c._id, compensationStatus: 'PENDING', compensationSettled: false },
      { $set: { compensationSettled: true, compensationStatus: 'PAID' } },
      { new: true }
    );
    if (!claimed) continue;

    if (c.workerCompensationAmount > 0 && c.worker) {
      try {
        const { creditCompensation } = require('../wallet/walletService');
        await creditCompensation({
          workerId: c.worker,
          amount: c.workerCompensationAmount,
          bookingId: c.booking,
          reference: `COMP-${c._id}`,
        });
      } catch (e) {
        console.error('[cancellation] compensation credit error:', e.message);
        await Cancellation.updateOne(
          { _id: c._id },
          { $set: { compensationSettled: false, compensationStatus: 'PENDING' } }
        ).catch(() => {});
      }
    }
  }

  return { settled: true, amount };
};

module.exports = {
  CUSTOMER_CANCELLATION_REASONS,
  WORKER_CANCELLATION_REASONS,
  getCancellationReasons,
  resolveCancellationStage,
  calculateCancellationOutcome: async (booking, cancelledBy, reasonKey) => {
    assertCancellable(booking);
    const settings = await getSettings();
    return buildOutcome(booking, cancelledBy, reasonKey, settings);
  },
  applyCancellation,
  isCustomerSuspended,
  restoreCustomerIfExpired,
  sweepExpiredCustomerSuspensions,
  enforceCustomerNotSuspended,
  unsuspendCustomerByAdmin,
  suspendDurationForCount,
  suspendCustomer,
  suspendWorkerByStrikes,
  settleCarriedCancellationBalance,
  round2,
};