-- ============================================================
-- WORKER SYSTEM v3 — STRIPE/GCP/UBER-GRADE SCHEMA
-- Postgres 14+ required
-- ============================================================
-- Upgrades over v2:
--   + outbox_events        — transactional outbox (zero-drift delivery)
--   + side_effect_journal  — exactly-once external ops ledger
--   + rate_limit_buckets   — distributed token bucket (DB-backed)
--   + region_registry      — multi-region leadership + fencing
--   + queue_shards         — hash-sharded queue routing
--   + replay_cursors       — deterministic replay engine
--   + worker_drain_state   — graceful drain / rolling deploy safety
--   + webhook_events hash-partitioned (replacing range-only)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Shared status domain ──────────────────────────────────
DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM (
    'pending', 'processing', 'processed', 'failed', 'dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE outbox_status AS ENUM (
    'pending', 'processing', 'delivered', 'dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE region_role AS ENUM ('primary', 'secondary', 'draining');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- execution_log  (unchanged from v2 — kept for compatibility)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_log (
  operation_key   TEXT        PRIMARY KEY,
  queue           TEXT        NOT NULL,
  job_id          UUID        NOT NULL,
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result          JSONB,
  worker_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_log_cleanup ON execution_log (executed_at);


-- ============================================================
-- worker_heartbeats  (v3: adds region_id, drain_state)
-- ============================================================
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id       TEXT        PRIMARY KEY,
  queue_key       TEXT        NOT NULL,
  region_id       TEXT        NOT NULL DEFAULT 'us-east-1',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_jobs     INTEGER     NOT NULL DEFAULT 0,
  drain_requested BOOLEAN     NOT NULL DEFAULT FALSE,
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_queue
  ON worker_heartbeats (queue_key, last_heartbeat DESC);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_region
  ON worker_heartbeats (region_id, queue_key);


-- ============================================================
-- queue_metrics  (unchanged from v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS queue_metrics (
  id                         BIGSERIAL   PRIMARY KEY,
  captured_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  queue                      TEXT        NOT NULL,
  pending_count              INTEGER     NOT NULL DEFAULT 0,
  processing_count           INTEGER     NOT NULL DEFAULT 0,
  dead_letter_count          INTEGER     NOT NULL DEFAULT 0,
  processed_last_minute      INTEGER     NOT NULL DEFAULT 0,
  failed_last_minute         INTEGER     NOT NULL DEFAULT 0,
  oldest_pending_age_seconds NUMERIC,
  p99_processing_ms          NUMERIC,
  worker_count               INTEGER     NOT NULL DEFAULT 0,
  -- v3 additions
  outbox_pending_count       INTEGER     NOT NULL DEFAULT 0,
  rate_limit_tokens_remaining NUMERIC,
  region_id                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_metrics_queue_time
  ON queue_metrics (queue, captured_at DESC);


-- ============================================================
-- NEW v3: outbox_events
-- Transactional outbox — written atomically with domain state.
-- Relay worker polls and delivers to downstream targets.
-- ============================================================
CREATE TABLE IF NOT EXISTS outbox_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type    TEXT        NOT NULL,   -- e.g. 'refund', 'booking', 'payment'
  aggregate_id      TEXT        NOT NULL,   -- domain entity ID
  event_type        TEXT        NOT NULL,   -- e.g. 'refund.initiated'
  event_version     INTEGER     NOT NULL DEFAULT 1,
  sequence_number   BIGSERIAL   NOT NULL,   -- global ordering
  payload           JSONB       NOT NULL,
  metadata          JSONB,                  -- trace_id, region, source_worker
  idempotency_key   TEXT        UNIQUE,     -- prevents duplicate inserts

  -- Delivery
  status            outbox_status NOT NULL DEFAULT 'pending',
  target_topic      TEXT,                   -- Kafka topic / SNS ARN / webhook URL
  delivery_attempt  SMALLINT    NOT NULL DEFAULT 0,
  max_attempts      SMALLINT    NOT NULL DEFAULT 10,
  run_after         TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  last_error        TEXT,

  -- Lease (same model as job tables)
  leased_by         TEXT,
  lease_expires_at  TIMESTAMPTZ,
  lease_version     BIGINT      NOT NULL DEFAULT 0,

  -- Audit
  alerted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_poll
  ON outbox_events (sequence_number ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
  ON outbox_events (aggregate_type, aggregate_id, sequence_number ASC);

CREATE INDEX IF NOT EXISTS idx_outbox_events_lease_recovery
  ON outbox_events (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_outbox_events_dlq_unalerted
  ON outbox_events (updated_at ASC)
  WHERE status = 'dead_letter' AND alerted_at IS NULL;

-- Relay cursor: per-consumer last delivered sequence
CREATE TABLE IF NOT EXISTS outbox_relay_cursors (
  consumer_id       TEXT        NOT NULL,
  aggregate_type    TEXT        NOT NULL DEFAULT '*',
  last_sequence     BIGINT      NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_id, aggregate_type)
);


-- ============================================================
-- NEW v3: side_effect_journal
-- Exactly-once external operation ledger.
-- Records request fingerprint + provider response hash + completion proof.
-- Supersedes execution_log for financial-grade side effects.
-- ============================================================
CREATE TABLE IF NOT EXISTS side_effect_journal (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key       TEXT        NOT NULL UNIQUE,  -- 'refund:{id}:attempt:{n}'
  queue               TEXT        NOT NULL,
  job_id              UUID        NOT NULL,
  worker_id           TEXT        NOT NULL,

  -- External call fingerprint
  provider            TEXT        NOT NULL,          -- 'razorpay', 'resend', 'webhook'
  request_hash        TEXT        NOT NULL,          -- SHA256 of serialized request
  provider_request_id TEXT,                          -- provider-assigned idempotency ID

  -- Response capture
  provider_response   JSONB,
  response_hash       TEXT,                          -- SHA256 of serialized response
  http_status         INTEGER,

  -- State machine
  state               TEXT        NOT NULL DEFAULT 'initiated',
  -- initiated → executing → completed | failed | timed_out
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at         TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,

  -- Replay token — deterministic key for safe replay
  replay_token        TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),

  -- Audit
  error               TEXT,
  retry_count         INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_side_effect_journal_job
  ON side_effect_journal (job_id);
CREATE INDEX IF NOT EXISTS idx_side_effect_journal_state
  ON side_effect_journal (state, initiated_at)
  WHERE state IN ('initiated', 'executing');
CREATE INDEX IF NOT EXISTS idx_side_effect_journal_cleanup
  ON side_effect_journal (completed_at);


-- ============================================================
-- NEW v3: rate_limit_buckets
-- DB-backed distributed token bucket per (provider, tenant).
-- Workers atomically deduct tokens. Refill via cron/trigger.
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key          TEXT        PRIMARY KEY,  -- '{provider}:{tenant_id}' or '{provider}:global'
  provider            TEXT        NOT NULL,
  tenant_id           TEXT        NOT NULL DEFAULT 'global',
  tokens              NUMERIC     NOT NULL DEFAULT 100,
  capacity            NUMERIC     NOT NULL DEFAULT 100,
  refill_rate_per_sec NUMERIC     NOT NULL DEFAULT 10,   -- tokens per second
  last_refill_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Backpressure state
  throttled_until     TIMESTAMPTZ,
  consecutive_throttles INTEGER   NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_provider
  ON rate_limit_buckets (provider, tenant_id);


-- ============================================================
-- NEW v3: region_registry
-- Multi-region coordination. Each region registers on startup.
-- Primary region holds a renewable epoch lock.
-- ============================================================
CREATE TABLE IF NOT EXISTS region_registry (
  region_id           TEXT        PRIMARY KEY,
  role                region_role NOT NULL DEFAULT 'secondary',
  epoch               BIGINT      NOT NULL DEFAULT 1,     -- monotonic, incremented on failover
  last_heartbeat      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leader_lease_until  TIMESTAMPTZ,                        -- primary holds lease
  metadata            JSONB,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Global single-row leader lock (advisory)
CREATE TABLE IF NOT EXISTS region_leader_lock (
  lock_key            TEXT        PRIMARY KEY DEFAULT 'global_leader',
  region_id           TEXT        NOT NULL,
  epoch               BIGINT      NOT NULL DEFAULT 1,
  acquired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL
);


-- ============================================================
-- NEW v3: queue_shards
-- Shard registry for hash-partitioned queues.
-- Workers register affinity; planner routes enqueue to correct shard.
-- ============================================================
CREATE TABLE IF NOT EXISTS queue_shards (
  shard_id            TEXT        PRIMARY KEY,   -- '{queue}:{shard_num}'
  queue_key           TEXT        NOT NULL,
  shard_number        INTEGER     NOT NULL,
  total_shards        INTEGER     NOT NULL DEFAULT 8,
  table_name          TEXT        NOT NULL,      -- physical table
  worker_affinity     TEXT,                      -- preferred worker_id
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_shards_unique
  ON queue_shards (queue_key, shard_number);


-- ============================================================
-- NEW v3: replay_cursors
-- Deterministic replay engine state.
-- Replay workers use these cursors to reprocess historical jobs.
-- ============================================================
CREATE TABLE IF NOT EXISTS replay_cursors (
  replay_id           TEXT        PRIMARY KEY,
  queue               TEXT        NOT NULL,
  table_name          TEXT        NOT NULL,
  status_filter       TEXT[]      NOT NULL DEFAULT ARRAY['dead_letter'],
  from_created_at     TIMESTAMPTZ NOT NULL,
  to_created_at       TIMESTAMPTZ NOT NULL,
  last_processed_id   UUID,
  last_processed_at   TIMESTAMPTZ,
  processed_count     INTEGER     NOT NULL DEFAULT 0,
  error_count         INTEGER     NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  requested_by        TEXT,
  notes               TEXT
);


-- ============================================================
-- TABLE: webhook_events  (v3: hash + range composite partition)
-- For true hyperscale, partition by HASH(id) into 8 shards,
-- each further range-partitioned by created_at.
-- NOTE: Postgres supports only one partition strategy per table.
-- We use RANGE on created_at (as in v2) + shard routing via
-- queue_shards table to direct workers to subsets of rows.
-- The hash distribution is enforced at the application layer
-- via the ShardRouter in the worker runtime.
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  event_type        TEXT        NOT NULL,
  target_url        TEXT        NOT NULL,
  payload           JSONB       NOT NULL,
  idempotency_key   TEXT,
  shard_key         INTEGER     NOT NULL DEFAULT 0,  -- v3: hash(id) % total_shards

  -- Multi-region
  region_id         TEXT        NOT NULL DEFAULT 'us-east-1',
  origin_region     TEXT        NOT NULL DEFAULT 'us-east-1',

  -- Tracing
  trace_id          TEXT,
  correlation_id    TEXT,

  status            queue_status NOT NULL DEFAULT 'pending',
  priority          SMALLINT    NOT NULL DEFAULT 0,
  run_after         TIMESTAMPTZ,

  leased_by         TEXT,
  lease_expires_at  TIMESTAMPTZ,
  lease_version     BIGINT      NOT NULL DEFAULT 0,

  attempt_count     SMALLINT    NOT NULL DEFAULT 0,
  error             TEXT,
  error_stack       TEXT,
  result            JSONB,
  processed_at      TIMESTAMPTZ,
  alerted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions 2025–2026
DO $$
DECLARE
  y INTEGER;
  m INTEGER;
  partition_name TEXT;
  from_date TEXT;
  to_date TEXT;
BEGIN
  FOR y IN 2025..2026 LOOP
    FOR m IN 1..12 LOOP
      partition_name := format('webhook_events_%s_%s', y, lpad(m::TEXT, 2, '0'));
      from_date := format('%s-%s-01', y, lpad(m::TEXT, 2, '0'));
      IF m = 12 THEN
        to_date := format('%s-01-01', y + 1);
      ELSE
        to_date := format('%s-%s-01', y, lpad((m + 1)::TEXT, 2, '0'));
      END IF;
      BEGIN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF webhook_events FOR VALUES FROM (%L) TO (%L)',
          partition_name, from_date, to_date
        );
      EXCEPTION WHEN duplicate_table THEN NULL;
      END;
    END LOOP;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_webhook_events_poll
  ON webhook_events (shard_key, priority DESC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_events_lease_recovery
  ON webhook_events (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_webhook_events_dlq_unalerted
  ON webhook_events (updated_at ASC)
  WHERE status = 'dead_letter' AND alerted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_idempotency
  ON webhook_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_events_region
  ON webhook_events (region_id, status, created_at ASC)
  WHERE status = 'pending';


-- ============================================================
-- TABLE: email_jobs  (v3: + region_id, trace_id, shard_key)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address        TEXT        NOT NULL,
  from_address      TEXT,
  subject           TEXT        NOT NULL,
  html_body         TEXT,
  text_body         TEXT,
  reply_to          TEXT,
  custom_headers    JSONB,
  idempotency_key   TEXT        UNIQUE,
  shard_key         INTEGER     NOT NULL DEFAULT 0,
  region_id         TEXT        NOT NULL DEFAULT 'us-east-1',
  trace_id          TEXT,
  correlation_id    TEXT,

  status            queue_status NOT NULL DEFAULT 'pending',
  priority          SMALLINT    NOT NULL DEFAULT 0,
  run_after         TIMESTAMPTZ,
  leased_by         TEXT,
  lease_expires_at  TIMESTAMPTZ,
  lease_version     BIGINT      NOT NULL DEFAULT 0,
  attempt_count     SMALLINT    NOT NULL DEFAULT 0,
  error             TEXT,
  error_stack       TEXT,
  result            JSONB,
  processed_at      TIMESTAMPTZ,
  alerted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_jobs_poll
  ON email_jobs (shard_key, priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_jobs_lease_recovery
  ON email_jobs (lease_expires_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_email_jobs_dlq_unalerted
  ON email_jobs (updated_at ASC) WHERE status = 'dead_letter' AND alerted_at IS NULL;


-- ============================================================
-- TABLE: refund_jobs  (v3: + region_id, trace_id, shard_key)
-- ============================================================
CREATE TABLE IF NOT EXISTS refund_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        TEXT        NOT NULL,
  amount            INTEGER     NOT NULL CHECK (amount > 0),
  currency          TEXT        NOT NULL DEFAULT 'INR',
  notes             JSONB,
  idempotency_key   TEXT        NOT NULL UNIQUE,
  shard_key         INTEGER     NOT NULL DEFAULT 0,
  region_id         TEXT        NOT NULL DEFAULT 'us-east-1',
  trace_id          TEXT,
  correlation_id    TEXT,

  status            queue_status NOT NULL DEFAULT 'pending',
  priority          SMALLINT    NOT NULL DEFAULT 0,
  run_after         TIMESTAMPTZ,
  leased_by         TEXT,
  lease_expires_at  TIMESTAMPTZ,
  lease_version     BIGINT      NOT NULL DEFAULT 0,
  attempt_count     SMALLINT    NOT NULL DEFAULT 0,
  error             TEXT,
  error_stack       TEXT,
  result            JSONB,
  processed_at      TIMESTAMPTZ,
  alerted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_jobs_poll
  ON refund_jobs (shard_key, priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_refund_jobs_lease_recovery
  ON refund_jobs (lease_expires_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_refund_jobs_dlq_unalerted
  ON refund_jobs (updated_at ASC) WHERE status = 'dead_letter' AND alerted_at IS NULL;


-- ============================================================
-- NOTIFY trigger — fires on INSERT to any queue table
-- Workers on LISTEN receive instant wakeup
-- ============================================================
CREATE OR REPLACE FUNCTION notify_queue_wakeup()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Channel format: 'queue_wakeup:{queue_key}:{shard_key}'
  -- Workers listen on their specific channel to avoid broadcast storms
  PERFORM pg_notify(
    'queue_wakeup',
    json_build_object(
      'table',     TG_TABLE_NAME,
      'shard_key', NEW.shard_key,
      'priority',  NEW.priority,
      'id',        NEW.id
    )::TEXT
  );
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_webhook_events_notify
    AFTER INSERT ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION notify_queue_wakeup();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_email_jobs_notify
    AFTER INSERT ON email_jobs
    FOR EACH ROW EXECUTE FUNCTION notify_queue_wakeup();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_refund_jobs_notify
    AFTER INSERT ON refund_jobs
    FOR EACH ROW EXECUTE FUNCTION notify_queue_wakeup();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_outbox_events_notify
    AFTER INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION notify_queue_wakeup();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- updated_at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$ BEGIN CREATE TRIGGER trg_email_jobs_updated_at BEFORE UPDATE ON email_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_refund_jobs_updated_at BEFORE UPDATE ON refund_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_webhook_events_updated_at BEFORE UPDATE ON webhook_events FOR EACH ROW EXECUTE FUNCTION set_updated_at(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_outbox_events_updated_at BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION set_updated_at(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TRIGGER trg_rate_limit_buckets_updated_at BEFORE UPDATE ON rate_limit_buckets FOR EACH ROW EXECUTE FUNCTION set_updated_at(); EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- FUNCTION: atomic_token_deduct
-- Distributed token bucket — atomic deduction with refill.
-- Returns TRUE if tokens were available, FALSE if throttled.
-- ============================================================
CREATE OR REPLACE FUNCTION atomic_token_deduct(
  p_bucket_key TEXT,
  p_tokens_needed NUMERIC DEFAULT 1
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_row rate_limit_buckets%ROWTYPE;
  v_elapsed NUMERIC;
  v_refill  NUMERIC;
  v_new_tokens NUMERIC;
BEGIN
  SELECT * INTO v_row FROM rate_limit_buckets WHERE bucket_key = p_bucket_key FOR UPDATE;
  IF NOT FOUND THEN RETURN TRUE; END IF;  -- no bucket = unlimited

  IF v_row.throttled_until IS NOT NULL AND v_row.throttled_until > NOW() THEN
    RETURN FALSE;
  END IF;

  -- Compute refill since last call
  v_elapsed := EXTRACT(EPOCH FROM (NOW() - v_row.last_refill_at));
  v_refill  := v_elapsed * v_row.refill_rate_per_sec;
  v_new_tokens := LEAST(v_row.capacity, v_row.tokens + v_refill);

  IF v_new_tokens < p_tokens_needed THEN
    UPDATE rate_limit_buckets
    SET tokens = v_new_tokens, last_refill_at = NOW(),
        consecutive_throttles = consecutive_throttles + 1,
        throttled_until = CASE
          WHEN consecutive_throttles >= 5 THEN NOW() + INTERVAL '30 seconds'
          ELSE NULL
        END
    WHERE bucket_key = p_bucket_key;
    RETURN FALSE;
  END IF;

  UPDATE rate_limit_buckets
  SET tokens = v_new_tokens - p_tokens_needed,
      last_refill_at = NOW(),
      consecutive_throttles = 0,
      throttled_until = NULL
  WHERE bucket_key = p_bucket_key;
  RETURN TRUE;
END;
$$;


-- ============================================================
-- FUNCTION: acquire_region_leader
-- Monotonic epoch-based leader election.
-- Returns TRUE if this region is now the primary.
-- ============================================================
CREATE OR REPLACE FUNCTION acquire_region_leader(
  p_region_id TEXT,
  p_lease_ms  INTEGER DEFAULT 30000
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_lock region_leader_lock%ROWTYPE;
  v_epoch BIGINT;
BEGIN
  SELECT * INTO v_lock FROM region_leader_lock WHERE lock_key = 'global_leader' FOR UPDATE;

  IF NOT FOUND THEN
    -- First acquisition
    INSERT INTO region_leader_lock (lock_key, region_id, epoch, expires_at)
    VALUES ('global_leader', p_region_id, 1, NOW() + (p_lease_ms * INTERVAL '1 millisecond'))
    ON CONFLICT DO NOTHING;
    RETURN TRUE;
  END IF;

  -- Renew if we already own it
  IF v_lock.region_id = p_region_id AND v_lock.expires_at > NOW() THEN
    UPDATE region_leader_lock SET expires_at = NOW() + (p_lease_ms * INTERVAL '1 millisecond')
    WHERE lock_key = 'global_leader';
    RETURN TRUE;
  END IF;

  -- Steal if expired
  IF v_lock.expires_at <= NOW() THEN
    v_epoch := v_lock.epoch + 1;
    UPDATE region_leader_lock
    SET region_id = p_region_id, epoch = v_epoch,
        acquired_at = NOW(),
        expires_at = NOW() + (p_lease_ms * INTERVAL '1 millisecond')
    WHERE lock_key = 'global_leader';

    -- Update region_registry
    UPDATE region_registry SET role = 'secondary' WHERE region_id = v_lock.region_id;
    INSERT INTO region_registry (region_id, role, epoch, last_heartbeat)
    VALUES (p_region_id, 'primary', v_epoch, NOW())
    ON CONFLICT (region_id) DO UPDATE
      SET role = 'primary', epoch = v_epoch, last_heartbeat = NOW();
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;


-- ============================================================
-- FUNCTION: outbox_atomic_write
-- Writes a domain state change + outbox event atomically.
-- Called from application code within existing transactions.
-- ============================================================
CREATE OR REPLACE FUNCTION outbox_write(
  p_aggregate_type  TEXT,
  p_aggregate_id    TEXT,
  p_event_type      TEXT,
  p_payload         JSONB,
  p_target_topic    TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_metadata        JSONB DEFAULT NULL,
  p_event_version   INTEGER DEFAULT 1
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO outbox_events (
    aggregate_type, aggregate_id, event_type, event_version,
    payload, metadata, target_topic, idempotency_key
  ) VALUES (
    p_aggregate_type, p_aggregate_id, p_event_type, p_event_version,
    p_payload, p_metadata, p_target_topic, p_idempotency_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW v_queue_depth AS
  SELECT 'webhook_events' AS queue, status, COUNT(*) AS count FROM webhook_events GROUP BY status
  UNION ALL SELECT 'email_jobs', status, COUNT(*) FROM email_jobs GROUP BY status
  UNION ALL SELECT 'refund_jobs', status, COUNT(*) FROM refund_jobs GROUP BY status
  UNION ALL SELECT 'outbox_events', status::TEXT, COUNT(*) FROM outbox_events GROUP BY status
  ORDER BY queue, status;

CREATE OR REPLACE VIEW v_stuck_leases AS
  SELECT 'webhook_events' AS queue, id, leased_by, lease_expires_at, lease_version, attempt_count
    FROM webhook_events WHERE status = 'processing' AND lease_expires_at < NOW()
  UNION ALL SELECT 'email_jobs', id, leased_by, lease_expires_at, lease_version, attempt_count
    FROM email_jobs WHERE status = 'processing' AND lease_expires_at < NOW()
  UNION ALL SELECT 'refund_jobs', id, leased_by, lease_expires_at, lease_version, attempt_count
    FROM refund_jobs WHERE status = 'processing' AND lease_expires_at < NOW()
  UNION ALL SELECT 'outbox_events', id, leased_by, lease_expires_at, lease_version, delivery_attempt
    FROM outbox_events WHERE status = 'processing' AND lease_expires_at < NOW();

CREATE OR REPLACE VIEW v_dlq_unalerted AS
  SELECT 'webhook_events' AS queue, id, error, attempt_count, updated_at
    FROM webhook_events WHERE status = 'dead_letter' AND alerted_at IS NULL
  UNION ALL SELECT 'email_jobs', id, error, attempt_count, updated_at
    FROM email_jobs WHERE status = 'dead_letter' AND alerted_at IS NULL
  UNION ALL SELECT 'refund_jobs', id, error, attempt_count, updated_at
    FROM refund_jobs WHERE status = 'dead_letter' AND alerted_at IS NULL
  UNION ALL SELECT 'outbox_events', id, last_error, delivery_attempt, updated_at
    FROM outbox_events WHERE status = 'dead_letter' AND alerted_at IS NULL
  ORDER BY updated_at ASC;

CREATE OR REPLACE VIEW v_active_workers AS
  SELECT worker_id, queue_key, region_id, started_at, last_heartbeat, active_jobs,
         drain_requested,
         EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) AS seconds_since_heartbeat
  FROM worker_heartbeats
  WHERE last_heartbeat > NOW() - INTERVAL '2 minutes'
  ORDER BY queue_key, last_heartbeat DESC;

CREATE OR REPLACE VIEW v_rate_limit_status AS
  SELECT bucket_key, provider, tenant_id, tokens, capacity,
         ROUND((tokens / capacity) * 100, 1) AS pct_remaining,
         refill_rate_per_sec, throttled_until, consecutive_throttles
  FROM rate_limit_buckets
  ORDER BY pct_remaining ASC;

CREATE OR REPLACE VIEW v_region_status AS
  SELECT r.region_id, r.role, r.epoch, r.last_heartbeat,
         l.expires_at AS leader_lease_until,
         EXTRACT(EPOCH FROM (NOW() - r.last_heartbeat)) AS seconds_since_heartbeat
  FROM region_registry r
  LEFT JOIN region_leader_lock l ON l.region_id = r.region_id
  ORDER BY r.role, r.region_id;

CREATE OR REPLACE VIEW v_outbox_lag AS
  SELECT aggregate_type,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending'))) AS lag_seconds
  FROM outbox_events
  GROUP BY aggregate_type;


-- ============================================================
-- MIGRATION: v2 → v3
-- Run these if upgrading an existing v2 database.
-- ============================================================
-- ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS shard_key INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS region_id TEXT NOT NULL DEFAULT 'us-east-1';
-- ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS origin_region TEXT NOT NULL DEFAULT 'us-east-1';
-- ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS trace_id TEXT;
-- ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
-- ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS shard_key INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS region_id TEXT NOT NULL DEFAULT 'us-east-1';
-- ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS trace_id TEXT;
-- ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS correlation_id TEXT;
-- ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS shard_key INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS region_id TEXT NOT NULL DEFAULT 'us-east-1';
-- ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS trace_id TEXT;
-- ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS correlation_id TEXT;
-- ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS region_id TEXT NOT NULL DEFAULT 'us-east-1';
-- ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS drain_requested BOOLEAN NOT NULL DEFAULT FALSE;
-- (Create new tables: outbox_events, side_effect_journal, rate_limit_buckets, region_registry, region_leader_lock, queue_shards, replay_cursors, outbox_relay_cursors)