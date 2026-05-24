'use strict';

/**
 * config/redis.js — Production Redis Client (v4.0-RESILIENT)
 *
 * PHASE 1 HARDENING — Runtime Resilience
 * ─────────────────────────────────────────────────────────────────────────────
 * Two clients are exported:
 *  - `redis`      — general-purpose client (caching, sessions, idempotency)
 *  - `redisQueue` — dedicated client for BullMQ (queues must not share a client
 *                   with general I/O — BullMQ uses BLPOP which blocks the connection)
 *
 * DESIGN CHANGES from v3.0:
 *  1. CIRCUIT BREAKER — After MAX_RECONNECT_ATTEMPTS, stops reconnecting for
 *     CIRCUIT_BREAKER_COOLDOWN_MS.  Prevents reconnect storms during outages.
 *  2. JITTER — Random ±25% on retry delays to prevent thundering herd when
 *     Redis comes back online after a cluster-wide outage.
 *  3. MAX RETRIES PER REQUEST — Cache client caps at 3 (fail-fast). Queue client
 *     keeps null (BullMQ requirement) but commands are isolated to queue client.
 *  4. OFFLINE QUEUE DISABLED — Cache client rejects commands immediately when
 *     disconnected. Prevents memory pressure from unbounded command buffers.
 *  5. CONNECT / COMMAND TIMEOUTS — Prevents hung connections from leaking pool slots.
 *  6. LAZY CONNECT for cache — Cache client connects on first use, not module load.
 *     Queue client connects eagerly (BullMQ Workers require it).
 *  7. DEGRADED STATE EXPOSURE — isHealthy() returns partial status for /health/ready.
 *
 * FAILURE POLICIES BY SUBSYSTEM:
 *  ┌──────────────────┬─────────────────┬──────────────────────────────────────┐
 *  │ Subsystem        │ Client          │ Failure Strategy                     │
 *  ├──────────────────┼─────────────────┼──────────────────────────────────────┤
 *  │ Cache            │ redis           │ fail-open (skip cache, serve req)    │
 *  │ Rate limit       │ rateLimitRedis  │ local MemoryStore fallback           │
 *  │ Queue workers    │ redisQueue      │ fail-closed (workers pause, retry)   │
 *  │ BullMQ jobs      │ redisQueue      │ fail-closed (job stalls, recovered)  │
 *  │ Sessions/Auth    │ redis           │ DB fallback (session re-auth)        │
 *  │ Idempotency      │ redis           │ DB fallback (no distributed lock)    │
 *  └──────────────────┴─────────────────┴──────────────────────────────────────┘
 */

const Redis = require('ioredis');
const env   = require('./env');

// ─── PHASE 3 WIRING: Queue Reliability State (Step 1 — Redis event hooks) ─────
const reliabilityState = require('../utils/queueReliabilityState');

// ─── Resilience tuning (override via env for load-testing) ────────────────────

const MAX_RECONNECT_ATTEMPTS    = parseInt(env.REDIS_MAX_RECONNECT_ATTEMPTS, 10)  || 20;
const CIRCUIT_BREAKER_COOLDOWN_MS = parseInt(env.REDIS_CIRCUIT_COOLDOWN_MS, 10) || 60_000;
const BASE_RETRY_MS             = parseInt(env.REDIS_BASE_RETRY_MS, 10)         || 100;
const MAX_RETRY_MS              = parseInt(env.REDIS_MAX_RETRY_MS, 10)          || 30_000;
const CONNECT_TIMEOUT_MS        = parseInt(env.REDIS_CONNECT_TIMEOUT_MS, 10)    || 5_000;
const COMMAND_TIMEOUT_MS        = parseInt(env.REDIS_COMMAND_TIMEOUT_MS, 10)    || 3_000;
const KEEP_ALIVE_MS             = parseInt(env.REDIS_KEEP_ALIVE_MS, 10)         || 30_000;

// ─── Per-client circuit-breaker state ─────────────────────────────────────────

const circuitState = new Map(); // name -> { open: boolean, openSince: number|null }

