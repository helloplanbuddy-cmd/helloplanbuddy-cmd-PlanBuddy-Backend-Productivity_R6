-- Migration 004: Corrective migration for seat table and constraint chain
-- ============================================================================
-- CONTEXT:
--   The initial attempt at seat migration (001_add_seat_uniqueness_constraint.sql)
--   contained invalid SQL (UNIQUE constraint with WHERE clause) and incorrect
--   schema_migrations bookkeeping (used wrong column names).
--
--   This corrective migration ensures the schema is correct regardless of which
--   version of the migration chain a database has encountered:
--
--   - If a database ran the old broken 001_*, this ensures seats table and
--     constraint exist with correct definitions
--   - If a database ran the new corrected chain (001_create_seats_table,
--     002_add_seat_uniqueness_constraint, 003_noop), this is idempotent
--   - All schema_migrations records are harmonized to the new chain filenames

BEGIN;

-- ─── Ensure seats table exists with correct definition ──────────────────────
CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seat_number VARCHAR(10) NOT NULL,
  is_booked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- ─── Ensure seat_id column exists on bookings ─────────────────────────────────
ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS seat_id UUID REFERENCES seats(id) ON DELETE RESTRICT;

-- ─── Ensure correct unique constraint/index exists ───────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_seat_trip_date
ON bookings(seat_id, trip_id, travel_date)
WHERE status IN ('confirmed', 'pending', 'paid');

-- ─── Reconcile schema_migrations records ──────────────────────────────────────
-- If the old broken migration exists, remove it to avoid conflicts
DELETE FROM schema_migrations
WHERE filename = '001_add_seat_uniqueness_constraint.sql';

-- Ensure the new migration chain is recorded (idempotent)
INSERT INTO schema_migrations (version, filename, run_at)
VALUES 
  ('001', '001_create_seats_table.sql', NOW()),
  ('002', '002_add_seat_uniqueness_constraint.sql', NOW()),
  ('003', '003_seat_migration_noop.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- Record this corrective migration
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('004', '004_correct_seat_migration_chain.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
