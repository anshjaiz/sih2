const mongoose = require('mongoose');
const readline = require('node:readline');
const env = require('../config/env');

const User = require('../models/User');
const Customer = require('../models/CustomerProfile');
const Worker = require('../models/WorkerProfile');
const Notification = require('../models/Notification');
const Booking = require('../models/Booking');
const Review = require('../models/Review');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const ChatMessage = require('../models/Message');
const Refund = require('../models/Refund');
const Complaint = require('../models/Complaint');
const WalletTransaction = require('../models/WalletTransaction');
const WorkerWallet = require('../models/WorkerWallet');
const WorkerReliability = require('../models/WorkerReliability');
const ReliabilityEvent = require('../models/ReliabilityEvent');
const PenaltyAppeal = require('../models/PenaltyAppeal');
const Payout = require('../models/Payout');
const WorkerPayoutMethod = require('../models/WorkerPayoutMethod');
const Welfare = require('../models/Welfare');
const WorkerAvailability = require('../models/WorkerAvailability');
const Certificate = require('../models/Certificate');
const JobTeam = require('../models/JobTeam');
const CollaborationRequest = require('../models/CollaborationRequest');

const TARGET_ROLES = ['customer', 'worker'];
const CONFIRM_PHRASE = 'RESET USERS';

const prompt = (query) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => { rl.close(); resolve(answer.trim()); }));
};

