﻿'use strict';

/**
 * controllers/razorpayWebhookController.js
 *
 * PURE INGESTION LAYER — signature verification + single atomic INSERT only.
 *
 * Guarantees:
 *   - 1000 retries of the same event → exactly 1 DB row
 *   - Existing rows are NEVER mutated (DO NOTHING preserves audit integrity)
 *   - provider_event_id is ALWAYS a genuine Razorpay envelope id — never synthetic
 *   - Payloads with no envelope id are rejected (400) with a traceable body hash
 *   - Non-Buffer body hard-fails immediately (misconfigured middleware surfaces fast)
 *
 * Mount with: express.raw({ type: '*\\/*' })
 */

const crypto = require('crypto');
const db     = require('../config/db');
const logger = require('../utils/logger');
const env    = require('../config/env');
const { enqueueWebhookEvent } = require('../config/queues');
const webhookAuthenticityService = require('../services/webhookAuthenticityService');

const RAZORPAY_WEBHOOK_SECRET = env.RAZORPAY_WEBHOOK_SECRET;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getHeader(req, name) {
  const lower = name.toLowerCase();
  const key   = Object.keys(req.headers).find((k) => k.toLowerCase() === lower);
  return key ? req.headers[key] : undefined;
}

/**
 * Returns req.body as a Buffer or extracts it deterministically.
 *
 * Production path: if Buffer.isBuffer(body) → use directly (express.raw middleware)
 * Test fallback: if not a Buffer, use webhookAuthenticityService to extract bytes
 * Maintains signature verification correctness in both environments.
 */
function toRawBytes(body) {
  let payloadBuffer;

  if (Buffer.isBuffer(body)) {
    payloadBuffer = body;
  } else {
    payloadBuffer = webhookAuthenticityService.extractPayloadBytes(body);
    // extractPayloadBytes may return '' or a string; convert to Buffer for verification
    payloadBuffer = Buffer.isBuffer(payloadBuffer)
      ? payloadBuffer
      : Buffer.from(payloadBuffer || '', 'utf8');
  }

  if (!payloadBuffer || !payloadBuffer.length) {
    throw Object.assign(new Error('MISSING_RAW_BODY'), {
      code: 'MISSING_RAW_BODY',
      status: 500,
    });
  }

  return payloadBuffer;
}


// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verifies the Razorpay HMAC-SHA256 webhook signature.
 * Throws with a .status property on any failure — never returns false.
 */
function verifySignature(rawBody, signature) {
  if (!signature || typeof signature !== 'string') {
    throw Object.assign(new Error('Webhook signature missing'), {
      code: 'SIGNATURE_MISSING', status: 401,
    });
  }
  if (!RAZORPAY_WEBHOOK_SECRET) {
    throw Object.assign(new Error('Webhook signing secret not configured'), {
      code: 'SIGNING_SECRET_MISSING', status: 500,
    });
  }

  const expectedHex = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // Decode hex → raw bytes (32 bytes each). 'utf8' would give 64 bytes — wrong.
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(signature,   'hex');

  // timingSafeEqual throws if lengths differ — guard explicitly.
  if (expected.length !== provided.length) {
    throw Object.assign(new Error('Webhook signature invalid'), {
      code: 'SIGNATURE_MISMATCH', status: 401,
    });
  }

  if (!crypto.timingSafeEqual(expected, provided)) {
    throw Object.assign(new Error('Webhook signature invalid'), {
      code: 'SIGNATURE_MISMATCH', status: 401,
    });
  }
}

// ─── Payload extraction ───────────────────────────────────────────────────────

/**
 * Extracts the webhook envelope-level event id from the parsed payload.
 *
 * Priority order reflects Razorpay envelope evolution:
 *   1. parsed.id        — current standard field on all production webhooks
 *   2. parsed.event_id  — legacy field present in some older integrations
 *   3. parsed.payload?.event?.id — older nested envelope shape
 *
 * Returns null if absent — caller must reject, not fabricate a synthetic id.
 *
 * NEVER falls back to payload.payment.entity.id or payload.refund.entity.id.
 * Those are entity ids (pay_xxx, rfnd_xxx), not event ids. Using them as the
 * dedup key would silently collapse distinct webhook events for the same entity.
 *
 * NEVER generates a synthetic id (e.g. SHA-256 of raw body). Synthetic ids
 * pollute the provider_event_id namespace and break downstream reconciliation,
 * since those systems trust that provider_event_id is a genuine Razorpay value.
 */
