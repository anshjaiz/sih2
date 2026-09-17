const express = require('express');
const router = express.Router();
const {
  getOwnProfile,
  updateOwnProfile,
  addSkill,
  removeSkill,
  uploadCertificate,
  getCertificates,
  setAvailability,
  getAvailability,
} = require('../controllers/worker/workerProfileController');
const {
  getWorkerDashboard,
  getJobRequests,
  acceptJob,
  rejectJob,
  getActiveJobs,
  startJob,
  arriveBooking,
  updateLocation,
  completeJob,
  getEarnings,
  getWorkerReviews,
  updateJobStatus,
  confirmCompletion,
  getJobHistory,
  cancelJob,
  previewJobCancel,
} = require('../controllers/worker/workerJobsController');
const {
  getMyReliability,
  getMyReliabilityHistory,
  submitAppeal,
  getMyAppeals,
} = require('../controllers/reliability/workerReliabilityController');
const { getDemandAssistant } = require('../controllers/worker/workerDemandController');
const { chatHandler } = require('../controllers/ai/assistantController');
const {
  submitMaterialRequest,
} = require('../controllers/shared/materialRequestController');
const {
  getWelfare,
  updateWelfare,
  getTrainings,
  enrollTraining,
  getMyTrainings,
} = require('../controllers/worker/welfareController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');
const rateLimit = require('express-rate-limit');

// Cost control for the AI chatbot: max 10 chat requests per IP per minute.
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please wait a moment and try again' },
});

// Dashboard
router.get('/dashboard', protect, authorize('worker'), getWorkerDashboard);
router.get('/wand', protect, authorize('worker'), getWorkerDashboard); // alias for dashboard

// AI Demand Assistant + job demand heatmap
router.get('/demand/assistant', protect, authorize('worker'), getDemandAssistant);

// ShramikSetu AI Assistant (chatbot)
router.post('/ai-assistant/chat', protect, aiChatLimiter, chatHandler);

// Profile
router.get('/profile', protect, authorize('worker'), getOwnProfile);
router.put('/profile', protect, authorize('worker'), upload.single('avatar'), updateOwnProfile);

// Skills
router.post('/skills', protect, authorize('worker'), addSkill);
router.delete('/skills/:skillId', protect, authorize('worker'), removeSkill);

// Certificates
router.get('/certificates', protect, authorize('worker'), getCertificates);
router.post('/certificates', protect, authorize('worker'), upload.single('file'), uploadCertificate);

// Availability
router.get('/availability', protect, authorize('worker'), getAvailability);
router.post('/availability', protect, authorize('worker'), setAvailability);

// Jobs
router.get('/jobs/requests', protect, authorize('worker'), getJobRequests);
router.get('/jobs/active', protect, authorize('worker'), getActiveJobs);
router.get('/jobs/history', protect, authorize('worker'), getJobHistory);
router.post('/jobs/:id/accept', protect, authorize('worker'), acceptJob);
router.post('/jobs/:id/reject', protect, authorize('worker'), rejectJob);
router.post('/jobs/:id/start', protect, authorize('worker'), startJob);
router.post('/jobs/:id/arrive', protect, authorize('worker'), arriveBooking);
router.post('/jobs/:id/complete', protect, authorize('worker'), upload.array('afterImages', 5), completeJob);
router.post('/jobs/:id/status', protect, authorize('worker'), updateJobStatus);
router.put('/jobs/:id/cancel', protect, authorize('worker'), cancelJob);
router.post('/jobs/:id/cancel-preview', protect, authorize('worker'), previewJobCancel);
router.post('/jobs/:id/confirm', protect, authorize('worker'), confirmCompletion);
router.post('/jobs/:id/material-request', protect, authorize('worker'), submitMaterialRequest);

// Reliability
router.get('/me/reliability', protect, authorize('worker'), getMyReliability);
router.get('/me/reliability/history', protect, authorize('worker'), getMyReliabilityHistory);
router.post('/me/appeals', protect, authorize('worker'), submitAppeal);
router.get('/me/appeals', protect, authorize('worker'), getMyAppeals);

// Location
router.put('/location', protect, authorize('worker'), updateLocation);

// Earnings
router.get('/earnings', protect, authorize('worker'), getEarnings);

// Reviews
router.get('/reviews', protect, authorize('worker'), getWorkerReviews);

// Welfare
router.get('/welfare', protect, authorize('worker'), getWelfare);
router.put('/welfare', protect, authorize('worker'), updateWelfare);

// Training
router.get('/trainings', protect, authorize('worker'), getTrainings);
router.post('/trainings/enroll', protect, authorize('worker'), enrollTraining);
router.get('/trainings/my', protect, authorize('worker'), getMyTrainings);

module.exports = router;
