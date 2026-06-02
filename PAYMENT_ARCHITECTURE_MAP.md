# PAYMENT ARCHITECTURE MAP

## Overview
This document maps the PlanBuddy V9 payment and refund system from client entrypoint through route, middleware, validation, authentication, controller, service, database, queue, worker, and response behavior.

All file references are from `planbuddy_v9/`.

---

## 1. POST /api/v1/payment/create-order

- Client: frontend calls payment creation after booking selection.
- Route: `planbuddy_v9/routes/index.js` line 112
- Middleware:
  - `authenticate` from `planbuddy_v9/middleware/index.js`
  - `validate(CreateOrderSchema)` from `planbuddy_v9/middleware/validation.js` line 93
  - `idempotency.strict` from `planbuddy_v9/middleware/idempotency.js`
  - global JSON body parser in `planbuddy_v9/app.js`
  - global rate limiting / backpressure via `planbuddy_v9/app.js`
- Controller: `planbuddy_v9/controllers/paymentController.js` line 35
- Validation schema: `CreateOrderSchema` requires `{ bookingId: uuid }` in `planbuddy_v9/middleware/validation.js` line 93
- Auth: user must be authenticated; user ID is read from `req.user.id`
- Business logic:
  - Loads booking + trip data from `bookings` and `trips` in `paymentController.createOrder`
  - Validates booking amount and active status
  - Ensures `booking.status === 'pending'` and `booking.payment_status === 'unpaid'`
  - Uses Razorpay SDK singleton from `planbuddy_v9/config/razorpay.js`
  - Converts booking total to paise via `rupeesToPaise()` in `planbuddy_v9/config/razorpay.js` line 18
  - Creates Razorpay order with:
    - `amount: amountPaise`
    - `currency: booking.currency || 'INR'`
    - `receipt: bookingId.replace(/-/g, '').slice(0, 40)`
    - `notes: { booking_id, user_id }`
- Database:
  - `razorpay_order_mappings` insert in transaction in `paymentController.createOrder`
  - `payments` row updated with `razorpay_order_id`
  - NOTE: `razorpay_order_mappings` inserts `booking.total_amount` in rupees, while the Razorpay order uses `amountPaise` in paise. This is evidence of mixed unit handling in persistence.
- Response:
  - Returns JSON with `orderId`, `amount` (paise), `currency`, `keyId`, and `bookingId`
  - Success response path is in `paymentController.createOrder`
- Failure handling:
  - Validation error returns 400
  - Booking not found returns 404
  - Inactive or wrong booking state returns 409
  - Razorpay unavailable returns 503
  - Exceptions are routed through `next(err)` and monitored by `planbuddy_v9/utils/monitoring.js`

---

## 2. POST /api/v1/payment/verify

- Client: frontend submits Razorpay payment capture details after client-side payment completion.
- Route: `planbuddy_v9/routes/index.js` line 116
- Middleware:
  - `authenticate`
  - `validate(VerifyPaymentSchema)` from `planbuddy_v9/middleware/validation.js` line 97
  - `idempotency.strict`
- Validation schema: `VerifyPaymentSchema` requires
  - `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`
  - `amount: number().int().min(1)`
  - `currency: string().length(3).default('INR')`
- Controller: `planbuddy_v9/controllers/paymentController.js` line 181
- Auth: user must be authenticated
- Signature validation:
  - `signaturePayload = `${razorpay_order_id}|${razorpay_payment_id}``
  - `RazorpayService.verifySignature(signaturePayload, razorpay_signature)`
- Business logic:
  - Delegates to `services/razorpayService.js` `processPaymentTransaction()`
- Service architecture: 3-phase transaction in `planbuddy_v9/services/razorpayService.js`
  - Phase 1: `verifyPaymentEligible()` selects payment row FOR UPDATE in serializable isolation
  - Phase 2: `fetchRazorpayPayment()` calls `razorpay.payments.fetch(paymentId)` outside transaction
  - Phase 3: `persistCapturedPayment()` updates `payments` and `bookings` in serializable TX
- DB:
  - `payments` row is validated and then updated to `status = 'success'` or `status = 'failed'`
  - `bookings` row is updated to `status = 'confirmed'` on capture
- Response:
  - Returns `success: true` and `message` indicating idempotent replay or capture
- Duplicate protection:
  - `idempotency.strict` prevents duplicate request processing at API layer
  - `verifyPaymentEligible()` returns idempotent result for already-success/failed/wrong-state payments
- Concurrency protection:
  - `FOR UPDATE` / serializable transaction in DB decision and persist phases
- Failure handling:
  - Razorpay API fetch failures bubble to caller
  - Serialization conflicts retry inside service
  - Monitoring increments `payment_failures_total`

