const express = require('express');
const router = express.Router();
const {
  getDashboard,
  getBookings,
  getCustomerProfile,
  getCustomerCancellations,
  updateCustomerProfile,
} = require('../controllers/customer/customerController');
const {
  createServiceRequest,
  getBookingById,
  cancelBooking,
  previewCancellation,
  requestReassignment,
} = require('../controllers/customer/bookingController');
const {
  getInvoiceByBooking,
  getCustomerInvoices,
} = require('../controllers/customer/invoiceController');
const {
  confirmCompletion,
} = require('../controllers/worker/workerJobsController');
const {
  initiatePayment,
  getPaymentForBooking,
} = require('../controllers/shared/paymentController');
const {
  approveMaterialRequest,
  rejectMaterialRequest,
} = require('../controllers/shared/materialRequestController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');
const { chatHandler } = require('../controllers/ai/assistantController');
const rateLimit = require('express-rate-limit');

// Cost control for the AI chatbot: max 10 chat requests per IP per minute.
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please wait a moment and try again' },
});

// Dashboard (authenticated customer)
router.get('/dashboard', protect, authorize('customer'), getDashboard);

// AI Home & Service Assistant (chatbot)
router.post('/ai-assistant/chat', protect, aiChatLimiter, chatHandler);

// Profile
router.get('/profile', protect, authorize('customer'), getCustomerProfile);
router.put('/profile', protect, authorize('customer'), updateCustomerProfile);

// Cancellation history (profile / suspension screen)
router.get('/cancellations', protect, authorize('customer'), getCustomerCancellations);

// Bookings
router.get('/bookings', protect, authorize('customer'), getBookings);
router.post('/bookings', protect, authorize('customer'), upload.array('images', 5), createServiceRequest);
router.get('/bookings/:id', protect, authorize('customer'), getBookingById);
router.put('/bookings/:id/cancel', protect, authorize('customer'), cancelBooking);
router.post('/bookings/:id/cancel-preview', protect, authorize('customer'), previewCancellation);
router.post('/bookings/:id/reassign', protect, authorize('customer'), requestReassignment);
router.post('/bookings/:id/confirm', protect, authorize('customer'), confirmCompletion);
router.post('/bookings/:id/material-request/:requestId/approve', protect, authorize('customer'), approveMaterialRequest);
router.post('/bookings/:id/material-request/:requestId/reject', protect, authorize('customer'), rejectMaterialRequest);

// Payments
router.post('/payments', protect, authorize('customer'), initiatePayment);
router.get('/payments/booking/:bookingId', protect, authorize('customer'), getPaymentForBooking);

// Invoices
router.get('/invoices', protect, authorize('customer'), getCustomerInvoices);
router.get('/invoices/booking/:bookingId', protect, authorize('customer'), getInvoiceByBooking);

module.exports = router;
