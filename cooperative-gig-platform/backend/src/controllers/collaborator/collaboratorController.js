const Booking = require('../../models/Booking');
const Worker = require('../../models/WorkerProfile');
const CollaborationRequest = require('../../models/CollaborationRequest');
const JobTeam = require('../../models/JobTeam');
const WorkerAvailability = require('../../models/WorkerAvailability');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const {
  findCollaboratorCandidates,
  evaluateWorkerForRequest,
} = require('../../services/collaborator/collaboratorMatchingService');
const teamFormationService = require('../../services/collaborator/teamFormationService');
const {
  notifyCandidates,
  notifyLeadWorker,
  notifyAcceptedConfirmation,
} = require('../../services/collaborator/collaboratorNotificationService');

const getWorkerId = async (userId) => {
  const worker = await Worker.findOne({ user: userId });
  return worker ? worker._id : null;
};

const populateUser = (path) => ({
  path,
  populate: { path: 'user', select: 'name email phone avatar role' },
});

// -------------------- Create --------------------

const createCollaborationRequest = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) throw new ApiError('Worker profile not found', 404);

  const { bookingId, role, requiredSkills, requiredSkillIds, numberOfCollaborators, date, startTime, durationHours, address, city, estimatedPayment, instructions } = req.body;

  if (!bookingId) throw new ApiError('bookingId is required', 400);
  if (!role) throw new ApiError('Collaborator role is required', 400);
  const count = Number(numberOfCollaborators) || 1;
  if (count < 1 || count > 10) throw new ApiError('numberOfCollaborators must be between 1 and 10', 400);
  if (!date) throw new ApiError('Collaboration date is required', 400);

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);

  // Only the assigned lead worker may build a team for this job.
  const assigned = booking.worker ? booking.worker.toString() : null;
  if (!assigned || assigned !== workerId.toString()) {
    throw new ApiError('Only the lead worker assigned to this job can request collaborators', 403);
  }
  if (!['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'STARTED'].includes(booking.status)) {
    throw new ApiError('Collaboration is only possible for an active job', 400);
  }

  const location = booking.location && booking.location.coordinates
    ? booking.location.coordinates
    : [78.4867, 17.385];

  const payload = {
    role,
    requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [],
    requiredSkillIds: Array.isArray(requiredSkillIds) ? requiredSkillIds : [],
    numberOfCollaborators: count,
    date: new Date(date),
    location,
    leadWorkerId: workerId,
    excludeWorkerIds: [workerId],
  };

  const candidates = await findCollaboratorCandidates(payload, Math.max(count + 5, 10));

  const request = await CollaborationRequest.create({
    booking: booking._id,
    leadWorker: workerId,
    role,
    requiredSkills: payload.requiredSkills,
    requiredSkillIds: payload.requiredSkillIds,
    numberOfCollaborators: count,
    date: payload.date,
    startTime: startTime || '09:00',
    durationHours: Number(durationHours) || 4,
    location: { type: 'Point', coordinates: location },
    address: address || booking.address || '',
    city: city || booking.city || 'Hyderabad',
    estimatedPayment: Number(estimatedPayment) || 0,
    instructions: instructions || '',
    status: 'OPEN',
    candidates: candidates.map((c) => ({
      worker: c.worker,
      score: c.score,
      reasons: c.reasons,
      status: 'PENDING',
    })),
  });

  notifyCandidates(request, candidates);

  res.status(201).json({
    success: true,
    message: `Matched ${candidates.length} verified worker(s) for ${role} collaboration`,
    data: { request, candidates },
  });
});

// -------------------- Read --------------------

const getCollaborationRequest = asyncHandler(async (req, res) => {
  const request = await CollaborationRequest.findById(req.params.id)
    .populate('booking')
    .populate(populateUser('leadWorker'))
    .populate(populateUser('candidates.worker'));

  if (!request) throw new ApiError('Collaboration request not found', 404);

  const workerId = await getWorkerId(req.user._id);
  const isLead = request.leadWorker._id.toString() === (workerId ? workerId.toString() : '');
  const isCandidate = request.candidates.some((c) => c.worker._id.toString() === (workerId ? workerId.toString() : ''));

  if (req.user.role !== 'admin' && !isLead && !isCandidate) {
    throw new ApiError('Not authorized to view this collaboration request', 403);
  }

  res.json({ success: true, data: request });
});

