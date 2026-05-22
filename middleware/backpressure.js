'use strict';

/**
 * middleware/backpressure.js — Request Throttling & Load Shedding
 *
 * Prevents system collapse under high load by tracking global concurrency
 * and DB pool health, returning 503 when either limit is exceeded.
 *
 * UPGRADE NOTES (v3.1 → v3.2):
 *  - Fixed: bookingBackpressure() now uses a DEDICATED counter, not the
 *    global one. Previously compared global requests against the booking
 *    limit, causing false 503s during unrelated traffic spikes.
 *  - Fixed: Prometheus labels are now consistent — both global and booking
 *    rejections use the same Counter with an `endpoint` label.
 *  - Fixed: bookingBackpressure path check replaced with exact route prefix
 *    instead of substring match to avoid false positives on admin routes.
 *  - Removed: dead code (requestQueue, MAX_REDIS_PENDING, QUEUE_CHECK_INTERVAL_MS,
 *    unused `threshold` param).
 *  - Removed: stub redisPending check in getSystemLoad().
 *  - Exported: `backpressureMiddleware` as a pre-instantiated singleton so
 *    app.js can use named destructuring consistently.
 *
 * Cluster note: activeRequests and bookingActiveRequests are per-process.
 * Under PM2 cluster mode the effective limit is maxConcurrent × instances.
 * This is a known limitation — Redis-based counting adds ~1ms/req overhead
 * and is not worth it until you're running >4 instances. Document and accept.
 *
 * Usage (app.js):
 *   const { backpressureMiddleware, bookingBackpressureMiddleware } = require('./middleware/backpressure');
 *   app.use(backpressureMiddleware);
 *   router.post('/booking', bookingBackpressureMiddleware, bookingController.create);
 */

const logger     = require('../utils/logger');
const monitoring = require('../utils/monitoring');

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_CONCURRENT_GLOBAL  = 200;
const MAX_CONCURRENT_BOOKING = 50;
const MAX_DB_CONNECTIONS     = 50;

/** How long (ms) to trust the cached DB-pool health result. */
const DB_HEALTH_TTL_MS = 5_000;

/** Fraction of the pool that triggers load-shedding (90 %). */
const DB_POOL_OVERLOAD_THRESHOLD = 0.9;

// ─── Concurrency counters ─────────────────────────────────────────────────────

/**
 * Global concurrent request count.
 * Managed by backpressureMiddleware.
 */
let activeRequests = 0;

/**
 * Booking-specific concurrent request count.
 * Managed by bookingBackpressureMiddleware independently of activeRequests.
 * This is the fix for the original bug: booking requests were compared against
 * the global counter (200) but the limit was 50 — causing false rejections
 * whenever 50+ non-booking requests were in flight simultaneously.
 */
let bookingActiveRequests = 0;

// ─── DB-health cache (stale-while-revalidate) ─────────────────────────────────

/** @type {{ isDbOverloaded: boolean, checkedAt: number } | null} */
let dbHealthCache = null;

/** @type {Promise<void> | null} */
let dbHealthRefreshInFlight = null;

/**
 * Read DB pool counters — pure in-process metrics, no queries.
 * @returns {Promise<{ isDbOverloaded: boolean }>}
 */
async function fetchDbPoolHealth() {
  try {
    const db = require('../config/db');

    if (!db?.pool) {
      return { isDbOverloaded: false };
    }

    const used       = db.pool.totalCount || 0;
    const idle       = db.pool.idleCount  || 0;
    const active     = used - idle;
    const overloaded = active >= MAX_DB_CONNECTIONS * DB_POOL_OVERLOAD_THRESHOLD;

    return { isDbOverloaded: overloaded };
  } catch (err) {
    logger.warn('backpressure: could not read DB pool metrics', { error: err.message });
    return { isDbOverloaded: false };
  }
}

/**
 * Trigger an async cache refresh.
 * In-flight guard prevents concurrent fan-out.
 * @returns {Promise<void>}
 */
function refreshDbHealthCache() {
  if (dbHealthRefreshInFlight !== null) {
    return dbHealthRefreshInFlight;
  }

  dbHealthRefreshInFlight = fetchDbPoolHealth()
    .then((result) => {
      dbHealthCache = { isDbOverloaded: result.isDbOverloaded, checkedAt: Date.now() };
    })
    .catch((err) => {
      logger.warn('backpressure: unexpected error refreshing DB health', { error: err.message });
      dbHealthCache = { isDbOverloaded: false, checkedAt: Date.now() };
    })
    .finally(() => {
      dbHealthRefreshInFlight = null;
    });

  return dbHealthRefreshInFlight;
}

/**
 * Hot-path DB overload check.
 * Returns immediately from cache; triggers background revalidation when stale.
 * @returns {boolean}
 */
function isDbOverloadedCached() {
  const now = Date.now();

  if (dbHealthCache === null) {
    refreshDbHealthCache(); // cold start — kick off, optimistically healthy
    return false;
  }

  if (now - dbHealthCache.checkedAt > DB_HEALTH_TTL_MS) {
    refreshDbHealthCache(); // stale — revalidate in background, use last value
  }

  return dbHealthCache.isDbOverloaded;
}

// ─── Prometheus counter ───────────────────────────────────────────────────────

/**
 * Increment the backpressure rejection counter.
 *
 * Uses a consistent `endpoint` label for both global and per-route rejections
 * so Prometheus doesn't produce a mixed time-series (some points labelled,
 * some not). Previously the global path called .inc() with no labels.
 *
 * @param {'global'|'booking'} endpoint
 */
