-- =============================================================================
-- Migration 210: Align webhook_events with current provider_event_id ingestion
-- =============================================================================
-- This migration brings the webhook_events schema into alignment with the
-- current Razorpay webhook ingestion code, which writes provider_event_id,
-- status, request_id, and updated_at on insert.
--
-- It is intentionally idempotent and safe for local development.
-- =============================================================================

BEGIN;

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS request_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE webhook_events
SET provider_event_id = razorpay_event_id
WHERE provider_event_id IS NULL
  AND razorpay_event_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'webhook_events'
      AND indexname = 'uq_webhook_events_provider_event'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX uq_webhook_events_provider_event ON webhook_events (provider, provider_event_id)';
  END IF;
END $$;

COMMIT;
