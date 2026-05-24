CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

CREATE TABLE IF NOT EXISTS payment_integrity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,

  mismatch BOOLEAN NOT NULL DEFAULT false,
  mismatch_type VARCHAR(100),

  expected JSONB,
  actual JSONB,

  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_integrity_log_payment_id
ON payment_integrity_log(payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_integrity_log_mismatch_recent
ON payment_integrity_log(created_at DESC)
WHERE mismatch = true;

INSERT INTO schema_migrations (version, filename)
VALUES ('190', '190_payment_integrity_log.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;