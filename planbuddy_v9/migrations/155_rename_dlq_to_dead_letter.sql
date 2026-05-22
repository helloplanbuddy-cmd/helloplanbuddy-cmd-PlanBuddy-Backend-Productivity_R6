-- Migration 155: Rename dlq_jobs to dead_letter_jobs for consistency (idempotent)
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dlq_jobs') AND
		 NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dead_letter_jobs') THEN
		ALTER TABLE dlq_jobs RENAME TO dead_letter_jobs;
	END IF;
END $$;
-- Update indexes if needed, but RENAME handles it