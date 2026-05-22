'use strict';

// ─── Queue identifiers ────────────────────────────────────────────────────────
const QUEUE_NAMES = {
  WEBHOOK_EVENTS:         'webhook-events',
  EMAIL_DISPATCH:         'email-dispatch',
  REFUND_RETRY:           'refund-retry',
  BOOKING_EXPIRY:         'booking-expiry',
  PAYMENT_RECONCILIATION: 'payment-reconciliation',
  OUTBOX_RELAY:           'outbox-relay',
};

// ─── Shard config ─────────────────────────────────────────────────────────────
const TOTAL_SHARDS = {
  WEBHOOK_EVENTS:         8,
  EMAIL_DISPATCH:         4,
  REFUND_RETRY:           2,
  BOOKING_EXPIRY:         2,
  PAYMENT_RECONCILIATION: 2,
  OUTBOX_RELAY:           4,
};

// ─── Concurrency (initial — adaptive controller adjusts at runtime) ───────────
const CONCURRENCY = {
  WEBHOOK_EVENTS:         10,
  EMAIL_DISPATCH:         5,
  REFUND_RETRY:           3,
  BOOKING_EXPIRY:         2,
  PAYMENT_RECONCILIATION: 2,
  OUTBOX_RELAY:           4,
};

const CONCURRENCY_MIN = {
  WEBHOOK_EVENTS:         1,
  EMAIL_DISPATCH:         1,
  REFUND_RETRY:           1,
  BOOKING_EXPIRY:         1,
  PAYMENT_RECONCILIATION: 1,
  OUTBOX_RELAY:           1,
};

const CONCURRENCY_MAX = {
  WEBHOOK_EVENTS:         40,
  EMAIL_DISPATCH:         20,
  REFUND_RETRY:           8,
  BOOKING_EXPIRY:         8,
  PAYMENT_RECONCILIATION: 8,
  OUTBOX_RELAY:           16,
};

// ─── Batch sizes ──────────────────────────────────────────────────────────────
const BATCH_SIZE = {
  WEBHOOK_EVENTS:         50,
  EMAIL_DISPATCH:         20,
  REFUND_RETRY:           10,
  BOOKING_EXPIRY:         100,
  PAYMENT_RECONCILIATION: 50,
  OUTBOX_RELAY:           100,
};

// ─── Poll intervals ───────────────────────────────────────────────────────────
// v3: With LISTEN/NOTIFY these are fallback intervals only.
const POLLING_INTERVAL_MS = {
  WEBHOOK_EVENTS:         500,
  EMAIL_DISPATCH:         1_000,
  REFUND_RETRY:           2_000,
  BOOKING_EXPIRY:         5_000,
  PAYMENT_RECONCILIATION: 5_000,
  OUTBOX_RELAY:           200,
};

// Fallback poll interval when LISTEN/NOTIFY is active (less aggressive)
const NOTIFY_FALLBACK_POLL_MS = {
  WEBHOOK_EVENTS:         5_000,
  EMAIL_DISPATCH:         10_000,
  REFUND_RETRY:           15_000,
  BOOKING_EXPIRY:         30_000,
  PAYMENT_RECONCILIATION: 30_000,
  OUTBOX_RELAY:           2_000,
};

// ─── Lease timeouts ───────────────────────────────────────────────────────────
const LEASE_TIMEOUT_MS = {
  WEBHOOK_EVENTS:         30_000,
  EMAIL_DISPATCH:         60_000,
  REFUND_RETRY:           120_000,
  BOOKING_EXPIRY:         55_000,
  PAYMENT_RECONCILIATION: 280_000,
  OUTBOX_RELAY:           30_000,
};

// ─── Heartbeat interval ───────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = {
  WEBHOOK_EVENTS:         10_000,
  EMAIL_DISPATCH:         20_000,
  REFUND_RETRY:           40_000,
  BOOKING_EXPIRY:         18_000,
  PAYMENT_RECONCILIATION: 90_000,
  OUTBOX_RELAY:           10_000,
};

// ─── Max processing time ─────────────────────────────────────────────────────
const MAX_PROCESSING_TIME_MS = {
  WEBHOOK_EVENTS:         25_000,
  EMAIL_DISPATCH:         50_000,
  REFUND_RETRY:           110_000,
  BOOKING_EXPIRY:         50_000,
  PAYMENT_RECONCILIATION: 270_000,
  OUTBOX_RELAY:           20_000,
};

// ─── Retry config ─────────────────────────────────────────────────────────────
const MAX_RETRY_ATTEMPTS = {
  WEBHOOK_EVENTS:         5,
  EMAIL_DISPATCH:         5,
  REFUND_RETRY:           5,
  BOOKING_EXPIRY:         5,
  PAYMENT_RECONCILIATION: 5,
  OUTBOX_RELAY:           10,
};

