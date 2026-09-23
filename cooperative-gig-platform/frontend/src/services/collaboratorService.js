import api from './api';

// Requests
export const createCollaborationRequest = (payload) => api.post('/collaborations/requests', payload);
export const getMyCollaborationRequests = () => api.get('/collaborations/requests/mine');
export const getCollaborationRequest = (id) => api.get(`/collaborations/requests/${id}`);
export const getRequestsForBooking = (bookingId) => api.get(`/collaborations/requests/booking/${bookingId}`);

// Responding
export const respondCollaborationRequest = (id, action) => api.post(`/collaborations/requests/${id}/respond`, { action });
export const cancelCollaborationRequest = (id) => api.put(`/collaborations/requests/${id}/cancel`);

// Teams
export const getJobTeam = (bookingId) => api.get(`/collaborations/teams/booking/${bookingId}`);
export const getMyTeamJobs = () => api.get('/collaborations/teams/mine');
export const checkInToTeam = (teamId) => api.post(`/collaborations/teams/${teamId}/checkin`);

// Helper payments (lead worker → completed team member)
export const getPayableTeams = () => api.get('/collaborations/teams/payable');
export const payTeamMember = (teamId, memberId, amount) =>
  api.post(`/collaborations/teams/${teamId}/pay`, { memberId, amount });

// Profiles
export const getCollaboratorProfile = (workerId) =>
  api.get(workerId ? `/collaborations/profile/${workerId}` : '/collaborations/profile');