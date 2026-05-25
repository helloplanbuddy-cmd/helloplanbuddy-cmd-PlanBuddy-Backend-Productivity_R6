'use strict';

const express = require('express');
const { z } = require('zod');
const router = express.Router();

/**
 * FINANCIAL ENDPOINTS REGISTRY [M-1]
 *
 * All POST/PUT/DELETE endpoints that mutate payment or booking state MUST use
 * idempotency.strict middleware to prevent duplicate processing.
 *
 * ENFORCED ENDPOINTS (idempotency.strict required):
 *  ✅ POST   /payment/create-order              → Create Razorpay order
 *  ✅ POST   /payment/verify                    → Capture payment
 *  ✅ POST   /admin/payments/:id/reconcile      → Manual payment reconciliation
 *  ✅ POST   /bookings/:bookingId/cancel        → Cancel booking + refund
 *
 * READ-ONLY ENDPOINTS (idempotency not required):
 *  ○ GET    /bookings                          → List user bookings
 *  ○ GET    /bookings/:bookingId               → Get booking details
 *  ○ GET    /payment/status/:paymentId         → Get payment status
 *  ○ GET    /admin/bookings                    → Admin: list all bookings
 *
 * WEBHOOK ENDPOINTS (special deduplication):
 *  ○ POST   /payment/webhook/razorpay          → Uses provider_event_id + ON CONFLICT
 *
 * Audit: See __tests__/security/idempotency-enforcement-audit.test.js
 */

// Temporary sanity routes for startup
// Avoid crashing app startup if coreController is not wired in this branch.
// This ping is not used by production clients.
router.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'planbuddy', ts: Date.now() });
});

router.get('/status', (req, res) => {
  res.json({ status: 'api ready' });
});

// ─── Booking controller routes ────────────────────────────────────────────
const bookingController = require('../controllers/bookingController');
const paymentController = require('../controllers/paymentController');
const authRoutes = require('./auth');
const { authenticate, requireRole } = require('../middleware');
const { webhookLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');
const {
  validate,
  validateAll,
  CreateOrderSchema,
  VerifyPaymentSchema,
  GetBookingsSchema,
  CancelBookingSchema,
  AdminBookingsSchema,
} = require('../middleware/validation');

const RouteBookingIdSchema = z.object({ bookingId: z.string().uuid('Invalid booking ID') });
const RoutePaymentIdSchema = z.object({ paymentId: z.string().uuid('Invalid payment ID') });
const RouteTripIdSchema = z.object({ tripId: z.string().uuid('Invalid trip ID') });

// GET /bookings — list user bookings
router.use('/auth', authRoutes);

router.get(
  '/bookings',
  authenticate,
  validateAll({ query: GetBookingsSchema }),
  bookingController.getUserBookings
);

// GET /bookings/:bookingId — get single booking
router.get(
  '/bookings/:bookingId',
  authenticate,
  validateAll({ params: RouteBookingIdSchema }),
  bookingController.getBooking
);

// POST /bookings/:bookingId/cancel — cancel booking with refund
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/bookings/:bookingId/cancel',
  authenticate,
  validateAll({ params: RouteBookingIdSchema, body: CancelBookingSchema }),
  idempotency.strict,
  bookingController.cancelBooking
);

// GET /admin/bookings — admin only
router.get(
  '/admin/bookings',
  authenticate,
  requireRole('admin'),
  validateAll({ query: AdminBookingsSchema }),
  bookingController.getAllBookings
);

// ─── Payment controller routes ─────────────────────────────────────────────

// POST /payment/create-order — create Razorpay order
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/payment/create-order',
  authenticate,
  validate(CreateOrderSchema),
  idempotency.strict,
  paymentController.createOrder
);

// POST /payment/verify — verify payment capture
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/payment/verify',
  authenticate,
  validate(VerifyPaymentSchema),
  idempotency.strict,
  paymentController.verifyPayment
);

// GET /payment/status/:paymentId — view payment status
router.get(
  '/payment/status/:paymentId',
  authenticate,
  validateAll({ params: RoutePaymentIdSchema }),
  paymentController.getPaymentStatus
);

// POST /admin/payments/:paymentId/reconcile — manual reconciliation (admin only)
// ✅ IDEMPOTENCY ENFORCEMENT: Idempotency-Key header REQUIRED
router.post(
  '/admin/payments/:paymentId/reconcile',
  authenticate,
  requireRole('admin'),
  validateAll({ params: RoutePaymentIdSchema }),
  idempotency.strict,
  paymentController.manualReconcile
);

// POST /payment/webhook/razorpay — Razorpay webhook ingestion
router.post('/payment/webhook/razorpay', webhookLimiter, paymentController.razorpayWebhook);

// Check availability
router.get(
  '/trips/:tripId/availability',
  validateAll({ params: RouteTripIdSchema }),
  bookingController.checkAvailability
);
router.get(
  '/trips/:tripId/slots',
  validateAll({ params: RouteTripIdSchema }),
  bookingController.getAvailableSlots
);

module.exports = router;