const getRequestsForBooking = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const workerId = await getWorkerId(req.user._id);
  const requests = await CollaborationRequest.find({ booking: bookingId })
    .populate(populateUser('leadWorker'))
    .populate(populateUser('candidates.worker'));
  if (req.user.role !== 'admin') {
    const mine = requests.filter(
      (r) => r.leadWorker._id.toString() === (workerId ? workerId.toString() : '')
    );
    return res.json({ success: true, data: mine });
  }
  res.json({ success: true, data: requests });
});

// Collaboration requests sent by the lead worker (so the lead can see who accepted)
const getMySentRequests = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) return res.json({ success: true, data: [] });

  const requests = await CollaborationRequest.find({ leadWorker: workerId })
    .populate('booking')
    .populate(populateUser('leadWorker'))
    .populate(populateUser('candidates.worker'))
    .sort({ createdAt: -1 });

  res.json({ success: true, data: requests });
});

// Incoming collaboration opportunities for a worker
const getMyCollaborationRequests = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) return res.json({ success: true, data: [] });

  // Requests the worker was invited into by matching at create-time.
  const invited = await CollaborationRequest.find({
    'candidates.worker': workerId,
    status: { $in: ['OPEN'] },
  })
    .populate('booking')
    .populate(populateUser('leadWorker'))
    .populate('candidates.worker', 'user rating ratingCount collaborationsCount')
    .sort({ createdAt: -1 });

  // PLUS any OPEN request near this worker that they are eligible for, even
  // when the lead's original candidate snapshot missed them (e.g. 0-candidate
  // requests). Eligibility uses the exact same role/skill/location rules as
  // candidate matching so no invisible collaboration requests remain.
  const worker = await Worker.findById(workerId);
  const nearbyOpen = await CollaborationRequest.find({
    status: 'OPEN',
    leadWorker: { $ne: workerId },
    'candidates.worker': { $ne: workerId },
  })
    .populate('booking')
    .populate(populateUser('leadWorker'))
    .populate('candidates.worker', 'user rating ratingCount collaborationsCount')
    .sort({ createdAt: -1 });

  const merged = [...invited];
  const evalByRequest = new Map();
  for (const r of nearbyOpen) {
    if (invited.some((i) => i._id.toString() === r._id.toString())) continue;
    const evalResult = await evaluateWorkerForRequest(worker, r);
    if (evalResult.eligible) {
      merged.push(r);
      evalByRequest.set(r._id.toString(), evalResult);
    }
  }

  // A collaboration request is only live while its job can actually happen.
  // Requests linked to a cancelled/expired/completed/no-shown booking must not
  // keep appearing in the Opportunities feed.
  const ACTIVE_BOOKING_STATUSES = ['REQUESTED', 'MATCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'];
  const liveMerged = merged.filter((r) => {
    if (!r.booking) return true;
    return ACTIVE_BOOKING_STATUSES.includes(r.booking.status);
  });

  const enriched = await Promise.all(
    liveMerged.map(async (r) => {
      const mySlot = (r.candidates || []).find((c) => c.worker._id.toString() === workerId.toString());
      const evalResult = evalByRequest.get(r._id.toString());
      const lead = await Worker.findById(r.leadWorker ? r.leadWorker._id : null).populate('user', 'name email phone');
      return {
        ...r.toObject(),
        myStatus: mySlot ? mySlot.status : null,
        myScore: mySlot ? mySlot.score : evalResult ? evalResult.score : null,
        myReasons: mySlot ? mySlot.reasons : evalResult ? evalResult.reasons : [],
        lead: lead,
      };
    })
  );

  res.json({ success: true, data: enriched });
});

// -------------------- Respond --------------------

