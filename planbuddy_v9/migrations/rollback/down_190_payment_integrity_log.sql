-- Rollback for migration 190
BEGIN;
DROP TRIGGER IF EXISTS trg_payment_integrity_log_updated_at ON payment_integrity_log;
DROP FUNCTION IF EXISTS update_payment_integrity_log_updated_at();
DROP TABLE IF EXISTS payment_integrity_log;
DELETE FROM schema_migrations WHERE version = '190';
COMMIT;