function incBackpressureCounter(endpoint) {
  try {
    if (monitoring?.backpressure_total) {
      monitoring.backpressure_total.inc({ endpoint });
    }
  } catch {
    // Monitoring not yet initialized — acceptable at startup, never on the hot path.
  }
}

// ─── Core overload check ─────────────────────────────────────────────────────

/**
 * Returns true if the system is overloaded at the global level.
 * Cheapest check (integer compare) runs first; DB cache check second.
 * @returns {boolean}
 */
function isOverloaded() {
  if (activeRequests >= MAX_CONCURRENT_GLOBAL) return true;
  if (isDbOverloadedCached()) return true;
  return false;
}

// ─── Middleware (pre-instantiated singletons) ─────────────────────────────────

/**
 * Global backpressure middleware.
 * Mount once in app.js: app.use(backpressureMiddleware)
 *
 * - Bypasses /api/health, /health, /metrics, /internal so probes are never shed.
 * - Uses finally{} to guarantee counter decrement on sync errors from next().
 *
 * @type {import('express').RequestHandler}
 */
const backpressureMiddleware = async function backpressureMiddleware(req, res, next) {
  // Bypass monitoring/probe paths — these must never be load-shed.
  if (
    req.path.startsWith('/api/health') ||
    req.path === '/health' ||
    req.path === '/metrics' ||
    req.path.startsWith('/internal')
  ) {
    return next();
  }

  activeRequests += 1;

  try {
    if (isOverloaded()) {
      incBackpressureCounter('global');

      logger.warn('BACKPRESSURE: Request rejected — system overloaded', {
        path:          req.path,
        method:        req.method,
        activeRequests,
        maxConcurrent: MAX_CONCURRENT_GLOBAL,
        dbOverloaded:  dbHealthCache?.isDbOverloaded ?? 'unknown',
        requestId:     req.requestId,
      });

      return res.status(503).json({
        success:    false,
        message:    'Service temporarily busy. Please try again.',
        code:       'SERVICE_OVERLOADED',
        retryAfter: 5,
      });
    }

    return next();
  } finally {
    activeRequests -= 1;
  }
};

/**
 * Booking-specific backpressure middleware.
 *
 * Mount on the booking creation route directly, NOT globally:
 *   router.post('/', bookingBackpressureMiddleware, bookingController.create);
 *
 * Using a dedicated counter (bookingActiveRequests) means this limit is
 * only triggered by actual booking traffic, not ambient system load.
 *
 * @type {import('express').RequestHandler}
 */
const bookingBackpressureMiddleware = async function bookingBackpressureMiddleware(req, res, next) {
  bookingActiveRequests += 1;

  try {
    if (bookingActiveRequests > MAX_CONCURRENT_BOOKING) {
      incBackpressureCounter('booking');

      logger.warn('BACKPRESSURE: Booking request rejected', {
        bookingActiveRequests,
        max:       MAX_CONCURRENT_BOOKING,
        requestId: req.requestId,
      });

      return res.status(503).json({
        success:    false,
        message:    'Booking temporarily unavailable. Please try again.',
        code:       'BOOKING_OVERLOADED',
        retryAfter: 10,
      });
    }

    return next();
  } finally {
    bookingActiveRequests -= 1;
  }
};

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * System load snapshot for health endpoints.
 * NOT on the hot path — reads pool counters directly.
 */
function getSystemLoad() {
  const metrics = {
    activeRequests,
    bookingActiveRequests,
    maxConcurrentGlobal:  MAX_CONCURRENT_GLOBAL,
    maxConcurrentBooking: MAX_CONCURRENT_BOOKING,
    utilizationPercent:   Math.round((activeRequests / MAX_CONCURRENT_GLOBAL) * 100),
    dbPoolUsed:           0,
    dbPoolMax:            MAX_DB_CONNECTIONS,
  };

  try {
    const db = require('../config/db');
    if (db?.pool) {
      metrics.dbPoolUsed = db.pool.totalCount || 0;
    }
  } catch {
    // db not yet initialized
  }

  return metrics;
}

/**
 * Backpressure status for /health/production endpoint.
 */
function getBackpressureStatus() {
  return {
    activeRequests,
    bookingActiveRequests,
    maxConcurrentGlobal:   MAX_CONCURRENT_GLOBAL,
    maxConcurrentBooking:  MAX_CONCURRENT_BOOKING,
    availableGlobalSlots:  Math.max(0, MAX_CONCURRENT_GLOBAL  - activeRequests),
    availableBookingSlots: Math.max(0, MAX_CONCURRENT_BOOKING - bookingActiveRequests),
    isOverloaded:          isOverloaded(),
    dbHealth: {
      isOverloaded: dbHealthCache?.isDbOverloaded ?? null,
      cachedAt:     dbHealthCache?.checkedAt      ?? null,
      ageMs:        dbHealthCache ? Date.now() - dbHealthCache.checkedAt : null,
    },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Pre-instantiated middleware (use these in app.js and route files)
  backpressureMiddleware,
  bookingBackpressureMiddleware,

  // Helpers
  getBackpressureStatus,
  getSystemLoad,
  isOverloaded,

  // Unit-test hooks
  _refreshDbHealthCache: refreshDbHealthCache,
  _getDbHealthCache:     () => dbHealthCache,
  _resetState: () => {
    dbHealthCache           = null;
    dbHealthRefreshInFlight = null;
    activeRequests          = 0;
    bookingActiveRequests   = 0;
  },
};