const respondCollaborationRequest = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) throw new ApiError('Worker profile not found', 404);

  const { action } = req.body;
  if (!['ACCEPT', 'DECLINE'].includes(action)) {
    throw new ApiError('action must be ACCEPT or DECLINE', 400);
  }

  const request = await CollaborationRequest.findById(req.params.id);
  if (!request) throw new ApiError('Collaboration request not found', 404);
  if (request.leadWorker.toString() === workerId.toString()) {
    throw new ApiError('Lead worker cannot accept their own request', 400);
  }

  let result;
  if (action === 'ACCEPT') {
    result = await teamFormationService.acceptCollaborator(request._id, workerId);
    if (!result.ok) throw new ApiError(result.error, 400);
    const team = await teamFormationService.getTeamForRequest(request._id);
    notifyLeadWorker(result.request, `${req.user.name} accepted the ${request.role} collaboration!`, team);
    notifyAcceptedConfirmation(workerId, { requestId: request._id, role: request.role, status: 'ACCEPTED' });
    // Reliability merit: collaboration participation earns the helper points.
    if (request.booking) {
      require('../../services/reliability/reliabilityService')
        .handleCollaboration(workerId, request.booking)
        .catch((e) => console.error('[reliability] collaboration bonus error:', e.message));
    }
    res.json({ success: true, message: result.full ? 'Team is now full!' : 'Collaboration accepted. See you on the job!', data: { request: result.request, team } });
  } else {
    result = await teamFormationService.declineCollaborator(request._id, workerId);
    if (!result.ok) throw new ApiError(result.error, 400);
    notifyLeadWorker(result.request, `${req.user.name} declined the ${request.role} collaboration.`);
    res.json({ success: true, message: 'Collaboration declined', data: { request: result.request } });
  }
});

const cancelCollaborationRequest = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) throw new ApiError('Worker profile not found', 404);

  const result = await teamFormationService.cancelTeam(req.params.id, workerId);
  if (!result.ok) throw new ApiError(result.error, 400);

  res.json({ success: true, message: 'Collaboration request cancelled', data: { request: result.request } });
});

// -------------------- Team --------------------

// Helper-side: acceptance list + component, so collaborators see "where I'm working".
async function enrichOwnTeamJob(team, workerId) {
  const [lead, customer] = await Promise.all([
    Worker.findById(team.leadWorker).populate('user', 'name email phone avatar'),
    Booking.findById(team.booking).populate('customer', 'name phone').populate('service', 'name'),
  ]);
  const request = team.collaborationRequest
    ? await CollaborationRequest.findById(team.collaborationRequest)
    : null;
  const my = (team.members || []).find((m) => m.worker.toString() === workerId.toString());
  return {
    teamId: team._id,
    myStatus: my ? my.status : null,
    myRole: my ? my.role : null,
    paymentEstimate: my ? my.paymentEstimate : 0,
    paidAmount: my ? my.paidAmount || 0 : 0,
    paymentPaidAt: my ? my.paymentPaidAt || null : null,
    paid:
      (my && my.paymentEstimate > 0 && (my.paidAmount || 0) >= my.paymentEstimate) ||
      false,
    joinedAt: my ? my.joinedAt : null,
    completed: team.completed,
    booking: customer
      ? {
          bookingNumber: customer.bookingNumber,
          service: customer.service ? customer.service.name : customer.serviceSnapshot?.name,
          status: customer.status,
          address: customer.address,
          city: customer.city,
          location: customer.location,
          customer: { name: customer.customer?.name, phone: customer.customer?.phone },
          requestedDate: customer.requestedDate,
          priceBreakdown: customer.priceBreakdown,
        }
      : null,
    lead: lead
      ? { name: lead.user?.name, phone: lead.user?.phone, rating: lead.rating }
      : null,
    schedule: request
      ? {
          date: request.date,
          startTime: request.startTime,
          durationHours: request.durationHours,
          instructions: request.instructions,
        }
      : null,
  };
}

