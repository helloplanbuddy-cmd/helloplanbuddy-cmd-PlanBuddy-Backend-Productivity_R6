'use strict';

/**
 * scripts/healthcheck.js — Docker / Kubernetes Healthcheck (v2.0-RESILIENT)
 *
 * PHASE 1 HARDENING — Runtime Resilience
 * ─────────────────────────────────────────────────────────────────────────────
 * Used by:
 *   • Docker HEALTHCHECK
 *   • Kubernetes livenessProbe / readinessProbe (if not using HTTP directly)
 *
 * DESIGN CHANGE from v1.0:
 *   Redis is NO LONGER a hard dependency for this check.
 *   The container is healthy if the DB is reachable.
 *   Redis failures are logged as warnings but do NOT cause exit(1).
 *
 * Rationale:
 *   • During a Redis outage, the API still serves requests (cache miss → DB).
 *   • Killing the container because Redis is down creates MORE instability.
 *   • Queue workers pause during Redis outages — this is expected, not a failure.
 */

const db = require('../config/db');

(async () => {
  let dbOk = false;
  let redisOk = false;

  // 1. DB check — CRITICAL (exit 1 if down)
  try {
    await db.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    console.error(`Healthcheck FAILED: DB unreachable — ${err.message}`);
    process.exit(1);
  }

  // 2. Redis check — NON-CRITICAL (log warning, do NOT exit)
  try {
    const { redis } = require('../config/redis');
    if (redis && redis.status === 'ready') {
      const pong = await redis.ping();
      if (pong === 'PONG') {
        redisOk = true;
      } else {
        console.warn(`Healthcheck WARN: Redis unexpected PING response: ${pong}`);
      }
    } else {
      console.warn(`Healthcheck WARN: Redis status is ${redis?.status || 'unavailable'}`);
    }
  } catch (err) {
    console.warn(`Healthcheck WARN: Redis check failed — ${err.message}`);
  }

  // 3. Report and exit
  if (redisOk) {
    console.log('Healthcheck OK: DB + Redis healthy');
  } else {
    console.log('Healthcheck OK: DB healthy (Redis degraded — serving without cache)');
  }
  process.exit(0);
})();
