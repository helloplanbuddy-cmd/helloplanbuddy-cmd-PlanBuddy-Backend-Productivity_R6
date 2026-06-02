-- Migration 003: Seat migration placeholder
-- ============================================================================
-- This migration preserves the historic migration chain after reordering the
-- seat table and constraint migrations. It is intentionally a no-op for schema
-- changes and exists only to maintain linear migration history.

BEGIN;

INSERT INTO schema_migrations (version, filename)
VALUES ('003', '003_seat_migration_noop.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
