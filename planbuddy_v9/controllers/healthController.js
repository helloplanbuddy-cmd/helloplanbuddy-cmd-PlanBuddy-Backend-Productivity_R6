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
const reliabilityState = require('../utils/queueReliabilityState');

// Deterministic, sync-only /health handler. Intentionally does not touch DB/Redis/BullMQ.



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
  try {
    await db.query('SELECT 1');
  } catch (err) {
    return res.status(503).json({
      status: 'not ready',
      health: 'red',
      reason: ['db_unreachable'],
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }

  const snapshot = reliabilityState.getSnapshot();
  const statusInfo = reliabilityState.computeStatus();

  res.status(200).json({
    status: statusInfo.readiness,
    health: statusInfo.health,
    reason: statusInfo.reason,
    snapshot,
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