function isCircuitOpen(name) {
  const state = circuitState.get(name);
  if (!state || !state.open) return false;
  if (Date.now() - state.openSince >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    // Cooldown elapsed — half-open, allow one reconnect attempt
    state.open = false;
    state.openSince = null;
    state.attemptsSinceOpen = 0;
    return false;
  }
  return true;
}

function tripCircuit(name) {
  circuitState.set(name, { open: true, openSince: Date.now(), attemptsSinceOpen: 0 });
}

function recordAttempt(name, success) {
  const state = circuitState.get(name);
  if (!state) {
    circuitState.set(name, { open: false, openSince: null, attemptsSinceOpen: success ? 0 : 1 });
    return;
  }
  if (success) {
    state.attemptsSinceOpen = 0;
  } else {
    state.attemptsSinceOpen = (state.attemptsSinceOpen || 0) + 1;
    if (state.attemptsSinceOpen >= MAX_RECONNECT_ATTEMPTS) {
      tripCircuit(name);
    }
  }
}

// ─── Reconnect strategy with jitter and circuit breaker ───────────────────────

function reconnectStrategy(retries, name) {
  if (isCircuitOpen(name)) {
    return null; // ioredis: return null = stop reconnecting (emit 'end')
  }

  // Exponential backoff: 100ms, 200ms, 400ms ... capped at MAX_RETRY_MS
  const delay = Math.min(BASE_RETRY_MS * Math.pow(2, retries), MAX_RETRY_MS);

  // Jitter: ±25% randomisation to desynchronise reconnects across nodes
  const jitter = delay * 0.25;
  const jittered = Math.max(0, Math.floor(delay + (Math.random() * 2 - 1) * jitter));

  return jittered;
}

// ─── Client factory ───────────────────────────────────────────────────────────

function createClient(url, name, { isQueue = false } = {}) {
  const logger = require('../utils/logger');

  // Initialise circuit state
  if (!circuitState.has(name)) {
    circuitState.set(name, { open: false, openSince: null, attemptsSinceOpen: 0 });
  }

  const opts = {
    // ioredis parses the URL — TLS auto-enabled for rediss://
    lazyConnect:      !isQueue,   // Cache: connect on first use. Queue: eager.
    enableReadyCheck: true,
    connectTimeout:   CONNECT_TIMEOUT_MS,
    commandTimeout:   COMMAND_TIMEOUT_MS,
    keepAlive:        KEEP_ALIVE_MS,

    // Queue client: BullMQ requires null (infinite per-request retries handled by BullMQ).
    // Cache client: cap at 3 to fail fast — cache miss should not hang requests.
    maxRetriesPerRequest: isQueue ? null : 3,

    // Cache client: reject commands immediately when disconnected.
    // Queue client: allow offline queue so BullMQ can buffer job commands.
    enableOfflineQueue: isQueue,

    retryStrategy(times) {
      return reconnectStrategy(times, name);
    },

    reconnectOnError(err) {
      // Reconnect on READONLY errors (Redis Cluster failover)
      const shouldReconnect = err.message.includes('READONLY');
      if (shouldReconnect) {
        logger.warn(`[redis:${name}] READONLY error — forcing reconnect`);
      }
      return shouldReconnect;
    },
  };

  const client = new Redis(url, opts);

  client.on('connect', () => {
    recordAttempt(name, true);
    // PHASE 3: Update queue reliability state (Step 1 — Redis connected)
    if (name === 'queue') {
      reliabilityState.markRedisConnected();
    }
    logger.info(`[redis:${name}] Connected`);
  });

  client.on('ready', () => {
    logger.info(`[redis:${name}] Ready`);
  });

  client.on('error', (err) => {
    // Log but do not crash — app degrades gracefully without Redis
    // PHASE 3: Update queue reliability state (Step 1 — Redis error)
    if (name === 'queue') {
      reliabilityState.markRedisDisconnected(err.message);
    }
    logger.error({ err: err.message, code: err.code }, `[redis:${name}] Connection error`);
  });

  client.on('close', () => {
    // PHASE 3: Update queue reliability state (Step 1 — Redis closed)
    if (name === 'queue') {
      reliabilityState.markRedisDisconnected('client_close');
    }
    logger.warn(`[redis:${name}] Connection closed`);
  });

  client.on('reconnecting', (delay) => {
    recordAttempt(name, false);
    const state = circuitState.get(name);
    logger.warn(
      `[redis:${name}] Reconnecting in ${delay}ms (attempt ${state?.attemptsSinceOpen || '?'} / ${MAX_RECONNECT_ATTEMPTS})`
    );
  });

  client.on('end', () => {
    const state = circuitState.get(name);
    if (state?.open) {
      logger.error(
        `[redis:${name}] Connection ended — CIRCUIT OPEN (cooldown ${CIRCUIT_BREAKER_COOLDOWN_MS}ms)`
      );
    } else {
      logger.warn(`[redis:${name}] Connection ended (no more retries)`);
    }
  });

  return client;
}

