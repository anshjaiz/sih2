/**
 * Dynamic team formation service.
 *
 * Turns accepted collaborators into a JobTeam for a booking:
 *  - one team per booking (lead worker + collaborators)
 *  - tracks invitation and acceptance lifecycle
 *  - finalizes the team when all slots are accepted
 *  - credits completed collaborations back to worker profiles
 */

const JobTeam = require('../../models/JobTeam');
const CollaborationRequest = require('../../models/CollaborationRequest');
const Worker = require('../../models/WorkerProfile');

const getTeamForBooking = async (bookingId) =>
  JobTeam.findOne({ booking: bookingId }).populate('members.worker', 'user rating ratingCount collaborationsCount skills').populate('leadWorker', 'user');

const getTeamForRequest = async (requestId) =>
  JobTeam.findOne({ collaborationRequest: requestId }).populate('members.worker', 'user rating ratingCount collaborationsCount skills');

/**
 * Create (or return) the team document for a collaboration request.
 */
const ensureTeam = async ({ booking, leadWorker, collaborationRequest, role, estimatedPayment }) => {
  let team = await JobTeam.findOne({ booking });
  if (!team) {
    team = await JobTeam.create({
      booking,
      leadWorker,
      collaborationRequest,
      members: [],
    });
  }
  if (!team.collaborationRequest) team.collaborationRequest = collaborationRequest;
  return team;
};

const slotStateOf = async (request) => {
  const accepted = (request.candidates || []).filter((c) => c.status === 'ACCEPTED').length;
  return {
    accepted,
    needed: request.numberOfCollaborators,
    full: accepted >= request.numberOfCollaborators,
  };
};

/**
 * Candidate worker accepts a collaboration invitation.
 *
 * A worker who discovers an OPEN request through the Opportunities feed (and is
 * verified + nearby + role/skill eligible) can join even if the lead's original
 * candidate snapshot missed them — they are added to the candidate list on the
 * fly with their computed match score.
 */
const acceptCollaborator = async (requestId, workerId) => {
  const request = await CollaborationRequest.findById(requestId);
  if (!request || request.status !== 'OPEN') {
    return { ok: false, error: 'This collaboration request is no longer open' };
  }

  const slot = request.candidates.find(
    (c) => c.worker.toString() === workerId.toString() && c.status === 'PENDING'
  );

  if (!slot) {
    const worker = await Worker.findById(workerId);
    const evalResult = await require('./collaboratorMatchingService').evaluateWorkerForRequest(worker, request);
    if (!evalResult.eligible) {
      return { ok: false, error: 'You were not invited to this collaboration' };
    }
    request.candidates.push({
      worker: workerId,
      score: evalResult.score || 0,
      reasons: evalResult.reasons || [],
      status: 'PENDING',
    });
    await request.save();
  }

  const currentSlot = request.candidates.find(
    (c) => c.worker.toString() === workerId.toString() && c.status === 'PENDING'
  );
  if (!currentSlot) return { ok: false, error: 'You were not invited to this collaboration' };

  // Guard against double-accept while another request is in flight
  const already = request.candidates.find(
    (c) => c.worker.toString() === workerId.toString() && c.status === 'ACCEPTED'
  );
  if (already) return { ok: false, error: 'Already accepted this collaboration' };

  const { full } = await slotStateOf(request);

  currentSlot.status = 'ACCEPTED';
  currentSlot.respondedAt = new Date();

  // Enroll as a team member
  await ensureTeam({
    booking: request.booking,
    leadWorker: request.leadWorker,
    collaborationRequest: request._id,
    role: request.role,
    estimatedPayment: request.estimatedPayment,
  });
  const team = await JobTeam.findOne({ booking: request.booking });
  const existing = team.members.find((m) => m.worker.toString() === workerId.toString());
  if (existing) {
    existing.status = 'ACCEPTED';
    existing.acceptedAt = new Date();
  } else {
    team.members.push({
      worker: workerId,
      role: request.role,
      status: 'ACCEPTED',
      paymentEstimate: request.estimatedPayment,
      invitedAt: new Date(),
      acceptedAt: new Date(),
    });
  }
  await team.save();

  // Mark request FILLED once all target slots are accepted
  const after = await slotStateOf(request);
  if (after.full) request.status = 'FILLED';
  await request.save();

  return { ok: true, full: after.full, request, team };
};

/**
 * Candidate worker declines a collaboration invitation.
 */
const declineCollaborator = async (requestId, workerId) => {
  const request = await CollaborationRequest.findById(requestId);
  if (!request) return { ok: false, error: 'Request not found' };

  const slot = request.candidates.find(
    (c) => c.worker.toString() === workerId.toString() && c.status === 'PENDING'
  );
  if (!slot) return { ok: false, error: 'No pending invitation found' };

  slot.status = 'DECLINED';
  slot.respondedAt = new Date();
  await request.save();

  const team = await JobTeam.findOne({ booking: request.booking });
  if (team) {
    const member = team.members.find((m) => m.worker.toString() === workerId.toString());
    if (member) member.status = 'DECLINED';
    await team.save();
  }

  return { ok: true, request };
};

/**
 * Lead worker cancels the collaboration request (and its team).
 */
const cancelTeam = async (requestId, leadWorkerId) => {
  const request = await CollaborationRequest.findById(requestId);
  if (!request) return { ok: false, error: 'Request not found' };
  if (request.leadWorker.toString() !== leadWorkerId.toString()) {
    return { ok: false, error: 'Only the lead worker can cancel this request' };
  }
  if (request.status === 'FILLED') {
    return { ok: false, error: 'Team already finalized' };
  }
  request.status = 'CANCELLED';
  request.candidates.forEach((c) => {
    if (c.status === 'PENDING') c.status = 'DECLINED';
    c.respondedAt = new Date();
  });
  await request.save();

  await JobTeam.deleteMany({ booking: request.booking });
  return { ok: true, request };
};

/**
 * When the booking is completed, credit all accepted collaborators.
 */
const completeTeam = async (bookingId) => {
  const team = await JobTeam.findOne({ booking: bookingId });
  if (!team) return null;

  team.completed = true;
  const memberWorkerIds = team.members
    .filter((m) => m.status === 'ACCEPTED')
    .map((m) => m.worker);

  team.members.forEach((m) => {
    if (m.status === 'ACCEPTED') m.status = 'COMPLETED';
  });
  await team.save();

  if (memberWorkerIds.length) {
    await Worker.updateMany(
      { _id: { $in: memberWorkerIds } },
      { $inc: { collaborationsCount: 1 } }
    );
    // Milestone reward: every 5 completed collaborations → +collabMilestoneBonus.
    for (const id of memberWorkerIds) {
      require('../../services/reliability/reliabilityService')
        .handleCollaborationCompleted(id, bookingId)
        .catch((e) => console.error('[reliability] collab milestone error:', e.message));
    }
  }
  return team;
};

module.exports = {
  getTeamForBooking,
  getTeamForRequest,
  ensureTeam,
  acceptCollaborator,
  declineCollaborator,
  cancelTeam,
  completeTeam,
  slotStateOf,
};