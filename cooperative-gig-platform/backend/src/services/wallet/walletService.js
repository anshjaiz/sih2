/**
 * walletService.js
 *
 * Audit-safe worker wallet. Every balance movement is recorded as a
 * WalletTransaction ledger row; wallet balances are only ever changed with
 * atomic $inc operations (CAS guards), NEVER with client-provided amounts.
 *
 * Idempotency (the standalone MongoDB has no replica set, so instead of
 * multi-document transactions we rely on compare-and-swap + unique indexes):
 *   - JOB_EARNING credential is unique per payment → replayed verification
 *     or duplicate confirm-calls can never double-credit a worker.
 *   - release/reverse transition the ledger row with
 *     updateOne({ _id, status: 'PENDING' }, { status: 'COMPLETED' })
 *     so only ONE caller can win the transition.
 */

const WorkerWallet = require('../../models/WorkerWallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Payout = require('../../models/Payout');
const Payment = require('../../models/Payment');
const Booking = require('../../models/Booking');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── Wallet bootstrap ---------------------------------------------------

const getOrCreateWallet = async (workerId) => {
  let wallet = await WorkerWallet.findOne({ worker: workerId });
  if (wallet) return wallet;

  // First access: seed totals from any already-paid bookings so balances
  // reflect historical SUCCESS/PAID payments without manual migration.
  const payments = await Payment.find({
    worker: workerId,
    status: { $in: ['PAID', 'SUCCESS'] },
  }).select('workerNetEarnings booking');

  wallet = await WorkerWallet.create({
    worker: workerId,
    availableBalance: 0,
    pendingBalance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
  });

  // Bootstrap ledger + pending balances for pre-wallet payments.
  for (const p of payments) {
    const confirmed =
      p.booking &&
      (await Booking.exists({ _id: p.booking, customerConfirmed: true }));
    const amount = round2(p.workerNetEarnings || 0);
    if (amount <= 0) continue;
    await WalletTransaction.findOneAndUpdate(
      { payment: p._id, type: 'JOB_EARNING' },
      {
        $setOnInsert: {
          worker: workerId,
          booking: p.booking,
          amount,
          description: 'Historical job earning (migrated from paid booking)',
          reference: 'BOOTSTRAP',
          status: confirmed ? 'COMPLETED' : 'PENDING',
        },
      },
      { upsert: true }
    ).catch(() => {});
    await WorkerWallet.updateOne(
      { _id: wallet._id },
      confirmed
        ? { $inc: { availableBalance: amount, totalEarned: amount } }
        : { $inc: { pendingBalance: amount, totalEarned: amount } }
    );
  }
  return WorkerWallet.findOne({ worker: workerId });
};

// ── Earning credit (on payment verification) ---------------------------
// IDEMPOTENT: unique (payment, type). Returns { created, transaction, earning }.
const creditJobEarning = async ({ bookingId, paymentId, workerId, amount }) => {
  const earning = round2(amount);
  if (earning <= 0) return { created: false, earning: 0 };
  const txn = await WalletTransaction.create({
    worker: workerId,
    booking: bookingId,
    payment: paymentId,
    type: 'JOB_EARNING',
    amount: earning,
    status: 'PENDING',
    description: 'Job earning held until customer confirms completion',
    reference: `PAY-${paymentId}`,
  }).catch((err) => {
    if (err && err.code === 11000) return null; // already credited
    throw err;
  });

  if (!txn) {
    return { created: false, earning };
  }
  await WorkerWallet.updateOne(
    { worker: workerId },
    { $inc: { pendingBalance: earning, totalEarned: earning } }
  );
  return { created: true, transaction: txn, earning };
};

// ── Cancellation compensation credit (funded by a collected cancel fee) ─
// IDEMPOTENT by `reference`: re-running with the same reference returns the
// existing txn instead of double-crediting the worker.
const creditCompensation = async ({ workerId, amount, bookingId, reference }) => {
  const credit = round2(amount);
  if (credit <= 0) return { created: false, credit: 0 };

  const existing = await WalletTransaction.findOne({
    worker: workerId,
    type: 'ADJUSTMENT',
    reference,
  });
  if (existing) return { created: false, transaction: existing, credit };

  const txn = await WalletTransaction.create({
    worker: workerId,
    booking: bookingId,
    type: 'ADJUSTMENT',
    amount: credit,
    status: 'COMPLETED',
    description: 'Compensation for travel after a cancelled booking',
    reference,
  }).catch((err) => {
    if (err && err.code === 11000) return null;
    throw err;
  });
  if (!txn) return { created: false, credit };

  await getOrCreateWallet(workerId);
  await WorkerWallet.updateOne(
    { worker: workerId },
    { $inc: { availableBalance: credit, totalEarned: credit } }
  );
  return { created: true, transaction: txn, credit };
};

// ── Earning release (customer confirms completion) ---------------------
// IDEMPOTENT: a PENDING txn proceeds to COMPLETED exactly once.
const releaseEarning = async ({ bookingId, workerId }) => {
  const txn = await WalletTransaction.findOneAndUpdate(
    {
      booking: bookingId,
      worker: workerId,
      type: 'JOB_EARNING',
      status: 'PENDING',
    },
    { $set: { status: 'COMPLETED', description: 'Earning released — job completed and confirmed by customer' } },
    { new: true }
  );

  if (!txn) {
    return { released: false };
  }
  const amount = round2(txn.amount);
  await WorkerWallet.updateOne(
    { worker: workerId },
    { $inc: { availableBalance: amount, pendingBalance: -amount } }
  );
  return { released: true, transaction: txn, amount };
};

// ── Earning reversal (refund / dispute) --------------------------------
// Reverses a credited (COMPLETED) or still-held (PENDING) earning. Idempotent
// by only matching txns still in {PENDING, COMPLETED}.
const reverseEarning = async ({ bookingId, workerId, reference = 'REFUND' }) => {
  // Capture the CURRENT status first (PENDING or COMPLETED), then transition
  // with a CAS guard so only one reversal can win per earning.
  const txn = await WalletTransaction.findOne({
    booking: bookingId,
    worker: workerId,
    type: 'JOB_EARNING',
    status: { $in: ['PENDING', 'COMPLETED'] },
  }).select('amount status');
  if (!txn) return { reversed: false };
  const prior = txn.status; // 'PENDING' or 'COMPLETED'

  const won = await WalletTransaction.updateOne(
    { _id: txn._id, status: { $in: ['PENDING', 'COMPLETED'] } },
    { $set: { status: 'REVERSED', reference } }
  );
  if (won.modifiedCount !== 1) return { reversed: false };

  const amount = round2(txn.amount);
  if (prior === 'COMPLETED') {
    // Earning had already been released into the available balance.
    await WorkerWallet.updateOne(
      { worker: workerId },
      { $inc: { availableBalance: -amount, pendingBalance: 0 } }
    );
  }
  await WorkerWallet.updateOne(
    { worker: workerId },
    { $inc: { pendingBalance: prior === 'PENDING' ? -amount : 0, totalEarned: -amount } }
  );
  return { reversed: true, amount };
};

// ── Withdrawal ----------------------------------------------------------

const requestWithdrawal = async ({ workerId, amount, payoutMethodId }) => {
  const amt = round2(amount);
  if (!(amt > 0)) {
    const err = new Error('Withdrawal amount must be greater than 0');
    err.userMessage = 'Please enter an amount greater than 0 to withdraw.';
    throw err;
  }

  const wallet = await getOrCreateWallet(workerId);
  if (wallet.availableBalance < amt) {
    const err = new Error('Insufficient balance');
    err.userMessage = "You don't have enough available balance for this withdrawal.";
    throw err;
  }

  // Hold the funds atomically: only decrement if enough balance remains.
  const held = await WorkerWallet.updateOne(
    { worker: workerId, availableBalance: { $gte: amt } },
    { $inc: { availableBalance: -amt } }
  );
  if (held.modifiedCount !== 1) {
    const err = new Error('Insufficient balance');
    err.userMessage = "You don't have enough available balance for this withdrawal.";
    throw err;
  }

  const payout = await Payout.create({
    worker: workerId,
    amount: amt,
    payoutMethodId: payoutMethodId || undefined,
    status: 'PENDING',
    requestedAt: new Date(),
  });

  await WalletTransaction.create({
    worker: workerId,
    booking: undefined,
    payment: undefined,
    type: 'WITHDRAWAL',
    amount: amt,
    status: 'PENDING',
    description: `Withdrawal request ${payout.payoutNumber}`,
    reference: payout.payoutNumber,
  });

  return payout;
};

// Admin lifecycle: PENDING → PROCESSING → COMPLETED/FAILED/CANCELLED
const setPayoutStatus = async ({ payoutId, status, adminId, transactionReference, failureReason }) => {
  const payout = await Payout.findById(payoutId);
  if (!payout) {
    const err = new Error('Payout not found');
    err.userMessage = 'Payout request not found.';
    throw err;
  }

  const allowed = {
    PENDING: ['PROCESSING', 'CANCELLED', 'FAILED'],
    PROCESSING: ['COMPLETED', 'FAILED'],
  };
  if (!(allowed[payout.status] || []).includes(status)) {
    const err = new Error(`Cannot move payout from ${payout.status} to ${status}`);
    err.userMessage = `Cannot move payout from ${payout.status} to ${status}.`;
    throw err;
  }

  payout.status = status;
  if (status === 'PROCESSING') payout.processedAt = new Date();
  if (status === 'FAILED') {
    payout.failureReason = failureReason || 'Payout could not be processed';
  }
  payout.reviewedBy = adminId;
  if (transactionReference) payout.transactionReference = transactionReference;
  await payout.save();

  // Ledger updates for terminal states.
  if (status === 'COMPLETED') {
    await WalletTransaction.updateOne(
      { reference: payout.payoutNumber, type: 'WITHDRAWAL', status: 'PENDING' },
      { $set: { status: 'COMPLETED', description: `Withdrawal ${payout.payoutNumber} paid out` } }
    );
    await WorkerWallet.updateOne({ worker: payout.worker }, { $inc: { totalWithdrawn: round2(payout.amount) } });
  } else if (status === 'FAILED' || status === 'CANCELLED') {
    // Return the held funds to the worker's balance.
    await WalletTransaction.updateOne(
      { reference: payout.payoutNumber, type: 'WITHDRAWAL', status: 'PENDING' },
      { $set: { status: 'REVERSED', description: `Withdrawal ${payout.payoutNumber} failed — funds returned` } }
    );
    await WorkerWallet.updateOne({ worker: payout.worker }, { $inc: { availableBalance: round2(payout.amount) } });
  }
  return payout;
};

const getWalletSummary = async (workerId) => {
  const wallet = await getOrCreateWallet(workerId);
  const [pendingTxns, walletTxns, payouts] = await Promise.all([
    WalletTransaction.countDocuments({ worker: workerId, status: 'PENDING', type: { $in: ['JOB_EARNING', 'WITHDRAWAL'] } }),
    WalletTransaction.find({ worker: workerId }).sort({ createdAt: -1 }).limit(20),
    Payout.find({ worker: workerId }).sort({ requestedAt: -1 }).limit(20),
  ]);
  return {
    wallet,
    summary: {
      availableBalance: round2(wallet.availableBalance),
      pendingBalance: round2(wallet.pendingBalance),
      totalEarned: round2(wallet.totalEarned),
      totalWithdrawn: round2(wallet.totalWithdrawn),
      pendingCount: pendingTxns,
    },
    transactions: walletTxns,
    payouts,
  };
};

module.exports = {
  round2,
  getOrCreateWallet,
  creditJobEarning,
  creditCompensation,
  releaseEarning,
  reverseEarning,
  requestWithdrawal,
  setPayoutStatus,
  getWalletSummary,
};