// ─── Singleton instances ──────────────────────────────────────────────────────

const redis      = createClient(env.REDIS_URL,       'cache',  { isQueue: false });
const redisQueue = createClient(env.REDIS_QUEUE_URL, 'queue',  { isQueue: true });

// ─── Health probe — returns DEGRADED status, not boolean ──────────────────────

/**
 * Check health of both Redis clients.
 * Returns structured object for /health/ready degraded-state reporting.
 *
 * Example:
 *   { status: 'degraded', redis: 'ok', redisQueue: 'down', error: '...' }
 *   { status: 'ok',       redis: 'ok', redisQueue: 'ok' }
 */
async function isHealthy() {
  const start = Date.now();
  const results = {
    redis:      { status: 'unknown', latencyMs: 0 },
    redisQueue: { status: 'unknown', latencyMs: 0 },
  };

  // Check cache client
  const cacheStart = Date.now();
  try {
    if (redis.status === 'ready') {
      const pong = await redis.ping();
      if (pong === 'PONG') {
        results.redis = { status: 'ok', latencyMs: Date.now() - cacheStart };
      } else {
        results.redis = { status: 'error', latencyMs: Date.now() - cacheStart, error: `Unexpected PING: ${pong}` };
      }
    } else {
      results.redis = { status: 'down', latencyMs: Date.now() - cacheStart, error: `Status: ${redis.status}` };
    }
  } catch (err) {
    results.redis = { status: 'error', latencyMs: Date.now() - cacheStart, error: err.message };
  }

  // Check queue client
  const queueStart = Date.now();
  try {
    if (redisQueue.status === 'ready') {
      const pong = await redisQueue.ping();
      if (pong === 'PONG') {
        results.redisQueue = { status: 'ok', latencyMs: Date.now() - queueStart };
      } else {
        results.redisQueue = { status: 'error', latencyMs: Date.now() - queueStart, error: `Unexpected PING: ${pong}` };
      }
    } else {
      results.redisQueue = { status: 'down', latencyMs: Date.now() - queueStart, error: `Status: ${redisQueue.status}` };
    }
  } catch (err) {
    results.redisQueue = { status: 'error', latencyMs: Date.now() - queueStart, error: err.message };
  }

  // Overall status: cache can be down (degraded), queue down = degraded
  const allOk = results.redis.status === 'ok' && results.redisQueue.status === 'ok';
  const anyDown = results.redis.status !== 'ok' || results.redisQueue.status !== 'ok';

  return {
    status: allOk ? 'ok' : 'degraded',
    latencyMs: Date.now() - start,
    checks: results,
    error: anyDown
      ? `redis:${results.redis.status}, queue:${results.redisQueue.status}`
      : undefined,
  };
}

// ─── Graceful disconnect ──────────────────────────────────────────────────────

/**
 * Called during server shutdown. Closes both clients cleanly.
 */
async function disconnect() {
  await Promise.allSettled([
    redis.quit(),
    redisQueue.quit(),
  ]);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { redis, redisQueue, isHealthy, disconnect };
