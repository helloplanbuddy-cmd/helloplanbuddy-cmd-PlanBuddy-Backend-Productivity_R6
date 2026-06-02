-- Migration 201: Add refund status CHECK constraint for data integrity
-- ============================================================================
-- ISSUE: The refunds.status column lacks a CHECK constraint, allowing invalid
-- status values to be inserted if application logic fails.
--
-- This migration:
-- 1. Cleans up any test/invalid status values
-- 2. Adds the missing enum validation at the database layer

BEGIN;

-- Clean up any invalid status values (from testing)
-- Set to 'failed' as a safe default for unknown statuses
UPDATE refunds
SET status = 'failed'
WHERE status NOT IN (
  'created',      -- Refund initiated by user/system
  'initiated',    -- Refund sent to payment processor
  'processed',    -- Payment processor confirmed refund
  'failed',       -- Refund attempt failed (will retry or escalate)
  'cancelled'     -- Refund cancelled before processing
);

-- Add CHECK constraint to validate refund status
ALTER TABLE refunds
ADD CONSTRAINT refunds_status_check
CHECK (status IN (
  'created',      -- Refund initiated by user/system
  'initiated',    -- Refund sent to payment processor
  'processed',    -- Payment processor confirmed refund
  'failed',       -- Refund attempt failed (will retry or escalate)
  'cancelled'     -- Refund cancelled before processing
));

-- Record migration
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('201', '201_add_refund_status_check.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