---

## 3. POST /api/v1/payment/webhook/razorpay

- Client: Razorpay webhook delivery to backend
- Route: `planbuddy_v9/routes/index.js` line 132
- App bootstrap raw body middleware:
  - `planbuddy_v9/app.js` line 181 mounts `express.raw({ type: 'application/json', limit: '100kb' })`
  - This must run before `express.json()` to preserve raw bytes
- Middleware:
  - `webhookLimiter` from `planbuddy_v9/routes/index.js`
  - globalLimiter skips webhook via `isWebhookPath()` in `planbuddy_v9/middleware/rateLimit.js`
- Controller delegation:
  - `paymentController.razorpayWebhook` in `planbuddy_v9/controllers/paymentController.js` line 241
  - delegates to `razorpayWebhookController.handleRazorpayWebhook` in `planbuddy_v9/controllers/razorpayWebhookController.js` line 152
- Signature verification:
  - `toRawBytes()` ensures `req.body` is Buffer or extracts raw bytes
  - `verifySignature(rawBody, signature)` uses `crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)`
  - Secret is loaded from `planbuddy_v9/config/env.js` via `planbuddy_v9/config/razorpay.js`
- Timestamp validation:
  - `webhookAuthenticityService.verifyIngressTimestamp(timestamp, { requestId })`
- Payload validation:
  - JSON is parsed only after signature verification
  - `extractProviderEventId(parsed)` requires `parsed.id || parsed.event_id || parsed.payload?.event?.id`
  - Missing provider event ID returns 400 with `MISSING_EVENT_ID`
- DB ingestion:
  - Inserts into `webhook_events` with exact raw `payload_bytes`, parsed `payload`, and `status = 'received'`
  - Uses `ON CONFLICT (provider, provider_event_id) DO NOTHING`
  - This provides duplicate webhook deduplication at ingest
- Queue integration:
  - `enqueueWebhookEvent()` in `planbuddy_v9/config/queues.js` line 229
  - enqueues into `webhook-events` queue with deterministic Job ID `webhook-${provider}-${providerEventId}`
- Worker processing:
  - `planbuddy_v9/workers/webhook-processor.worker.js`
  - Claims events from `webhook_events` using `FOR UPDATE SKIP LOCKED`
  - Uses lease/version fencing via `lease_version` and `lease_expires_at`
  - Writes `webhook_event_execution_log` with `ON CONFLICT (provider_event_id) DO NOTHING` to prevent duplicate business application
  - Routes `payment.*` events to `applyPaymentEvent()` and `refund.*` events to `applyRefundEvent()` in `planbuddy_v9/controllers/razorpayWebhookController.js`
- Response:
  - Returns 200 for newly ingested or duplicate events
  - Returns 401 on invalid signature
  - Returns 400 on invalid JSON or missing event ID
  - Returns 500 on DB insert failure

---

## 4. POST /api/v1/bookings/:bookingId/cancel

- Route: `planbuddy_v9/routes/index.js` line 86
- Middleware:
  - `authenticate`
  - `validateAll({ params: RouteBookingIdSchema, body: CancelBookingSchema })`
  - `idempotency.strict`
- Controller: `planbuddy_v9/controllers/bookingController.js` line 127
- Auth: user or admin must own booking
- Business logic:
  - If booking is `confirmed` and payment_status is `paid`, marks booking `cancellation_pending`
  - Then calls `RefundService.initiateRefund()`
  - Otherwise uses `DbService.cancelBooking()` for non-paid cancellation paths
- Refund integration:
  - `RefundService.initiateRefund()` signature is `async function initiateRefund(bookingId, amount, reason, requestedBy)` in `planbuddy_v9/services/refundService.js` line 110
  - Booking cancel call is `await RefundService.initiateRefund(bookingId, reason || 'Cancelled by user', req.user.id)` in `planbuddy_v9/controllers/bookingController.js` line 189
  - Evidence: argument order mismatch between caller and service signature. This is a functional defect in refund initiation from booking cancellation.
- Response:
  - Success returns booking cancellation status and informational message
  - Refund failure returns structured error with status from refund service

---

## 5. POST /api/v1/admin/payments/:paymentId/reconcile

- Route: `planbuddy_v9/routes/index.js` line 128
- Middleware:
  - `authenticate`
  - `requireRole('admin')`
  - `validateAll({ params: RoutePaymentIdSchema })`
  - `idempotency.strict`
- Controller: `planbuddy_v9/controllers/paymentController.js` line 245
- Business logic:
  - Calls `require('../workers/paymentReconciliation.worker.js')` and `runReconciliation()`
  - Evidence: this path references `paymentReconciliation.worker.js`, but actual worker filename is `planbuddy_v9/workers/payment-reconciliation-queue.worker.js`
  - This is a runtime integration issue and likely prevents admin reconciliation from working.

