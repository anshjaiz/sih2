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
const { protect } = require('../middleware/authMiddleware');
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
router.get('/dashboard', protect, getDashboard);

// AI Home & Service Assistant (chatbot)
router.post('/ai-assistant/chat', protect, aiChatLimiter, chatHandler);

// Profile
router.get('/profile', protect, getCustomerProfile);
router.put('/profile', protect, updateCustomerProfile);

// Cancellation history (profile / suspension screen)
router.get('/cancellations', protect, getCustomerCancellations);

// Bookings
router.get('/bookings', protect, getBookings);
router.post('/bookings', protect, upload.array('images', 5), createServiceRequest);
router.get('/bookings/:id', protect, getBookingById);
router.put('/bookings/:id/cancel', protect, cancelBooking);
router.post('/bookings/:id/cancel-preview', protect, previewCancellation);
router.post('/bookings/:id/reassign', protect, requestReassignment);
router.post('/bookings/:id/confirm', protect, confirmCompletion);
router.post('/bookings/:id/material-request/:requestId/approve', protect, approveMaterialRequest);
router.post('/bookings/:id/material-request/:requestId/reject', protect, rejectMaterialRequest);

// Payments
router.post('/payments', protect, initiatePayment);
router.get('/payments/booking/:bookingId', protect, getPaymentForBooking);

// Invoices
router.get('/invoices', protect, getCustomerInvoices);
router.get('/invoices/booking/:bookingId', protect, getInvoiceByBooking);

module.exports = router;