const main = async () => {
  await mongoose.connect(env.mongoURI);

  const targetUsers = await User.find({ role: { $in: TARGET_ROLES } }).select('name email role phone');
  if (!targetUsers.length) {
    console.log('No Customer/Worker accounts found. Nothing to reset.');
    await mongoose.disconnect();
    return;
  }

  const targetIds = targetUsers.map((u) => u._id);
  const workerProfileIds = (await Worker.find({ user: { $in: targetIds } }).select('_id')).map((w) => w._id);

  const relatedDeletes = [
    { model: Notification, filter: { $or: [{ user: { $in: targetIds } }, { 'data.userId': { $in: targetIds } }] }, label: 'notifications' },
    { model: Booking, filter: { $or: [{ customer: { $in: targetIds } }, { worker: { $in: workerProfileIds } }] }, label: 'bookings' },
    { model: Review, filter: { $or: [{ reviewer: { $in: targetIds } }, { reviewee: { $in: targetIds } }] }, label: 'reviews' },
    { model: Payment, filter: { $or: [{ customer: { $in: targetIds } }, { worker: { $in: workerProfileIds } }] }, label: 'payments' },
    { model: Invoice, filter: { $or: [{ customer: { $in: targetIds } }, { worker: { $in: workerProfileIds } }] }, label: 'invoices' },
    { model: ChatMessage, filter: { $or: [{ sender: { $in: targetIds } }, { recipient: { $in: targetIds } }] }, label: 'chat messages' },
    { model: Refund, filter: { $or: [{ customer: { $in: targetIds } }, { initiatedBy: { $in: targetIds } }] }, label: 'refunds' },
    { model: Complaint, filter: { $or: [{ customer: { $in: targetIds } }, { worker: { $in: workerProfileIds } }] }, label: 'complaints' },
    { model: WalletTransaction, filter: { worker: { $in: workerProfileIds } }, label: 'wallet transactions' },
    { model: WorkerWallet, filter: { worker: { $in: workerProfileIds } }, label: 'worker wallets' },
    { model: WorkerReliability, filter: { worker: { $in: workerProfileIds } }, label: 'worker reliability records' },
    { model: ReliabilityEvent, filter: { worker: { $in: workerProfileIds } }, label: 'reliability events' },
    { model: PenaltyAppeal, filter: { worker: { $in: workerProfileIds } }, label: 'penalty appeals' },
    { model: Payout, filter: { worker: { $in: workerProfileIds } }, label: 'payouts' },
    { model: WorkerPayoutMethod, filter: { worker: { $in: workerProfileIds } }, label: 'worker payout methods' },
    { model: Welfare, filter: { worker: { $in: workerProfileIds } }, label: 'welfare records' },
    { model: WorkerAvailability, filter: { worker: { $in: workerProfileIds } }, label: 'worker availabilities' },
    { model: Certificate, filter: { $or: [{ worker: { $in: workerProfileIds } }, { reviewedBy: { $in: targetIds } }] }, label: 'certificates' },
    { model: JobTeam, filter: { $or: [{ leadWorker: { $in: workerProfileIds } }, { 'members.worker': { $in: workerProfileIds } }] }, label: 'job teams' },
    { model: CollaborationRequest, filter: { $or: [{ leadWorker: { $in: workerProfileIds } }, { 'candidates.worker': { $in: workerProfileIds } }] }, label: 'collaboration requests' },
  ];

  const counts = {};
  for (const d of relatedDeletes) counts[d.label] = await d.model.countDocuments(d.filter);

  const customerUsers = targetUsers.filter((u) => u.role === 'customer');
  const workerUsers = targetUsers.filter((u) => u.role === 'worker');
  const protectedUsers = await User.find({ role: { $ne: null, $nin: TARGET_ROLES } }).select('name email role');

  const totalRelated = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log('\n============================================');
  console.log('  SHRAMIK SETU — USER RESET PLAN (dry run)');
  console.log('============================================');
  console.log(`Database  : ${env.mongoURI.split('/').pop() || env.mongoURI}`);
  console.log(`Role field: "role"  Targeted roles: ${TARGET_ROLES.join(', ')}`);
  console.log('');
  console.log(`ACCOUNTS TO DELETE`);
  console.log(`  Customer users : ${customerUsers.length}`);
  console.log(`  Worker users   : ${workerUsers.length}`);
  if (customerUsers.length || workerUsers.length) {
    console.log(`  (first-of-list)`);
    [...customerUsers, ...workerUsers].slice(0, 9).forEach((u) =>
      console.log(`    - ${u.name} <${u.email}> [${u.role}]`)
    );
    if (targetUsers.length > 9) console.log(`    ... and ${targetUsers.length - 9} more`);
  }
  console.log(`\nRELATED DOCUMENTS TO DELETE (owned by these accounts)`);
  for (const [label, n] of Object.entries(counts)) console.log(`  ${n.toString().padStart(6)}  ${label}`);
  console.log(`  ${String(totalRelated).padStart(6)}  TOTAL related documents`);
  console.log(`\nPROTECTED / PRESERVED`);
  console.log(`  Admin/other user accounts: ${protectedUsers.length}`);
  protectedUsers.forEach((u) => console.log(`    - ${u.name} <${u.email}> [${u.role}] (kept)`));
  console.log(`  Platform data kept: cooperatives, services, skills, reliability settings, forecasts, demand records, AI models, trainings`);
  console.log('   NOTE: No database, application code, schema, index, or env config is touched.');
  console.log('============================================\n');

  const answer = await prompt(`Type "${CONFIRM_PHRASE}" to permanently delete ${targetUsers.length} account(s) + ${totalRelated} related document(s), or anything else to cancel: `);
  if (answer !== CONFIRM_PHRASE) {
    console.log('Reset cancelled. Nothing was deleted.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nDeleting related documents...');
  for (const d of relatedDeletes) {
    const res = await d.model.deleteMany(d.filter);
    console.log(`  deleted ${res.deletedCount} ${d.label}`);
  }

  console.log('Deleting worker/customer profiles...');
  const delWorkers = await Worker.deleteMany({ user: { $in: targetIds } });
  const delCustomers = await Customer.deleteMany({ user: { $in: targetIds } });
  console.log(`  deleted ${delWorkers.deletedCount} worker profiles`);
  console.log(`  deleted ${delCustomers.deletedCount} customer profiles`);

  console.log('Deleting target user accounts...');
  const delUsers = await User.deleteMany({ _id: { $in: targetIds } });
  console.log(`  deleted ${delUsers.deletedCount} user account(s)`);

  const remaining = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
  console.log('\n============================================');
  console.log('  RESET COMPLETE');
  console.log('============================================');
  console.log(`  Customer accounts deleted : ${customerUsers.length}`);
  console.log(`  Worker accounts deleted   : ${workerUsers.length}`);
  console.log(`  Related documents deleted : ${totalRelated}`);
  console.log(`  Remaining users by role   : ${remaining.map((r) => `${r._id || '?'}=${r.count}`).join(', ') || 'none'}`);
  console.log('  Admin login is untouched. You can now register fresh accounts.');
  console.log('============================================\n');

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error('\nReset failed:', err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});