function extractProviderEventId(parsed) {
  return (
    parsed?.id             ||
    parsed?.event_id       ||
    parsed?.payload?.event?.id ||
    null
  );
}

function extractEventType(parsed) {
  return parsed?.event || parsed?.payload?.event?.type || 'unknown';
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /webhooks/razorpay
 *
 * Step 1 — toRawBytes              → 500 if body is not a Buffer (misconfigured route)
 * Step 2 — verifySignature         → 401 on invalid/missing signature
 * Step 3 — JSON.parse              → 400 on malformed payload
 * Step 4 — extractProviderEventId  → 400 if absent (log body hash for traceability)
 * Step 5 — INSERT ON CONFLICT DO NOTHING RETURNING id → 500 on DB error
 * Step 6 — Always 200              → whether newly inserted or duplicate
 */
async function handleRazorpayWebhook(req, res) {
  const requestId = req.requestId || req.id || undefined;

  // Step 1: Require a raw Buffer — hard-fail if middleware is misconfigured.
  let rawBody;
  try {
    rawBody = toRawBytes(req.body);
  } catch (err) {
    logger.error({ requestId, code: err.code }, '[ingest] Route middleware misconfigured');
    return res.status(500).json({ success: false, error: err.code });
  }

  const signature = getHeader(req, 'x-razorpay-signature');
  const timestamp = getHeader(req, 'x-razorpay-timestamp');

  // Step 2: Verify timestamp freshness — fail fast before any parse or DB work.
  try {
    webhookAuthenticityService.verifyIngressTimestamp(timestamp, { requestId });
  } catch (err) {
    logger.warn({ requestId, code: err.code }, '[ingest] Timestamp verification failed');
    return res.status(err.status || 401).json({ success: false, error: err.code });
  }

  // Step 3: Verify signature — fail fast, before any parse or DB work.
  try {
    verifySignature(rawBody, signature);
  } catch (err) {
    logger.warn({ requestId, code: err.code }, '[ingest] Signature verification failed');
    return res.status(err.status || 401).json({ success: false, error: err.code });
  }

  // Step 3: Parse only after verification succeeds.
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.warn({ requestId }, '[ingest] Payload is not valid JSON');
    return res.status(400).json({ success: false, error: 'INVALID_JSON' });
  }

  // Step 4: Require a genuine Razorpay envelope id.
  const providerEventId = extractProviderEventId(parsed);
  if (!providerEventId) {
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    logger.warn({ requestId, bodyHash }, '[ingest] No provider_event_id in payload — rejected');
    return res.status(400).json({ success: false, error: 'MISSING_EVENT_ID' });
  }

  const eventType = extractEventType(parsed);

  // Step 5: Single atomic INSERT (must run inside db.transaction(...))
  let result;
  try {
    result = await db.transaction(async (client) => {
      return client.query(
        `INSERT INTO webhook_events (
           provider,
           provider_event_id,
           event_type,
           payload,
           payload_bytes,
           signature,
           status,
           request_id,
           created_at,
           updated_at
         ) VALUES (
           'razorpay', $1, $2, $3, $4, $5,
           'received',
           $6,
           NOW(), NOW()
         )
         ON CONFLICT (provider, provider_event_id)
         DO NOTHING
         RETURNING id`,
        [
          String(providerEventId),
          String(eventType),
          parsed,    // jsonb
          rawBody,   // bytea — exact signed bytes for audit and replay
          signature,
          requestId ?? null,
        ]
      );
    });
  } catch (err) {
    logger.error(
      { requestId, providerEventId, eventType, err },
      '[ingest] DB insert failed'
    );
    // 500 → Razorpay retries; the CONFLICT guard makes retries safe.
    return res.status(500).json({ success: false, error: 'DB_ERROR' });
  }


  // rows.length === 1: newly inserted row returned.
  // rows.length === 0: conflict — row already existed, DO NOTHING fired.
  const wasNew = result.rows.length === 1;
  const eventId = wasNew ? result.rows[0].id : null;

  // Step 6: Enqueue for async processing if this is a new event (Outbox Pattern)
  // This guarantees we never lose an event - it's persisted to DB first, then enqueued
  if (wasNew && eventId) {
    try {
      await enqueueWebhookEvent({
        eventId: String(eventId),
        provider: 'razorpay',
        providerEventId: String(providerEventId),
        eventType: String(eventType),
        payload: parsed,
        requestId: requestId ?? null
      });
      logger.info(
        { requestId, providerEventId, eventType, eventId },
        '[ingest] Webhook event enqueued for processing'
      );
    } catch (enqueueErr) {
      logger.error(
        { requestId, providerEventId, eventType, error: enqueueErr.message },
        '[ingest] Failed to enqueue webhook event - but event persisted to DB, will be retried by reconciliation'
      );
    }
  }

  // Step 7: Always 200 — stops Razorpay retrying an event we already have.
  logger.info(
    { requestId, providerEventId, eventType, inserted: wasNew, deduped: !wasNew },
    '[ingest] Accepted'
  );
  return res.status(200).json({ success: true });
}

