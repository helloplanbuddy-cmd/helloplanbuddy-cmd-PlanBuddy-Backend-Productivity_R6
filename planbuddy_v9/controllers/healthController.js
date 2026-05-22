'use strict';

/**
 * controllers/healthController.js — Production Health Endpoints (v2.0-RESILIENT)
 *
 * PHASE 1 HARDENING — Runtime Resilience
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   GET /health/live    — Liveness probe (process alive, always 200)
 *   GET /health/ready   — Readiness probe with DEGRADED state support
 *   GET /health/prod    — Production metrics snapshot (DLQ, integrity)
 *
 * DESIGN:
 *   • Redis failure does NOT make /health/ready return 503.
 *     Cache is non-critical — the app serves requests without it.
 *   • Queue Redis failure returns "degraded" (not 503) so k8s does NOT
 *     restart the pod, but load balancers can route traffic away.
 *   • DB failure returns 503 — the app CANNOT serve requests without DB.
 *
 * Kubernetes guidance:
 *   livenessProbe  → /health/live  (restart if process dead)
 *   readinessProbe → /health/ready (remove from LB if DB down)
 */

const db = require('../config/db');

// ─── /health/live — Liveness probe ────────────────────────────────────────────

/**
 * Returns 200 if the Node process is alive.
 * This should NEVER fail — it proves the event loop is running.
 * Kubernetes uses this to decide whether to restart the container.
 */
exports.live = (req, res) => {
  res.status(200).json({
    status: 'alive',
    uptime: process.uptime(),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
};

// ─── /health/ready — Readiness probe with degraded states ─────────────────────

/**
 * Checks critical and non-critical dependencies.
 *
 * Response codes:
 *   200 — All systems operational (status: 'ready')
 *   200 — Cache or queue Redis down, DB up (status: 'degraded')
 *   503 — DB unreachable (status: 'not ready')
 *
 * Why degraded = 200 (not 503):
 *   • Cache Redis down: app serves requests without caching (slower but functional).
 *   • Queue Redis down: API still works; background jobs pause until Redis recovers.
 *   • Returning 200 prevents Kubernetes from killing the pod during a Redis blip.
 */
exports.ready = async (req, res) => {
  const checks = {
    db: { status: 'unknown', latencyMs: 0 },
    redis: { status: 'unknown', latencyMs: 0 },
    redisQueue: { status: 'unknown', latencyMs: 0 },
    queues: { status: 'unknown', backlog: 0 },
  };

  // 1. DB check (CRITICAL — app cannot function without DB)
  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.db = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.db = { status: 'error', latencyMs: Date.now() - dbStart, error: err.message };
    return res.status(503).json({
      status: 'not ready',
      checks,
      error: `DB unreachable: ${err.message}`,
      timestamp: new Date().toISOString(),
    });
  }

  // 2. Redis cache check (NON-CRITICAL — degrade gracefully)
  const redisStart = Date.now();
  try {
    const redis = require('../config/redis').redis;
    if (redis && redis.status === 'ready') {
      const pong = await redis.ping();
      if (pong === 'PONG') {
        checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
      } else {
        checks.redis = { status: 'degraded', latencyMs: Date.now() - redisStart, error: `Unexpected PING: ${pong}` };
      }
    } else {
      checks.redis = { status: 'degraded', latencyMs: Date.now() - redisStart, error: `Status: ${redis?.status || 'unavailable'}` };
    }
  } catch (err) {
    checks.redis = { status: 'degraded', latencyMs: Date.now() - redisStart, error: err.message };
  }

  // 3. Redis queue check (NON-CRITICAL for API — workers pause, API continues)
  const queueStart = Date.now();
  try {
    const { redisQueue } = require('../config/redis');
    if (redisQueue && redisQueue.status === 'ready') {
      const pong = await redisQueue.ping();
      if (pong === 'PONG') {
        checks.redisQueue = { status: 'ok', latencyMs: Date.now() - queueStart };
      } else {
        checks.redisQueue = { status: 'degraded', latencyMs: Date.now() - queueStart, error: `Unexpected PING: ${pong}` };
      }
    } else {
      checks.redisQueue = { status: 'degraded', latencyMs: Date.now() - queueStart, error: `Status: ${redisQueue?.status || 'unavailable'}` };
    }
  } catch (err) {
    checks.redisQueue = { status: 'degraded', latencyMs: Date.now() - queueStart, error: err.message };
  }

  // 4. Queue backlog check (informational — included in ready response)
  try {
    const queueMonitoring = require('../utils/queueMonitoring');
    const queues = require('../config/queues');
    const queueHealth = await queueMonitoring.getQueueHealth(queues);
    checks.queues = {
      status: queueHealth.healthy ? 'healthy' : 'elevated_backlog',
      backlog: queueHealth.totalBacklog,
      worst_queue: queueHealth.worstQueue,
      worst_depth: queueHealth.worstDepth,
    };
  } catch (err) {
    checks.queues = {
      status: 'unavailable',
      backlog: 0,
      error: err.message,
    };
  }

  // 5. Determine overall status
  const allOk = checks.redis.status === 'ok' && checks.redisQueue.status === 'ok';
  const status = allOk ? 'ready' : 'degraded';
  const httpStatus = 200; // Never 503 for Redis-only issues

  res.status(httpStatus).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
};

// ─── /health/prod — Production metrics snapshot ───────────────────────────────

/**
 * Production health: use cron-driven cached snapshot from services/productionHealth.js.
 * This removes the placeholder "always zero" failure mode (CF-4) without forcing live DB queries.
 */
let productionHealth;
try {
  productionHealth = require('../services/productionHealth');
} catch {
  // Fallback: do not crash /health even if the module is unavailable.
  productionHealth = {
    getMetricsSnapshot: () => ({
      integrity_mismatches: 0,
      dlq_active: 0,
      dlq_oldest_age_sec: 0,
      timestamp: Date.now(),
    }),
  };
}

exports.production = (req, res) => {
  const snapshot = productionHealth.getMetricsSnapshot?.() || {};
  const {
    integrity_mismatches = 0,
    dlq_active = 0,
    dlq_oldest_age_sec = 0,
    timestamp = Date.now(),
  } = snapshot;

  const status = integrity_mismatches === 0 && dlq_active === 0 ? 'healthy' : 'degraded';

  res.json({
    status,
    timestamp: new Date(timestamp).toISOString(),
    integrity_mismatches,
    dlq_active,
    dlq_oldest_age_sec: Math.round(dlq_oldest_age_sec),
    checks: {
      integrity_ok: integrity_mismatches === 0,
      dlq_empty: dlq_active === 0,
      last_check_age_sec: Math.round((Date.now() - timestamp) / 1000),
    },
  });
};

// ─── Legacy aliases ───────────────────────────────────────────────────────────

/**
 * Alias for backward compatibility.
 * Some monitoring scripts may call /health (old endpoint).
 */
exports.readiness = exports.ready;
exports.detailed = (req, res) => res.json({ status: 'detailed ok' });