const RETRY_DELAY_BASELINE_MS = {
  WEBHOOK_EVENTS:         1_000,
  EMAIL_DISPATCH:         1_000,
  REFUND_RETRY:           2_000,
  BOOKING_EXPIRY:         1_000,
  PAYMENT_RECONCILIATION: 1_000,
  OUTBOX_RELAY:           500,
};

// ─── Stale threshold ──────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = {
  WEBHOOK_EVENTS:         60_000,
  EMAIL_DISPATCH:         120_000,
  REFUND_RETRY:           300_000,
  BOOKING_EXPIRY:         120_000,
  PAYMENT_RECONCILIATION: 600_000,
  OUTBOX_RELAY:           60_000,
};

const SCHEDULE_INTERVAL_MS = {
  BOOKING_EXPIRY:         60_000,
  PAYMENT_RECONCILIATION: 300_000,
};

// ─── Circuit breaker config ───────────────────────────────────────────────────
const CIRCUIT_BREAKER = {
  FAILURE_THRESHOLD: {
    WEBHOOK_EVENTS:         5,
    EMAIL_DISPATCH:         3,
    REFUND_RETRY:           3,
    BOOKING_EXPIRY:         3,
    PAYMENT_RECONCILIATION: 3,
    OUTBOX_RELAY:           5,
  },
  OPEN_TIMEOUT_MS: {
    WEBHOOK_EVENTS:         30_000,
    EMAIL_DISPATCH:         60_000,
    REFUND_RETRY:           120_000,
    BOOKING_EXPIRY:         30_000,
    PAYMENT_RECONCILIATION: 60_000,
    OUTBOX_RELAY:           15_000,
  },
  PROBE_COUNT: {
    WEBHOOK_EVENTS:         2,
    EMAIL_DISPATCH:         1,
    REFUND_RETRY:           1,
    BOOKING_EXPIRY:         1,
    PAYMENT_RECONCILIATION: 1,
    OUTBOX_RELAY:           2,
  },
};

// ─── Rate limiting config ─────────────────────────────────────────────────────
const RATE_LIMIT = {
  // Provider-level token buckets
  PROVIDERS: {
    razorpay: { capacity: 100, refillRatePerSec: 20 },
    resend:   { capacity: 200, refillRatePerSec: 50 },
    webhook:  { capacity: 500, refillRatePerSec: 100 },
  },
  // Whether to enforce rate limiting per queue
  ENABLED: {
    WEBHOOK_EVENTS:         true,
    EMAIL_DISPATCH:         true,
    REFUND_RETRY:           true,
    BOOKING_EXPIRY:         false,
    PAYMENT_RECONCILIATION: false,
    OUTBOX_RELAY:           false,
  },
  // Provider assignment per queue
  PROVIDER: {
    WEBHOOK_EVENTS:  'webhook',
    EMAIL_DISPATCH:  'resend',
    REFUND_RETRY:    'razorpay',
  },
};

// ─── Outbox config ────────────────────────────────────────────────────────────
const OUTBOX = {
  ENABLED: true,
  RELAY_BATCH_SIZE: 100,
  RELAY_POLL_MS: 200,
  MAX_DELIVERY_ATTEMPTS: 10,
  ORDERING: true, // enforce sequence_number ordering per aggregate
};

// ─── Region config ────────────────────────────────────────────────────────────
const REGION = {
  CURRENT: process.env.REGION_ID ?? 'us-east-1',
  LEADER_LEASE_MS: 30_000,
  HEARTBEAT_MS: 10_000,
  FAILOVER_TIMEOUT_MS: 60_000,
};

// ─── Observability ────────────────────────────────────────────────────────────
const METRICS_SNAPSHOT_INTERVAL_MS = 30_000;

// OpenTelemetry service name
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'worker-system-v3';

module.exports = {
  QUEUE_NAMES,
  TOTAL_SHARDS,
  CONCURRENCY,
  CONCURRENCY_MIN,
  CONCURRENCY_MAX,
  BATCH_SIZE,
  POLLING_INTERVAL_MS,
  NOTIFY_FALLBACK_POLL_MS,
  LEASE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_PROCESSING_TIME_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAY_BASELINE_MS,
  STALE_THRESHOLD_MS,
  SCHEDULE_INTERVAL_MS,
  CIRCUIT_BREAKER,
  RATE_LIMIT,
  OUTBOX,
  REGION,
  METRICS_SNAPSHOT_INTERVAL_MS,
  OTEL_SERVICE_NAME,
};