---

## 6. GET /api/v1/payment/status/:paymentId

- Route: `planbuddy_v9/routes/index.js` line 122
- Middleware:
  - `authenticate`
  - `validateAll({ params: RoutePaymentIdSchema })`
- Controller: `planbuddy_v9/controllers/paymentController.js` line 266
- DB:
  - Selects from `payments`, joins `bookings` and `trips`
  - Allows lookup by `p.id` or `p.razorpay_payment_id`
- Response: returns payment object with booking/trip metadata

---

## 7. Refund service flow

- Service: `planbuddy_v9/services/refundService.js`
- Entrypoint: `initiateRefund(bookingId, amount, reason, requestedBy)` line 110
- Flow:
  1. `BEGIN ISOLATION LEVEL READ COMMITTED`
  2. `SELECT ... FROM payments ... FOR UPDATE OF p`
  3. Verify `payment.status === 'captured'`
  4. Generate deterministic idempotency key using `crypto.createHash('sha256')`
  5. `INSERT INTO refunds ... ON CONFLICT (payment_id, idempotency_key) DO NOTHING`
  6. If duplicate, return existing refund record
  7. Else call `createRazorpayRefund()` outside transaction
  8. Update refund record with Razorpay response
  9. Update payment status to `refund_failed`, then to `refunded` or `partially_refunded`
 10. Update booking status to `refunded` or `cancelled`
 11. Insert `financial_audit_log`
 12. `COMMIT`
- Evidence of mixed units:
  - Creates `refundAmount = amount ? Math.round(amount * 100) : Math.round(Number(payment.amount) * 100)`
  - Inserts `amount ? Math.round(amount * 100) / 100 : Number(payment.amount)` into refunds
  - Uses `payment.amount` as rupees and converts to paise at API call time
- Failure handling:
  - On Razorpay API error, marks refund record `failed` and increments attempt
  - On unexpected error, wraps and throws `REFUND_FAILED`

---

## 8. Queue inventory relevant to payments/refunds

### `webhook-events`
- Defined in `planbuddy_v9/config/queues.js` line 109
- Consumer: `planbuddy_v9/workers/webhook-processor.worker.js`
- Enqueue helper: `enqueueWebhookEvent()` line 229
- Retry: default BullMQ attempts 5, backoff configured by `DEFAULT_JOB_OPTIONS`
- Dedup: deterministic jobId `webhook-${provider}-${providerEventId}`

### `payment-reconciliation`
- Defined in `planbuddy_v9/config/queues.js` line 70
- Repeating schedule every 5 minutes via `scheduleRepeatableJobs()`
- Consumer: `planbuddy_v9/workers/payment-reconciliation-queue.worker.js`
- Locking: Redis lock `payment-reconciliation-lock`
- Idempotency: reconciliation log lookup prevents duplicate recovery within 5 minutes

### `refund-retry`
- Defined in `planbuddy_v9/config/queues.js` line 94
- Consumer: `planbuddy_v9/workers/refund-retry.worker.js`
- Purpose: retry failed Razorpay refunds
- Job state recorded by `JobStateManager` in `workerSafetyService`

---

## 9. Key implementation issues discovered during baseline

- `planbuddy_v9/controllers/bookingController.js` line 189 calls `RefundService.initiateRefund(bookingId, reason, req.user.id)` but service expects `(bookingId, amount, reason, requestedBy)` at `planbuddy_v9/services/refundService.js` line 110.
- `planbuddy_v9/controllers/paymentController.js` line 252 requires `../workers/paymentReconciliation.worker.js`, but actual file is `planbuddy_v9/workers/payment-reconciliation-queue.worker.js`.
- `planbuddy_v9/controllers/paymentController.js` line 35 writes `booking.total_amount` to `razorpay_order_mappings` while `planbuddy_v9/config/razorpay.js` line 18 converts amount to paise for Razorpay order creation, indicating inconsistent units between DB and API.

---

## 10. Summary of evidence-backed payment architecture

- `create-order` is guarded by auth, validation, idempotency, and uses Razorpay order creation + DB persistence.
- `verify-payment` is protected by idempotency, verifies Razorpay signature, and uses a 3-phase DB/external call model.
- `webhook/razorpay` is mounted with raw body parsing, signature verification, timestamp validation, provider event dedupe, DB persistence, queue enqueue, and asynchronous worker processing.
- Refund initiation is transactional and idempotent in service design, but booking cancellation caller code contains an argument mismatch.
- Manual admin reconciliation route currently references a non-existent worker module path.
- Queue definitions and workers are present for webhook processing, payment reconciliation, and refund retry.
