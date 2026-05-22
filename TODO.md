# TODO (Migration 190 payment_integrity_log safety)

## Planned steps (no skipping)
1. [DONE] Inspect current migration file `planbuddy_v9/migrations/190_payment_integrity_log.sql`.
2. [DONE] Replace migration SQL with BIGINT-aligned schema (remove unsafe UUID/trigger/migration insert).
3. [PENDING] In Postgres `planbuddy_dev=#`, register migration version 190 into `schema_migrations` (exact INSERT from Phase 1 Step 2).
4. [PENDING] Verify registration with SELECT where version=190.
5. [PENDING] Validate system consistency in psql:
   - `\d+ payment_integrity_log`
   - index presence via pg_indexes
   - FK sanity check query
6. [PENDING] Test real purpose:
   - insert test row into `payment_integrity_log`
   - monitoring query count mismatch
7. [PENDING] Clean process automation (validation pipeline / step-by-step migration runner)


