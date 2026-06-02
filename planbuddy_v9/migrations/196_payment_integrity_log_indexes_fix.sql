-- Migration 196: Repair payment_integrity_log missing indexes
-- Adds indexes required by services/productionHealth.js
-- Table payment_integrity_log is assumed to already exist.

BEGIN;

-- Idempotent index creation: if index exists, CREATE INDEX IF NOT EXISTS will skip.

CREATE INDEX IF NOT EXISTS idx_payment_integrity_log_mismatch_recent
  ON payment_integrity_log (mismatch, created_at DESC)
  WHERE mismatch = true;

CREATE INDEX IF NOT EXISTS idx_payment_integrity_log_payment_id
  ON payment_integrity_log (payment_id);

-- Self-verification (hard fail if indexes still missing)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='idx_payment_integrity_log_mismatch_recent'
  ) THEN
    RAISE EXCEPTION 'MIGRATION INTEGRITY FAILURE: missing idx_payment_integrity_log_mismatch_recent';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='idx_payment_integrity_log_payment_id'
  ) THEN
    RAISE EXCEPTION 'MIGRATION INTEGRITY FAILURE: missing idx_payment_integrity_log_payment_id';
  END IF;
END;
$$;

INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('196', '196_payment_integrity_log_indexes_fix.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