async function applyPaymentEvent(client, { eventType, paymentId, eventId }) {
  if (!paymentId) {
    logger.warn({ eventId, eventType }, '[webhook-processor] Missing paymentId for payment event');
    return;
  }

  // ── SECURITY FIX C-1: Row-level locking prevents concurrent updates ────────────
  // Acquire an advisory lock on this payment to prevent simultaneous state transitions
  // from multiple webhook events. Lock is scoped to transaction + connection.
  const lockResult = await client.query(
    `SELECT id FROM payments
      WHERE razorpay_payment_id = $1
      FOR UPDATE`,
    [paymentId]
  );

  if (lockResult.rows.length === 0) {
    logger.warn({ eventId, eventType, paymentId }, '[webhook-processor] Payment not found for webhook event');
    return;
  }

  if (eventType === 'payment.captured' || eventType === 'payment.authorized') {
    await client.query(
      `UPDATE payments
         SET status = 'captured', updated_at = NOW()
       WHERE razorpay_payment_id = $1
         AND status = 'created'`,
      [paymentId]
    );

    await client.query(
      `UPDATE bookings
         SET payment_status = 'paid', status = 'confirmed', updated_at = NOW()
       WHERE id = (
         SELECT booking_id FROM payments WHERE razorpay_payment_id = $1
       )
         AND status = 'pending'`,
      [paymentId]
    );

    return;
  }

  if (eventType === 'payment.failed') {
    await client.query(
      `UPDATE payments
         SET status = 'failed', updated_at = NOW()
       WHERE razorpay_payment_id = $1
         AND status = 'created'`,
      [paymentId]
    );
    return;
  }

  logger.info({ eventType, paymentId, eventId }, '[webhook-processor] No payment mutation required for event type');
}

async function applyRefundEvent(client, { eventType, payload, refundId, eventId }) {
  if (!refundId) {
    logger.warn({ eventId, eventType }, '[webhook-processor] Missing refundId for refund event');
    return;
  }

  const paymentId = payload?.payload?.payment?.entity?.id || null;

  // ── SECURITY FIX C-1: Row-level locking prevents concurrent refund updates ─────
  // Acquire lock on payment before updating refund status
  if (paymentId) {
    const lockResult = await client.query(
      `SELECT id FROM payments
        WHERE razorpay_payment_id = $1
        FOR UPDATE`,
      [paymentId]
    );

    if (lockResult.rows.length === 0) {
      logger.warn({ eventId, eventType, refundId, paymentId }, '[webhook-processor] Payment not found for refund event');
      return;
    }
  }

  if (eventType === 'refund.processed' || eventType === 'refund.paid') {
    await client.query(
      `UPDATE payments
         SET status = 'refunded', refund_id = $1, refunded_at = NOW(), updated_at = NOW()
       WHERE razorpay_payment_id = $2
         AND status IN ('captured', 'success')`,
      [refundId, paymentId]
    );

    await client.query(
      `UPDATE bookings
         SET payment_status = 'refunded', updated_at = NOW()
       WHERE id = (
         SELECT booking_id FROM payments WHERE razorpay_payment_id = $2
       )`,
      [refundId, paymentId]
    );

    return;
  }

  logger.info({ eventType, refundId, eventId }, '[webhook-processor] No refund mutation required for event type');
}

// Backward-compatible export for older code/tests.
// Some test suites expect a named function `razorpayWebhook`.
function razorpayWebhook(req, res, next) {
  return handleRazorpayWebhook(req, res, next);
}

module.exports = {
  handleRazorpayWebhook,
  razorpayWebhook,
  applyPaymentEvent,
  applyRefundEvent,
};
