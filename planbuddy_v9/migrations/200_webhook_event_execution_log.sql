-- Migration 200: Webhook Event Execution Log
-- Adds a hard execution ledger for exactly-once business effect.
-- This table is the only canonical guarantee that Razorpay webhook events
-- are executed once and only once at the business-logic layer.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_event_execution_log (
  provider_event_id TEXT PRIMARY KEY,
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id),
  execution_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_event_execution_log_status
  ON webhook_event_execution_log(status);

CREATE OR REPLACE FUNCTION set_webhook_event_execution_log_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_webhook_event_execution_log_updated_at ON webhook_event_execution_log;

CREATE TRIGGER trg_webhook_event_execution_log_updated_at
  BEFORE UPDATE ON webhook_event_execution_log
  FOR EACH ROW EXECUTE FUNCTION set_webhook_event_execution_log_updated_at();

INSERT INTO schema_migrations (version, filename)
VALUES ('200', '200_webhook_event_execution_log.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