const getMyTeamJobs = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) return res.json({ success: true, data: [] });

  const teams = await JobTeam.find({
    'members.worker': workerId,
    'members.status': { $in: ['ACCEPTED', 'COMPLETED'] },
  }).sort({ updatedAt: -1 });

  const data = await Promise.all(teams.map((t) => enrichOwnTeamJob(t, workerId)));
  res.json({ success: true, data });
});

// Collaborator marks themselves as on-the-way / arrived for an accepted collaboration.
const checkInToTeam = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) throw new ApiError('Worker profile not found', 404);

  const team = await JobTeam.findById(req.params.id);
  if (!team) throw new ApiError('Team not found', 404);

  const member = (team.members || []).find((m) => m.worker.toString() === workerId.toString());
  if (!member) throw new ApiError('You are not a member of this team', 403);
  if (member.status !== 'ACCEPTED') throw new ApiError('Only accepted collaborators can check in', 400);
  if (!member.joinedAt) member.joinedAt = new Date();
  await team.save();

  notifyLeadWorker(
    {
      _id: team.collaborationRequest,
      booking: team.booking,
      status: 'OPEN',
      role: member.role,
      leadWorker: team.leadWorker,
    },
    `${req.user.name} is on the way!`,
    team
  );

  res.json({ success: true, message: 'Checked in — stay safe, see you on the job!', data: await enrichOwnTeamJob(team, workerId) });
});

const getJobTeam = asyncHandler(async (req, res) => {
  const bookingId = req.params.bookingId;
  if (!bookingId) throw new ApiError('bookingId is required', 400);

  const workerId = await getWorkerId(req.user._id);
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ApiError('Booking not found', 404);

  if (req.user.role !== 'admin') {
    const isLead = booking.worker && booking.worker.toString() === (workerId ? workerId.toString() : '');
    if (!isLead) throw new ApiError('Only the lead worker can view this team', 403);
  }

  let team = await teamFormationService.getTeamForBooking(bookingId);
  if (!team) {
    return res.json({ success: true, data: null });
  }

  // team.members[].worker / team.leadWorker are populated objects the second
  // time a route is hit, so normalize to ids before re-lookup.
  const idOf = (v) => (v && v._id ? v._id : v);

  // enrich member workers + lead
  const workerDocs = await Worker.find({
    _id: {
      $in: [
        ...team.members.map((m) => idOf(m.worker)),
        idOf(team.leadWorker),
      ].filter(Boolean),
    },
  }).populate('user', 'name email phone avatar');

  const byId = (id) => workerDocs.find((w) => w._id.toString() === idOf(id).toString());
  const payload = {
    ...team.toObject(),
    leadWorker: idOf(team.leadWorker),
    lead: byId(team.leadWorker) ? { user: byId(team.leadWorker).user, rating: byId(team.leadWorker).rating } : null,
    members: team.members.map((m) => ({
      ...m.toObject(),
      worker: idOf(m.worker),
      workerProfile: byId(m.worker) ? { user: byId(m.worker).user, rating: byId(m.worker).rating, collaborationsCount: byId(m.worker).collaborationsCount } : null,
    })),
  };

  res.json({ success: true, data: payload });
});

// -------------------- Helper payments --------------------

