-- Migration 165: Refunds Table Base Schema
-- ============================================================================
-- Adds the refunds table required by refundService.js and audit logging.
-- This migration is idempotent and safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS refunds (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id          UUID          NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  booking_id          UUID          NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  user_id             UUID,
  razorpay_refund_id  VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  amount              NUMERIC(12,2) NOT NULL,
  reason              TEXT,
  status              VARCHAR(50)  NOT NULL DEFAULT 'pending',
  razorpay_status     VARCHAR(50),
  idempotency_key     VARCHAR(200),
  processed_by        VARCHAR(100),
  last_error          TEXT,
  attempt             INTEGER      NOT NULL DEFAULT 0,
  webhook_event_id    VARCHAR(200),
  metadata            JSONB,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_payment_id_idempotency_key
  ON refunds(payment_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_razorpay_refund_id
  ON refunds(razorpay_refund_id)
  WHERE razorpay_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_booking_id
  ON refunds(booking_id);

COMMIT;
