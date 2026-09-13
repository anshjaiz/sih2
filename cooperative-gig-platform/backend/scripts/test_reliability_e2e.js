/**
 * E2E test for the reliability/merit + job lifecycle feature (spec Section 16).
 *
 * Covers acceptance gate & earning suspension, scheduling, no-show penalty,
 * reassignment via strict matching, job expiry, late-arrival penalty, cancel
 * after accept, good-rating bonus, appeal approve/reject, admin adjustment,
 * scheduler idempotency, and that suspended workers can still view their
 * reliability & appeals.
 *
 * Uses the LIVE server (http://localhost:5001) for API flows and direct
 * mongoose writes to control time (scheduled* fields), plus the real
 * runSchedulerOnce() so the scheduler's own code is exercised.
 */

const mongoose = require('mongoose');
const assert = require('assert');
const { runSchedulerOnce } = require('../src/services/reliability/scheduler');

// ---- models (register everything the services touch) ----
require('../src/models/User');
require('../src/models/Skill');
require('../src/models/Service');
require('../src/models/Cooperative');
require('../src/models/WorkerAvailability');
require('../src/models/Notification');
require('../src/models/WorkerReliability');
require('../src/models/ReliabilityEvent');
require('../src/models/ReliabilitySettings');
require('../src/models/PenaltyAppeal');
require('../src/models/Booking');
require('../src/models/WorkerProfile');
require('../src/models/CustomerProfile');

const Booking = require('../src/models/Booking');
const Worker = require('../src/models/WorkerProfile');
const ReliabilityEvent = require('../src/models/ReliabilityEvent');
const PenaltyAppeal = require('../src/models/PenaltyAppeal');
const JobTeam = require('../src/models/JobTeam');
const CollaborationRequest = require('../src/models/CollaborationRequest');
const { getSettings } = require('../src/services/reliability/reliabilityConfig');

const BASE = 'http://localhost:5001/api';
const SERVICE_ID = '6aa01569a9f6f5694c19b477'; // Deep House Cleaning (Cleaning/Domestic Help)
const BOOKING_LOC = [78.4867, 17.385]; // near worker20 (Hyderabad)