// Lead worker's completed jobs with outstanding/completed helper payments.
const getPayableTeams = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) return res.json({ success: true, data: [] });

  const teams = await JobTeam.find({ leadWorker: workerId, completed: true })
    .sort({ updatedAt: -1 })
    .limit(30);

  if (!teams.length) return res.json({ success: true, data: [] });

  const bookings = await Booking.find({ _id: { $in: teams.map((t) => t.booking) } })
    .select('status bookingNumber serviceSnapshot city address completedAt')
    .lean();

  const workerIds = new Set();
  teams.forEach((t) => t.members.forEach((m) => workerIds.add(String(m.worker))));
  const workerDocs = await Worker.find({ _id: { $in: [...workerIds] } })
    .populate('user', 'name email phone')
    .lean();
  const workerName = (id) => {
    const w = workerDocs.find((x) => String(x._id) === String(id));
    return w && w.user ? w.user.name : 'Team member';
  };

  const data = teams
    .map((team) => {
      const booking = bookings.find((b) => String(b._id) === String(team.booking));
      if (!booking || booking.status !== 'COMPLETED') return null;
      const members = team.members
        .filter((m) => m.status === 'COMPLETED')
        .map((m) => ({
          memberId: m._id,
          workerId: m.worker,
          workerName: workerName(m.worker),
          role: m.role,
          paymentEstimate: m.paymentEstimate,
          paidAmount: m.paidAmount || 0,
          paymentPaidAt: m.paymentPaidAt || null,
          paid: m.paymentEstimate > 0 && (m.paidAmount || 0) >= m.paymentEstimate,
          remaining: Math.round(((m.paymentEstimate || 0) - (m.paidAmount || 0)) * 100) / 100,
        }));
      return {
        teamId: team._id,
        booking: {
          bookingNumber: booking.bookingNumber,
          service: booking.serviceSnapshot?.name,
          city: booking.city,
          address: booking.address,
          completedAt: booking.completedAt || team.updatedAt,
        },
        members,
      };
    })
    .filter(Boolean);

  res.json({ success: true, data });
});

// Lead worker pays a completed team member for a completed job.
const payTeamMember = asyncHandler(async (req, res) => {
  const workerId = await getWorkerId(req.user._id);
  if (!workerId) throw new ApiError('Worker profile not found', 404);

  const { memberId, amount } = req.body || {};
  if (!memberId) throw new ApiError('memberId is required', 400);

  const result = await teamFormationService.payCollaborator({
    teamId: req.params.id,
    leadWorkerId: workerId,
    memberId,
    amount,
  });
  if (!result.ok) throw new ApiError(result.error, 400);

  res.json({
    success: true,
    message: 'Helper paid',
    data: { paidNow: result.paidNow, team: result.affected },
  });
});

// -------------------- Collaborator profile --------------------

const getCollaboratorProfile = asyncHandler(async (req, res) => {
  const workerId = req.params.workerId || (await getWorkerId(req.user._id));
  if (!workerId) throw new ApiError('Worker not found', 404);

  const worker = await Worker.findById(workerId).populate('user', 'name email phone avatar');
  if (!worker) throw new ApiError('Worker not found', 404);

  const [availability, activeJobs] = await Promise.all([
    WorkerAvailability.find({ worker: worker._id }).select('dayOfWeek startTime endTime date isAvailable availabilityType'),
    Booking.countDocuments({
      worker: worker._id,
      status: { $in: ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'STARTED'] },
    }),
  ]);

  res.json({
    success: true,
    data: {
      workerId: worker._id,
      user: worker.user,
      rating: worker.rating,
      ratingCount: worker.ratingCount,
      completedJobs: worker.completedJobs,
      collaborationsCount: worker.collaborationsCount,
      collaborationRating: worker.collaborationRating,
      punctuality: worker.punctuality,
      reliability: worker.reliability,
      verificationStatus: worker.verificationStatus,
      skills: (worker.skills || []).map((s) => ({ name: s.name, yearsOfExperience: s.yearsOfExperience })),
      experienceYears: worker.experienceYears,
      languages: worker.languages,
      serviceAreaRadiusKm: worker.serviceAreaRadiusKm,
      location: worker.location,
      address: worker.address,
      city: worker.city,
      availability: availability.map((a) => ({ dayOfWeek: a.dayOfWeek, startTime: a.startTime, endTime: a.endTime, isAvailable: a.isAvailable })),
      currentWorkload: activeJobs,
    },
  });
});

module.exports = {
  createCollaborationRequest,
  getCollaborationRequest,
  getRequestsForBooking,
  getMySentRequests,
  getMyCollaborationRequests,
  respondCollaborationRequest,
  cancelCollaborationRequest,
  getJobTeam,
  getMyTeamJobs,
  checkInToTeam,
  getPayableTeams,
  payTeamMember,
  getCollaboratorProfile,
};