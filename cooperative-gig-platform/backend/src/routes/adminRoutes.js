const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getWorkers,
  getWorkerDetail,
  updateWorkerStatus,
  updateWorkerSkillVerification,
  getCertificates,
  reviewCertificate,
  getCustomers,
  getAllBookings,
  getAllPayments,
  getComplaints,
  updateComplaint,
  createTraining,
  updateTraining,
  getCooperativeSettings,
  updateCooperativeSettings,
  rematchAllBookings,
} = require('../controllers/admin/adminController');
const {
  getComplaints: acGetComplaints,
  getComplaintDetail,
  respond: acRespond,
  updateComplaint: acUpdateComplaint,
  proposeResolution,
  finalizeResolution,
  escalate,
  suspendWorker,
  unsuspendWorker,
} = require('../controllers/admin/adminComplaintController');
const {
  getForecasts,
  getWorkforceAllocation,
  getDemandData,
  getDemandHeatmap,
  getAnalytics,
} = require('../controllers/admin/analyticsController');
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getPaymentOverview,
  getAllPayouts,
  updatePayoutStatus,
} = require('../controllers/payments/adminPaymentController');
const {
  listReliabilityWorkers,
  getWorkerReliabilityDetail,
  adjustWorkerReliability,
  suspendWorkerReliability,
  reactivateWorkerReliability,
  getAppeals,
  reviewAppeal,
  getReliabilitySettings,
  updateReliabilitySettings,
} = require('../controllers/reliability/adminReliabilityController');
const {
  listCancellations,
  getCancellationDetail,
  getReasons,
  previewAdminCancellation,
  cancelBookingForAdmin,
} = require('../controllers/cancellation/adminCancellationController');
const {
  listSuspendedCustomers,
  listSuspendedWorkers,
  unsuspendCustomer: unsuspendAdminCustomer,
  unsuspendWorker: unsuspendAdminWorker,
  getAuditLogs,
} = require('../controllers/admin/adminSuspensionController');

// All admin routes protected + admin only
router.use(protect, authorize('admin'));

// Dashboard
router.get('/dashboard', getDashboardStats);

// Matching
router.post('/matching/rematch', rematchAllBookings);

// Analytics & AI
router.get('/analytics', getAnalytics);
router.get('/forecast', getForecasts);
router.get('/allocations', getWorkforceAllocation);
router.get('/demand', getDemandData);
router.get('/heatmap', getDemandHeatmap);

// Workers
router.get('/workers', getWorkers);
router.get('/workers/:id', getWorkerDetail);
router.put('/workers/:id/status', updateWorkerStatus);
router.patch('/workers/:id/skills/:skillId', updateWorkerSkillVerification);

// Reliability management
router.get('/reliability/workers', listReliabilityWorkers);
router.get('/reliability/workers/:workerId', getWorkerReliabilityDetail);
router.post('/reliability/workers/:workerId/adjust', adjustWorkerReliability);
router.post('/reliability/workers/:workerId/suspend', suspendWorkerReliability);
router.post('/reliability/workers/:workerId/reactivate', reactivateWorkerReliability);
router.get('/reliability/appeals', getAppeals);
router.post('/reliability/appeals/:id/approve', reviewAppeal);
router.post('/reliability/appeals/:id/reject', reviewAppeal);
router.get('/reliability/settings', getReliabilitySettings);
router.put('/reliability/settings', updateReliabilitySettings);

// Cancellation oversight
router.get('/cancellations', listCancellations);
router.get('/cancellations/reasons', getReasons);
router.get('/cancellations/:id', getCancellationDetail);
router.post('/cancellations/:bookingId/preview', previewAdminCancellation);
router.post('/cancellations/:bookingId', cancelBookingForAdmin);

// Certificates
router.get('/certificates', getCertificates);
router.put('/certificates/:id/review', reviewCertificate);

// Customers
router.get('/customers', getCustomers);

// Suspended accounts (temporary suspensions + admin unsuspend)
router.get('/suspensions/customers', listSuspendedCustomers);
router.get('/suspensions/workers', listSuspendedWorkers);
router.post('/suspensions/customers/:id/unsuspend', unsuspendAdminCustomer);
router.post('/suspensions/workers/:id/unsuspend', unsuspendAdminWorker);
router.get('/suspensions/logs', getAuditLogs);

// Bookings
router.get('/bookings', getAllBookings);

// Payments
router.get('/payments', getAllPayments);
router.get('/payments/overview', getPaymentOverview);

// Payouts (worker withdrawal management)
router.get('/payouts', getAllPayouts);
router.put('/payouts/:id/status', updatePayoutStatus);

// Complaints & Disputes
router.get('/complaints', acGetComplaints);
router.get('/complaints/:id', getComplaintDetail);
router.put('/complaints/:id', acUpdateComplaint);
router.post('/complaints/:id/respond', acRespond);
router.post('/complaints/:id/propose-resolution', proposeResolution);
router.post('/complaints/:id/finalize-resolution', finalizeResolution);
router.post('/complaints/:id/escalate', escalate);
router.post('/complaints/:id/suspend-worker', suspendWorker);
router.post('/complaints/:id/unsuspend-worker', unsuspendWorker);

// Training (admin)
router.post('/trainings', createTraining);
router.put('/trainings/:id', updateTraining);

// Cooperative settings
router.get('/settings', getCooperativeSettings);
router.put('/settings', updateCooperativeSettings);

module.exports = router;