const results = [];
function check(name, cond, extra = '') {
  const ok = !!cond;
  results.push({ name, ok, extra: ok ? '' : String(extra) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   <- ' + extra}`);
}

const call = async (method, path, { token, json, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  let data;
  try { data = await res.json(); } catch (_) { data = {}; }
  return { status: res.status, data };
};

const login = async (email, password) => {
  const r = await call('POST', '/auth/login', { json: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
  return r.data.data.token;
};

const createBooking = async (token, overrides = {}) => {
  const payload = {
    serviceId: overrides.serviceId || SERVICE_ID,
    description: overrides.description || 'E2E reliability test booking',
    address: overrides.address || '4-1-99, Abids Road, Hyderabad',
    area: overrides.area || 'Hyderabad',
    city: overrides.city || 'Hyderabad',
    requestedDate: overrides.requestedDate || new Date(Date.now() + 2 * 86400000).toISOString(),
    timeSlot: overrides.timeSlot || 'Evening',
    location: { type: 'Point', coordinates: overrides.coordinates || BOOKING_LOC },
  };
  const r = await call('POST', '/customers/bookings', { token, json: payload });
  const booking = r.data?.data?.booking;
  if (r.status < 200 || r.status >= 300 || !booking || !booking._id) {
    throw new Error(`createBooking failed: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return booking;
};

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/cooperative_gig_platform');

  // Purge leftover no-worker test bookings from previous runs.
  await Booking.deleteMany({ description: /E2E/, worker: null });

  const adminToken = await login('admin@coop.in', 'Admin@123');
  const customerToken = await login('customer10@test.com', 'Pass@123');
  const workerToken = await login('worker20@test.com', 'Pass@123');

  const prof = (await call('GET', '/workers/profile', { token: workerToken })).data.data;
  const User = require('../src/models/User');
  const wUser = await User.findById(prof.user).select('email').lean();
  const isTestWorker = wUser && /@test\.com$/.test(wUser.email);

  // Reset the test worker's reliability state so the run is repeatable.
  // This is safe ONLY for the seeded @test.com workers.
  if (isTestWorker) {
    const worker20p = await Worker.findOne({ user: prof.user });
    await ReliabilityEvent.deleteMany({ worker: worker20p._id });
    await PenaltyAppeal.deleteMany({ worker: worker20p._id });
    await require('../src/models/WorkerReliability').deleteMany({ worker: worker20p._id });
    await Booking.updateMany(
      { worker: worker20p._id, status: { $in: ['WORKER_NO_SHOW', 'REASSIGNED', 'EXPIRED'] } },
      { $set: { status: 'EXPIRED' } }
    );
    await Worker.updateOne(
      { _id: worker20p._id },
      { $set: { reliability: 100, accountStatus: 'ACTIVE', suspensionNote: '', suspendedUntil: null } }
    );
  }
  const worker20 = await Worker.findOne({ user: prof ? prof.user : null }).select('_id reliability accountStatus').lean();
  const worker20Id = worker20._id.toString();
  // mocha-style snapshot helpers
  const score = async () => {
    const r = await call('GET', '/workers/me/reliability', { token: workerToken });
    return { doc: r.data.data.reliability, events: r.data.data.recentEvents, raw: r.data.data };
  };

  // ============ CASE 2: booking scheduling ============
  let B1;
  try {
    B1 = await createBooking(customerToken, { requestedDate: '2026-09-12T09:00:00.000Z' });
    const start = new Date(B1.scheduledStartTime);
    const end = new Date(B1.scheduledEndTime);
    check('CASE2 scheduledStartTime derived', B1.scheduledStartTime != null, B1.scheduledStartTime);
    check('CASE2 scheduledEndTime derived', B1.scheduledEndTime != null, B1.scheduledEndTime);
    check('CASE2 slot window is 4h (Evening 17–21)', (end - start) === 4 * 3600 * 1000, `${end - start}`);
    check('CASE2 candidate contains worker20', B1.candidateWorkers.some((c) => c.worker?.toString() === worker20Id), JSON.stringify(B1.candidateWorkers));
  } catch (e) { check('CASE2 booking created', false, e.message); }

  // ============ CASE 11/CASE 1: suspension gate + view access ============
  const SUS = await call('POST', `/admin/reliability/workers/${worker20Id}/suspend`, {
    token: adminToken, json: { accountStatus: 'TEMPORARILY_SUSPENDED', durationDays: 1, reason: 'E2E test suspension' },
  });
  check('CASE11 suspend sets TEMPORARILY_SUSPENDED', SUS.data?.data?.accountStatus === 'TEMPORARILY_SUSPENDED', JSON.stringify(SUS.data));

  let B2, B8;
  try {
    const acceptBlocked = await call('POST', `/workers/jobs/${B1._id}/accept`, { token: workerToken });
    check('CASE1 accept blocked while suspended (403)', acceptBlocked.status === 403, `${acceptBlocked.status} ${JSON.stringify(acceptBlocked.data)}`);
    check('CASE1 block message mentions reliability', (/reliability/i.test(acceptBlocked.data?.message || '')), acceptBlocked.data?.message);

    B8 = await createBooking(customerToken, { description: 'E2E matching-exclusion check' });
    check('CASE11 suspended worker excluded from matching', !B8.candidateWorkers.some((c) => c.worker?.toString() === worker20Id), JSON.stringify(B8.candidateWorkers.map((c) => String(c.worker))));

    const relView = await call('GET', '/workers/me/reliability', { token: workerToken });
    check('CASE11 reliability still viewable while suspended', relView.status === 200 && relView.data?.data?.reliability, `${relView.status}`);
    const appealsView = await call('GET', '/workers/me/appeals', { token: workerToken });
    check('CASE11 appeals still viewable while suspended', appealsView.status === 200, `${appealsView.status}`);
  } catch (e) { check('CASE11 setup', false, e.message); }

  const REAC = await call('POST', `/admin/reliability/workers/${worker20Id}/reactivate`, {
    token: adminToken, json: { reason: 'E2E — reactivating after suspension test' },
  });
  check('CASE11 reactivate restores ACTIVE', REAC.data?.data?.accountStatus === 'ACTIVE', JSON.stringify(REAC.data));

  // Positive control: after reactivation worker20 can accept a job.
  B2 = await createBooking(customerToken, { description: 'E2E late-arrival test job' });
  try {
    const acceptOk = await call('POST', `/workers/jobs/${B2._id}/accept`, { token: workerToken });
    check('CASE1 accept succeeds after reactivation', acceptOk.status === 200, `${acceptOk.status} ${JSON.stringify(acceptOk.data)}`);
    if (acceptOk.status !== 200 || !acceptOk.data?.data?.status) {
      await Booking.updateOne({ _id: B2._id }, { $set: { status: 'ACCEPTED', worker: worker20._id, acceptedAt: new Date() } });
      check('CASE1 (fallback) booking force-assigned to worker20', true, '');
    }
  } catch (e) { check('CASE1 accept after reactivation', false, e.message); }

  // ============ CASE 5: late arrival penalty ============
  let s = await score();
  const preLate = s.doc.score;
  try {
    await Booking.updateOne(
      { _id: B2._id },
      { $set: {
        status: 'ACCEPTED', worker: worker20._id, acceptedAt: new Date(),
        scheduledStartTime: new Date(Date.now() - 50 * 60000),
        scheduledEndTime: new Date(Date.now() - 10 * 60000),
        workerCheckInAt: null,
      } }
    );
    const arrived = await call('POST', `/workers/jobs/${B2._id}/arrive`, {
      token: workerToken, json: { coordinates: BOOKING_LOC },
    });
    check('CASE5 arrive endpoint works', arrived.status === 200 && arrived.data?.data?.checkedInAt, `${arrived.status} ${JSON.stringify(arrived.data)}`);
    s = await score();
    check('CASE5 late-arrival penalty −3', s.doc.score === preLate - 3, `expected ${preLate - 3}, got ${s.doc.score}`);
    check('CASE5 lateCount incremented', s.doc.lateCount === 1, `got ${s.doc.lateCount}`);
    check('CASE5 LATE_ARRIVAL event recorded', s.events.some((e) => e.eventType === 'LATE_ARRIVAL' && String(e.booking) === String(B2._id)), '');
    const b2 = await Booking.findById(B2._id).lean();
    check('CASE5 booking status WORKER_ARRIVED + check-in set', b2.status === 'WORKER_ARRIVED' && b2.workerCheckInAt != null, `${b2.status} checkIn=${b2.workerCheckInAt}`);
  } catch (e) { check('CASE5 late arrival', false, e.message); }

  // ============ CASE 6: cancel after accept ============
  let B3;
  s = await score();
  const preCancel = s.doc.score;
  try {
    B3 = await createBooking(customerToken, { description: 'E2E cancel-after-accept test job' });
    await Booking.updateOne({ _id: B3._id }, { $set: { status: 'ACCEPTED', worker: worker20._id, acceptedAt: new Date() } });
    const cancelled = await call('PUT', `/customers/bookings/${B3._id}/cancel`, { token: customerToken, json: { reason: 'E2E — customer cancelled after accept' } });
    check('CASE6 customer can cancel accepted booking', cancelled.status === 200, `${cancelled.status} ${JSON.stringify(cancelled.data)}`);
    s = await score();
    check('CASE6 cancel-after-accept penalty −5', s.doc.score === preCancel - 5, `expected ${preCancel - 5}, got ${s.doc.score}`);
    check('CASE6 cancelledAfterAcceptCount incremented', s.doc.cancelledAfterAcceptCount === 1, `got ${s.doc.cancelledAfterAcceptCount}`);
  } catch (e) { check('CASE6 cancel after accept', false, e.message); }

  // ============ CASE 7: good rating bonus ============
  let B4;
  s = await score();
  const preRating = s.doc.score;
  try {
    B4 = await createBooking(customerToken, { description: 'E2E good-rating test job' });
    await Booking.updateOne({ _id: B4._id }, { $set: { status: 'COMPLETED', worker: worker20._id, completedAt: new Date() } });
    const reviewed = await call('POST', '/reviews/', {
      token: customerToken,
      json: { bookingId: B4._id, reviewType: 'CUSTOMER_TO_WORKER', overallQuality: 5, punctuality: 5, behaviour: 5, pricing: 5, comment: 'Great work!' },
    });
    check('CASE7 review submission', reviewed.status === 201, `${reviewed.status} ${JSON.stringify(reviewed.data)}`);
    s = await score();
    check('CASE7 good-rating bonus +1', s.doc.score === preRating + 1, `expected ${preRating + 1}, got ${s.doc.score}`);
  } catch (e) { check('CASE7 good rating', false, e.message); }

  // ============ CASE 3 + CASE 12: no-show, reassignment, idempotency ============
  let B5;
  s = await score();
  const preNoShow = s.doc.score;
  try {
    B5 = await createBooking(customerToken, { description: 'E2E no-show test job' });
    await Booking.updateOne({ _id: B5._id }, { $set: {
      status: 'ACCEPTED', worker: worker20._id, acceptedAt: new Date(),
      scheduledStartTime: new Date(Date.now() - 50 * 60000),
      scheduledEndTime: new Date(Date.now() - 30 * 60000),
      workerCheckInAt: null,
    } });
    const tick1 = await runSchedulerOnce();
    s = await score();
    check('CASE3 no-show penalty −10', s.doc.score === preNoShow - 10, `expected ${preNoShow - 10}, got ${s.doc.score} | tick=${JSON.stringify(tick1)}`);
    const noShowEv = s.events.find((e) => e.eventType === 'NO_SHOW' && String(e.booking) === String(B5._id));
    check('CASE3 NO_SHOW event present', !!noShowEv, JSON.stringify(s.events));
    check('CASE3 noShowCount incremented', s.doc.noShowCount === 1, `got ${s.doc.noShowCount}`);

    const b5 = await Booking.findById(B5._id).lean();
    check('CASE3 booking no-longer accepted (NO_SHOW/REASSIGNED/EXPIRED)', ['WORKER_NO_SHOW', 'REASSIGNED', 'EXPIRED'].includes(b5.status), b5.status);
    if (b5.status === 'REASSIGNED') {
      check('CASE3 offending worker excluded from replacement candidates', !b5.candidateWorkers.some((c) => c.worker?.toString() === worker20Id), JSON.stringify(b5.candidateWorkers.map((c) => String(c.worker))));
      check('CASE3 reassignmentAttempts incremented', (b5.reassignmentAttempts || 0) >= 1, `${b5.reassignmentAttempts}`);
    } else {
      check('CASE3 expired when no replacement', b5.status === 'EXPIRED', b5.status);
    }

    // Idempotency: re-running the scheduler must not double-penalise.
    await runSchedulerOnce();
    await runSchedulerOnce();
    const evCount = await ReliabilityEvent.countDocuments({ worker: worker20._id, booking: B5._id, eventType: 'NO_SHOW' });
    check('CASE12 scheduler idempotent — no duplicate NO_SHOW', evCount === 1, `count=${evCount}`);
    s = await score();
    check('CASE12 score unchanged after repeated ticks', s.doc.score === preNoShow - 10, `score=${s.doc.score}`);
  } catch (e) { check('CASE3/12 no-show + idempotency', false, e.stack); }

  // ============ CASE 9: appeal approve & reject ============
  try {
    const hist = await call('GET', '/workers/me/reliability/history', { token: workerToken });
    const events = hist.data?.data?.events || [];
    const noShowEv = events.find((e) => e.eventType === 'NO_SHOW' && String(e.booking) === String(B5._id));
    check('CASE9 NO_SHOW event available for appeal', !!noShowEv, JSON.stringify(events.slice(0, 3)));
    if (noShowEv) {
      const appealed = await call('POST', '/workers/me/appeals', {
        token: workerToken,
        json: { eventId: noShowEv._id, reason: 'I reached but could not check in due to network', explanation: 'App testing', evidenceUrls: [] },
      });
      check('CASE9 worker can submit appeal', appealed.status === 201 && appealed.data?.data?.status === 'PENDING', `${appealed.status} ${JSON.stringify(appealed.data)}`);
      const appealId = appealed.data?.data?._id;

      s = await score();
      const preApprove = s.doc.score;
      const approved = await call('POST', `/admin/reliability/appeals/${appealId}/approve`, { token: adminToken, json: { note: 'Approved in E2E' } });
      check('CASE9 admin approves', approved.status === 200, `${approved.status} ${JSON.stringify(approved.data)}`);
      s = await score();
      check('CASE9 appeal approve restores −10', s.doc.score === preApprove + 10, `expected ${preApprove + 10}, got ${s.doc.score}`);
      const gone = await PenaltyAppeal.findById(appealId).lean();
      check('CASE9 appeal marked APPROVED', gone && gone.status === 'APPROVED' && gone.decidedBy, `${gone && gone.status}`);

      // Reject case: use the second cancel-after-accept penalty (B6).
      const B6 = await createBooking(customerToken, { description: 'E2E appeal-reject test job' });
      await Booking.updateOne({ _id: B6._id }, { $set: { status: 'ACCEPTED', worker: worker20._id, acceptedAt: new Date() } });
      await call('PUT', `/customers/bookings/${B6._id}/cancel`, { token: customerToken, json: { reason: 'E2E — second cancel after accept' } });
      s = await score();
      const preReject = s.doc.score;
      const ev = (await call('GET', '/workers/me/reliability/history', { token: workerToken })).data?.data?.events || [];
      const cancelEv = ev.find((e) => e.eventType === 'CANCELLED_AFTER_ACCEPT' && String(e.booking) === String(B6._id));
      check('CASE9 second penalty event found', !!cancelEv, JSON.stringify(ev.slice(0, 3)));
      if (cancelEv) {
        const appeal2 = await call('POST', '/workers/me/appeals', { token: workerToken, json: { eventId: cancelEv._id, reason: 'Customer lied', explanation: 'not my fault' } });
        check('CASE9 second appeal submitted', appeal2.status === 201, `${appeal2.status}`);
        const rejected = await call('POST', `/admin/reliability/appeals/${appeal2.data?.data?._id}/reject`, { token: adminToken, json: { note: 'Rejected in E2E' } });
        check('CASE9 admin rejects', rejected.status === 200, `${rejected.status} ${JSON.stringify(rejected.data)}`);
        s = await score();
        check('CASE9 reject keeps score', s.doc.score === preReject, `score changed ${preReject} -> ${s.doc.score}`);
      }
    }
  } catch (e) { check('CASE9 appeals', false, e.stack); }

  // ============ CASE 10: admin adjustment ============
  try {
    s = await score();
    const preAdj = s.doc.score;
    const adjusted = await call('POST', `/admin/reliability/workers/${worker20Id}/adjust`, {
      token: adminToken, json: { points: -5, reason: 'Pattern of no-shows', adminNote: 'E2E audit test' },
    });
    check('CASE10 admin adjust works', adjusted.status === 200, `${adjusted.status} ${JSON.stringify(adjusted.data)}`);
    s = await score();
    check('CASE10 admin adjustment applied (−5)', s.doc.score === preAdj - 5, `expected ${preAdj - 5}, got ${s.doc.score}`);
    check('CASE10 ADMIN_ADJUSTMENT event audited', s.events.some((e) => e.eventType === 'ADMIN_ADJUSTMENT' && e.adminNote === 'E2E audit test' && e.points === -5), JSON.stringify(s.events[0]));
  } catch (e) { check('CASE10 admin adjust', false, e.message); }

  // ============ CASE: job completion bonus (positive earn path) ============
  try {
    const { getSettings } = require('../src/services/reliability/reliabilityConfig');
    const settings = await getSettings();
    const bonus = settings.points.completeJob;
    s = await score();
    const preDone = s.doc.score;
    const done = await call('POST', `/workers/jobs/${B2._id}/complete`, { token: workerToken, json: {} });
    check('CASE complete job endpoint', done.status === 200, `${done.status} ${JSON.stringify(done.data)}`);
    // completeJob applies fire-and-forget — allow a beat.
    await new Promise((r) => setTimeout(r, 400));
    s = await score();
    check('CASE completion bonus applied', s.doc.score === preDone + bonus, `expected ${preDone + bonus}, got ${s.doc.score}`);
    check('CASE JOB_COMPLETED event (no ON_TIME since late)', s.events.some((e) => e.eventType === 'JOB_COMPLETED') && !s.events.some((e) => e.eventType === 'ON_TIME'), '');
    check('CASE completedCount incremented', s.doc.completedCount === 1, `got ${s.doc.completedCount}`);
  } catch (e) { check('CASE completion bonus', false, e.stack); }

  // ============ CASE 4: job expiry (only after scheduled END time + grace) ============
  try {
    s = await score();
    const preExpiry = s.doc.score;
    const B7 = await createBooking(customerToken, { description: 'E2E expiry test job' });
    const startMs = Date.now() - 4 * 3600 * 1000; // 4h ago
    await Booking.updateOne({ _id: B7._id }, { $set: {
      status: 'MATCHING',
      scheduledStartTime: new Date(startMs),
      scheduledEndTime: new Date(Date.now() - 3 * 3600 * 1000), // ended 3h ago (> 2h grace)
    } });
    await runSchedulerOnce();
    const b7 = await Booking.findById(B7._id).lean();
    check('CASE4 stale booking expired', b7.status === 'EXPIRED' && b7.expiredAt, `${b7.status}`);
    s = await score();
    check('CASE4 expiry does not penalise worker', s.doc.score === preExpiry, `score ${preExpiry} -> ${s.doc.score}`);

    // CASE 4b: a job whose scheduled END is still in the future must NOT expire.
    const B7b = await createBooking(customerToken, { description: 'E2E no-expire-yet test job' });
    await Booking.updateOne({ _id: B7b._id }, { $set: {
      status: 'MATCHING',
      scheduledStartTime: new Date(Date.now() - 3 * 3600 * 1000), // started 3h ago
      scheduledEndTime: new Date(Date.now() + 2 * 3600 * 1000),  // ends in 2h — must stay open
    } });
    await runSchedulerOnce();
    const b7b = await Booking.findById(B7b._id).lean();
    check('CASE4b future-ending job NOT expired', b7b.status === 'MATCHING', `${b7b.status}`);
  } catch (e) { check('CASE4 expiry', false, e.message); }

  // ============ CASE 13: collaboration no-show + stale-open expiry ============
  let B9, CR1, CR2;
  try {
    const settings = await getSettings();
    const collabPenalty = settings.points.collabNoShow;

    // A booking to hang the collaboration on.
    B9 = await createBooking(customerToken, { description: 'E2E collab no-show test job' });

    // Lead worker (synthetic id) + offending collaborator (worker20).
    const leadWorker = new mongoose.Types.ObjectId();
    const pastDate = new Date(Date.now() - 2 * 86400000); // two days ago

    CR1 = await CollaborationRequest.create({
      booking: B9._id,
      leadWorker,
      role: 'Helper',
      numberOfCollaborators: 1,
      date: pastDate,
      startTime: '09:00',
      durationHours: 4,
      status: 'FILLED',
      candidates: [{ worker: worker20Id, score: 90, reasons: ['test'], status: 'ACCEPTED', respondedAt: pastDate }],
    });
    await JobTeam.create({
      booking: B9._id,
      leadWorker,
      collaborationRequest: CR1._id,
      members: [
        { worker: worker20Id, role: 'Helper', status: 'ACCEPTED', paymentEstimate: 100, invitedAt: pastDate, acceptedAt: pastDate, joinedAt: null },
      ],
    });

    s = await score();
    const preNoShowC = s.doc.score;

    await runSchedulerOnce();

    const teamAfter = await JobTeam.findOne({ booking: B9._id }).lean();
    const memb = (teamAfter.members || []).find((m) => m.worker.toString() === worker20Id);
    check('CASE13 collaborator marked NO_SHOW', memb && memb.status === 'NO_SHOW', JSON.stringify(memb));

    s = await score();
    check('CASE13 collaboration no-show penalty', s.doc.score === preNoShowC + collabPenalty, `expected ${preNoShowC + collabPenalty}, got ${s.doc.score} | ev=${JSON.stringify(s.events[0])}`);
    check('CASE13 COLLAB_NO_SHOW event recorded', s.events.some((e) => e.eventType === 'COLLAB_NO_SHOW' && String(e.booking) === String(B9._id)), '');
    check('CASE13 collabNoShowCount incremented', s.doc.collabNoShowCount === 1, `got ${s.doc.collabNoShowCount}`);

    // Idempotency: repeated ticks must not re-penalise.
    await runSchedulerOnce();
    await runSchedulerOnce();
    const evCount = await ReliabilityEvent.countDocuments({ worker: worker20Id, booking: B9._id, eventType: 'COLLAB_NO_SHOW' });
    check('CASE13 collab no-show idempotent (no duplicate)', evCount === 1, `count=${evCount}`);

    // Stale OPEN invitation far past its date should be expired + pending declined.
    CR2 = await CollaborationRequest.create({
      booking: B9._id,
      leadWorker,
      role: 'Helper',
      numberOfCollaborators: 2,
      date: new Date(Date.now() - 5 * 86400000),
      startTime: '09:00',
      durationHours: 4,
      status: 'OPEN',
      candidates: [
        { worker: worker20Id, score: 90, reasons: ['test'], status: 'PENDING' },
      ],
    });
    await runSchedulerOnce();
    const cr2 = await CollaborationRequest.findById(CR2._id).lean();
    check('CASE13 stale OPEN invitation expired', cr2.status === 'EXPIRED' && cr2.candidates[0].status === 'DECLINED', `${cr2.status} / ${cr2.candidates[0].status}`);

    // Hygiene: drop the synthetic collaboration docs + booking.
    await JobTeam.deleteMany({ booking: B9._id });
    await CollaborationRequest.deleteMany({ booking: B9._id });
    await Booking.deleteMany({ _id: B9._id });
  } catch (e) { check('CASE13 collaboration no-show', false, e.stack); }

  // ============ CASE 14: every-5-jobs milestone reward (+jobMilestoneBonus) ============
  let B10;
  try {
    const settings = await getSettings();
    const bonus = settings.points.jobMilestoneBonus;
    const WorkerReliability = require('../src/models/WorkerReliability');
    s = await score();
    const preM = s.doc.score;
    // Bump completedCount to 4 so the next completion crosses the 5th milestone.
    await WorkerReliability.updateOne({ worker: worker20Id }, { $set: { completedCount: 4 } });

    B10 = await createBooking(customerToken, { description: 'E2E job milestone test job' });
    await Booking.updateOne({ _id: B10._id }, { $set: {
      status: 'IN_PROGRESS', worker: worker20Id, acceptedAt: new Date(),
      scheduledStartTime: new Date(Date.now() - 5 * 3600 * 1000),
      scheduledEndTime: new Date(Date.now() - 4 * 3600 * 1000), // in past → not on-time
    } });
    const done = await call('POST', `/workers/jobs/${B10._id}/complete`, { token: workerToken, json: {} });
    check('CASE14 complete 5th job endpoint', done.status === 200, `${done.status}`);
    await new Promise((r) => setTimeout(r, 500));

    s = await score();
    check('CASE14 every-5-jobs milestone bonus', s.doc.completedCount === 5 && s.events.some((e) => e.eventType === 'MILESTONE_JOBS_COMPLETED' && e.points === bonus), `count=${s.doc.completedCount} ev=${JSON.stringify(s.events[0])}`);
    check('CASE14 milestone not double-counted', s.events.filter((e) => e.eventType === 'MILESTONE_JOBS_COMPLETED').length === 1, '');
    check('CASE14 milestone applied to score', s.doc.score === preM + bonus + settings.points.completeJob, `expected ${preM + bonus + settings.points.completeJob}, got ${s.doc.score}`);
  } catch (e) { check('CASE14 job milestone', false, e.stack); }

  // ============ CASE 15: every-5-collaborations milestone reward (+collabMilestoneBonus) ============
  let B11;
  try {
    const settings = await getSettings();
    const bonus = settings.points.collabMilestoneBonus;

    // CollaborationsCount 4 → next completed collaboration crosses the 5th milestone.
    await Worker.updateOne({ _id: worker20Id }, { $set: { collaborationsCount: 4 } });
    s = await score();
    const preCollab = s.doc.score;

    B11 = await createBooking(customerToken, { description: 'E2E collab milestone test job' });
    const CR3 = await CollaborationRequest.create({
      booking: B11._id, leadWorker: new mongoose.Types.ObjectId(), role: 'Helper',
      numberOfCollaborators: 1, date: new Date(Date.now() - 1 * 86400000), startTime: '09:00', durationHours: 4,
      status: 'FILLED', candidates: [{ worker: worker20Id, status: 'ACCEPTED', score: 90, reasons: ['test'] }],
    });
    await JobTeam.create({
      booking: B11._id, leadWorker: new mongoose.Types.ObjectId(), collaborationRequest: CR3._id,
      members: [{ worker: worker20Id, role: 'Helper', status: 'ACCEPTED', invitedAt: new Date(), acceptedAt: new Date() }],
    });

    const { completeTeam } = require('../src/services/collaborator/teamFormationService');
    await completeTeam(B11._id);
    await new Promise((r) => setTimeout(r, 400));

    s = await score();
    const w20 = await Worker.findById(worker20Id).select('collaborationsCount').lean();
    check('CASE15 every-5-collabs milestone bonus', w20.collaborationsCount === 5 && s.events.some((e) => e.eventType === 'MILESTONE_COLLABS_COMPLETED' && e.points === bonus), `collabCount=${w20.collaborationsCount} ev=${JSON.stringify(s.events[0])}`);
    check('CASE15 collab milestone applied to score', s.doc.score === preCollab + bonus, `expected ${preCollab + bonus}, got ${s.doc.score}`);

    await JobTeam.deleteMany({ booking: B11._id });
    await CollaborationRequest.deleteMany({ booking: B11._id });
    await Booking.deleteMany({ _id: B11._id });
  } catch (e) { check('CASE15 collab milestone', false, e.stack); }

  // ============ summary ============
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  results.filter((r) => !r.ok).forEach((r) => console.log('  FAILED:', r.name, '->', r.extra));

  // cleanup: cancel synthetic open bookings that still have no worker
  for (const b of [B1, B8]) {
    if (!b) continue;
    const fresh = await Booking.findById(b._id).lean();
    if (fresh && !fresh.worker && ['REQUESTED', 'MATCHING', 'ASSIGNED'].includes(fresh.status)) {
      await call('PUT', `/customers/bookings/${fresh._id}/cancel`, { token: customerToken, json: { reason: 'E2E cleanup' } });
    }
  }

  await mongoose.disconnect();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e.stack || e);
  process.exit(1);
});