'use strict';

const express = require('express');
const router = express.Router();

// Temporary sanity routes for startup
// Avoid crashing app startup if coreController is not wired in this branch.
// This ping is not used by production clients.
router.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'planbuddy', ts: Date.now() });
});


router.get('/status', (req, res) => {
  res.json({ status: 'api ready' });
});

// Health endpoints
const healthController = require('../controllers/healthController');
router.get('/health', healthController.readiness);
router.get('/health/production', healthController.production);


// ─── Booking controller routes ────────────────────────────────────────────
const bookingController = require('../controllers/bookingController');
const paymentController = require('../controllers/paymentController');
const { authenticate, requireRole } = require('../middleware');
const { webhookLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');


// GET /bookings — list user bookings
router.get('/bookings', authenticate, bookingController.getUserBookings);

// GET /bookings/:bookingId — get single booking
router.get('/bookings/:bookingId', authenticate, bookingController.getBooking);

// POST /bookings/:bookingId/cancel — cancel booking with refund
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/bookings/:bookingId/cancel',
  authenticate,
  idempotency.strict,  // ✅ Enforce Idempotency-Key header
  bookingController.cancelBooking
);

// GET /admin/bookings — admin only
router.get('/admin/bookings', authenticate, requireRole('admin'), bookingController.getAllBookings);

// ─── Payment controller routes ─────────────────────────────────────────────

// POST /payment/create-order — create Razorpay order
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/payment/create-order',
  authenticate,
  idempotency.strict,  // ✅ Enforce Idempotency-Key header
  paymentController.createOrder
);

// POST /payment/verify — verify payment capture
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/payment/verify',
  authenticate,
  idempotency.strict,  // ✅ Enforce Idempotency-Key header
  paymentController.verifyPayment
);

// GET /payment/status/:paymentId — view payment status
router.get(
  '/payment/status/:paymentId',
  authenticate,
  paymentController.getPaymentStatus
);

// POST /admin/payments/:paymentId/reconcile — manual reconciliation (admin only)
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/admin/payments/:paymentId/reconcile',
  authenticate,
  requireRole('admin'),
  idempotency.strict,  // ✅ Enforce Idempotency-Key header
  paymentController.manualReconcile
);

// POST /payment/webhook/razorpay — Razorpay webhook ingestion
router.post('/payment/webhook/razorpay', webhookLimiter, paymentController.razorpayWebhook);

// Check availability
router.get('/trips/:tripId/availability', bookingController.checkAvailability);
router.get('/trips/:tripId/slots', bookingController.getAvailableSlots);

module.exports = router;
