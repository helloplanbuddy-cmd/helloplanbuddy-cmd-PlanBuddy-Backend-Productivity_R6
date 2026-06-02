-- Migration 197: Normalize refund statuses and add CHECK constraint
-- Ensures refund.status only contains allowed values and enforces at DB level
BEGIN;

-- 1) Normalize any invalid refund statuses to 'created'
UPDATE refunds
SET status = 'created'
WHERE status IS NULL OR status NOT IN ('created','initiated','processed','failed','cancelled');

-- 2) Ensure idempotency_key duplicates handled (no-op if index exists)
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_payment_id_idempotency_key
ON refunds(payment_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- 3) Add CHECK constraint for refund status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refunds_status_check'
  ) THEN
    EXECUTE 'ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN (''created'',''initiated'',''processed'',''failed'',''cancelled''))';
  END IF;
END$$;

-- 4) Track migration
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('197', '197_add_refund_status_constraint.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
