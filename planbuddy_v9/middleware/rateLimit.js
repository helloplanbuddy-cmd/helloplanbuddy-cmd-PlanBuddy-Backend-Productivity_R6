'use strict';

/**
 * middleware/rateLimit.js — Redis-Backed Rate Limiting (v4.1)
 *
 * FIXES from v4.0 audit (2026-05-14):
 *
 *  FIX-1 — skip() path mismatch (BUG, was silent health-probe failure)
 *    v4.0 checked req.path.startsWith('/api/health') inside both the
 *    express-rate-limit skip() and the failClosedMiddleware wrapper.
 *    When globalLimiter is mounted at app.use('/api', ...), Express sets
 *    req.path to the suffix AFTER the mount point — so a request to
 *    /api/health arrives with req.path === '/health', never matching
 *    '/api/health'. Health probes would consume rate-limit budget (or get
 *    503 from fail-closed) during Redis downtime.
 *    Fixed: all skip/bypass checks now use req.path === '/health'
 *    (the post-mount suffix). req.originalUrl checks are added as fallback
 *    for any limiter mounted at root.
 *
 *  FIX-2 — Webhook path not excluded from globalLimiter (CRITICAL)
 *    v4.0 introduced webhookLimiter with correct thresholds, but globalLimiter
 *    (mounted at /api/*) still consumed Razorpay's delivery IPs' budget first.
 *    Under payment volume the global 500/15min/IP ceiling could be exhausted
 *    by webhook retries before webhookLimiter even ran. globalLimiter now has
 *    an explicit skip() for the Razorpay webhook path.
 *
 *  FIX-3 — Dedicated per-limiter Prometheus counter (R-3 completion)
 *    v4.0 reused request_total{path:'rate_limited'} — losing per-limiter
 *    visibility. Replaced with rate_limit_hits_total{limiter, method, path}
 *    Gauge. Grafana can now alert on "auth limiter > 50 hits/min" independently
 *    of booking or webhook limiters.
 *
 *  FIX-4 — Separate Redis connection for rate limiting (R-5)
 *    v4.0 shared the main application Redis client (used by BullMQ, sessions).
 *    A rate-limit query flood could starve queue workers. Rate limiting now
 *    uses a dedicated ioredis instance from config/rateLimitRedis.js.
 *
 *  FIX-5 — User-ID key on authenticated routes (R-4 partial mitigation)
 *    bookingLimiter, verifyPaymentLimiter, adminLimiter already used userKey.
 *    This is correct. Documented explicitly below. The remaining IP-spoofing
 *    risk (X-Forwarded-For with direct TCP access) is a network/firewall
 *    concern and cannot be addressed in Express — see app.js SECURITY NOTE.
 *
 * Limiter inventory (v4.1):
 *  ┌──────────────────────────┬──────────────────────────┬────────────────┐
 *  │ Limiter                  │ Threshold                │ Fail policy    │
 *  ├──────────────────────────┼──────────────────────────┼────────────────┤
 *  │ globalLimiter            │ 500 req / 15 min / IP    │ open (MemStore)│
 *  │ authLimiter              │  20 req / 15 min / IP    │ CLOSED → 503   │
 *  │ bookingLimiter           │  10 req /  1 min / user  │ open (MemStore)│
 *  │ verifyPaymentLimiter     │  10 req /  1 min / user  │ CLOSED → 503   │
 *  │ webhookLimiter           │ 100 req /  1 min / IP    │ CLOSED → 503   │
 *  │ adminLimiter             │ 100 req / 15 min / user  │ open (MemStore)│
 *  │ idempotencyConflictLimtr │   3 req /  5 min / IP    │ open (MemStore)│
 *  └──────────────────────────┴──────────────────────────┴────────────────┘
 */

const rateLimit      = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger         = require('../utils/logger');
const monitoring     = require('../utils/monitoring');

// ─── Dedicated Redis client for rate limiting (FIX-4) ────────────────────────
// Separate from the main app Redis (BullMQ, sessions) so rate-limit ops
// cannot starve queue workers under traffic spikes.
// config/rateLimitRedis.js should export a single ioredis instance.
// If the module is absent (e.g. test environments), we fall back gracefully.
function getRateLimitRedis() {
  try {
    const { rateLimitRedis } = require('../config/rateLimitRedis');
    return rateLimitRedis;
  } catch {
    // Fallback: use main redis. Logs a warning so this is visible in prod.
    logger.warn(
      { service: 'rateLimit' },
      '[rateLimit] config/rateLimitRedis.js not found — falling back to main redis client. ' +
      'Create a dedicated client to isolate rate-limit ops from BullMQ.'
    );
    try {
      const { redis } = require('../config/redis');
      return redis;
    } catch {
      return null;
    }
  }
}

// ─── Redis store adapter ──────────────────────────────────────────────────────

/**
 * Build a RedisStore for the given prefix using the rate-limit-dedicated client.
 * Returns undefined if unavailable — express-rate-limit falls back to MemoryStore.
 */
function makeRedisStore(prefix) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const redisClient    = getRateLimitRedis();

    if (!redisClient) {
      throw new Error('No Redis client available');
    }

    if (redisClient.status !== 'ready') {
      throw new Error(`Rate limit Redis not ready (status=${redisClient.status})`);
    }

    return new RedisStore({
      prefix,
      sendCommand: (...args) => redisClient.call(...args),
    });
  } catch (err) {
    logger.error(
      { service: 'rateLimit', err: err.message },
      '[rateLimit] WARN: Could not create RedisStore — non-critical limiters will use MemoryStore'
    );
    monitoring.security_alerts_total?.inc({ type: 'rate_limit_store_fallback' });
    return undefined;
  }
}

// ─── Redis health check ───────────────────────────────────────────────────────

/**
 * Check whether the rate-limit Redis client is in a usable state.
 * Uses the dedicated rateLimitRedis client (FIX-4), not the main redis.
 * ioredis .status is synchronous — no await needed.
 */
function isRedisReady() {
  try {
    const redisClient = getRateLimitRedis();
    return redisClient?.status === 'ready';
  } catch {
    return false;
  }
}

// ─── Path helpers (FIX-1) ─────────────────────────────────────────────────────

/**
 * Returns true for paths that must never be rate-limited or blocked.
 *
 * CRITICAL: When a limiter is mounted at app.use('/api', limiter), Express
 * strips the mount prefix — req.path is '/health', NOT '/api/health'.
 * Checking req.path.startsWith('/api/health') silently fails in that context.
 * We check both req.path and req.originalUrl to handle both mounted and
 * root-mounted limiters correctly.
 */
function isBypassPath(req) {
  const p = req.path;
  const o = req.originalUrl?.split('?')[0] ?? '';
  return (
    p === '/health' ||
    p === '/api/health' ||
    p === '/internal' ||
    p === '/metrics' ||
    p === '/' ||
    o === '/health' ||
    o === '/api/health' ||
    o === '/internal' ||
    o === '/metrics'
  );
}

/**
 * Returns true for Razorpay webhook delivery paths.
 * Used by globalLimiter's skip() to exclude webhook traffic from the
 * global IP budget (FIX-2). webhookLimiter provides its own tighter
 * threshold on these routes.
 */
function isWebhookPath(req) {
  const p = req.path;
  const o = req.originalUrl?.split('?')[0] ?? '';
  return (
    p.includes('/payment/webhook') ||
    o.includes('/payment/webhook')
  );
}

// ─── Key generators ───────────────────────────────────────────────────────────

/** IP-based key — for unauthenticated routes (auth, global). */
const ipKey = (req) => ipKeyGenerator(req.ip);

/**
 * User-ID key for authenticated routes — avoids punishing shared corporate
 * NAT / CGNAT IPs. Falls back to IP if the route hasn't run authMiddleware yet.
 */
const userKey = (req) => req.user?.id || ipKeyGenerator(req.ip);

// ─── Prometheus counter (FIX-3) ───────────────────────────────────────────────

/**
 * Increment the dedicated rate_limit_hits_total counter.
 * monitoring.rate_limit_hits_total must be a Counter with labels
 * { limiter, method, path }. If the counter doesn't exist yet (e.g. older
 * monitoring.js), falls back to the existing request_total metric.
 */
function recordRateLimitHit(req, limiterName) {
  if (monitoring.rate_limit_hits_total) {
    monitoring.rate_limit_hits_total.inc({
      limiter: limiterName,
      method:  req.method,
      path:    req.route?.path ?? 'unknown',
    });
  } else {
    // Backward-compat fallback — remove once monitoring.js is updated
    monitoring.request_total?.inc({ method: req.method, path: 'rate_limited' });
  }
}

// ─── Rate-limit exceeded handler ──────────────────────────────────────────────

function onLimitExceeded(req, res, windowMs, limiterName) {
  logger.warn({
    requestId: req.requestId,
    ip:        req.ip,
    userId:    req.user?.id,
    path:      req.path,
    limiter:   limiterName,
  }, '[rateLimit] Rate limit exceeded');

  recordRateLimitHit(req, limiterName);

  return res.status(429).json({
    success:    false,
    message:    'Too many requests. Please try again later.',
    code:       'RATE_LIMIT_EXCEEDED',
    retryAfter: Math.ceil(windowMs / 1000),
  });
}

// ─── Limiter factory ──────────────────────────────────────────────────────────

/**
 * Create a rate limiter middleware.
 *
 * @param {object}   options
 * @param {string}   options.name           - Limiter name (metrics/logs)
 * @param {number}   options.windowMs       - Rate window in milliseconds
 * @param {number}   options.max            - Max requests per window
 * @param {Function} [options.keyGenerator] - Key fn (default: IP)
 * @param {boolean}  [options.failClosed]   - true → 503 when Redis down
 *                                            false → MemoryStore fallback
 * @param {Function} [options.extraSkip]    - Additional skip() predicate
 */
function makeLimiter({
  name,
  windowMs,
  max,
  keyGenerator = ipKey,
  failClosed   = false,
  extraSkip    = null,
}) {
  const store = makeRedisStore(`rl:${name}:`);

  const limiter = rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,   // Emits RateLimit-* + Retry-After (RFC 6585)
    legacyHeaders:   false,
    store,
    handler(req, res) {
      return onLimitExceeded(req, res, windowMs, name);
    },
    // FIX-1: use isBypassPath() — correctly handles both mounted and root contexts
    skip(req) {
      if (isBypassPath(req)) return true;
      if (extraSkip && extraSkip(req)) return true;
      return false;
    },
  });

  Object.defineProperty(limiter, 'name', {
    value: name,
    configurable: true,
  });

  if (!failClosed) {
    return limiter;
  }

  // ── Fail-closed wrapper ────────────────────────────────────────────────────
  // For auth/payment/webhook: Redis down → 503 (no brute-force bypass).
  const failClosedMiddleware = function (req, res, next) {
    // FIX-1: same isBypassPath() guard (was broken in v4.0)
    if (isBypassPath(req)) {
      return next();
    }

    if (!isRedisReady()) {
      const redisStatus = (() => {
        try {
          return getRateLimitRedis()?.status ?? 'unavailable';
        } catch {
          return 'unavailable';
        }
      })();

      logger.error({
        limiter:     name,
        redisStatus,
        ip:          req.ip,
        path:        req.path,
        requestId:   req.requestId,
      }, `[rateLimit] FAIL-CLOSED: Redis unavailable — blocking critical endpoint "${name}"`);

      monitoring.security_alerts_total?.inc({ type: 'rate_limit_fail_closed_triggered' });

      return res.status(503).json({
        success:    false,
        code:       'SERVICE_UNAVAILABLE',
        message:    'Service temporarily unavailable. Please retry in a moment.',
        retryAfter: 30,
      });
    }

    return limiter(req, res, next);
  };

  Object.defineProperty(failClosedMiddleware, 'name', {
    value: name,
    configurable: true,
  });

  return failClosedMiddleware;
}

// ─── Limiter instances ────────────────────────────────────────────────────────

/**
 * Global limiter — all /api/* routes.
 * Fail-open (availability > enforcement for non-security paths).
 *
 * FIX-2: extraSkip excludes Razorpay webhook paths from the global IP budget.
 * webhookLimiter (fail-closed, 100/min) provides dedicated control on those routes.
 * Without this exclusion, Razorpay's delivery IPs can exhaust the 500/15min global
 * ceiling during a payment spike, causing a retry storm and stalling bookings.
 */
const _globalLimiter = makeLimiter({
  name:         'global',
  windowMs:     15 * 60 * 1000,
  max:          500,
  keyGenerator: ipKey,
  failClosed:   false,
  extraSkip:    isWebhookPath,   // ← FIX-2
});
const globalLimiter = (req, res, next) => {
  console.log(`[TRACE:${req.requestId}] globalLimiter EXECUTED`);
  return _globalLimiter(req, res, next);
};

/**
 * Auth limiter — login, register, OTP verification.
 * FAIL-CLOSED: Redis down → 503. Brute-force protection must not be bypassed.
 * Key: IP (unauthenticated context — user ID not yet established).
 */
const authLimiter = makeLimiter({
  name:         'auth',
  windowMs:     15 * 60 * 1000,
  max:          20,
  keyGenerator: ipKey,
  failClosed:   true,
});

/**
 * Booking limiter — booking creation.
 * Fail-open. Key: user ID (avoids blocking shared-IP corporate users).
 */
const bookingLimiter = makeLimiter({
  name:         'booking',
  windowMs:     60 * 1000,
  max:          10,
  keyGenerator: userKey,
  failClosed:   false,
});

/**
 * Payment verify limiter.
 * FAIL-CLOSED: Redis down → 503.
 * Key: user ID — per-user enforcement on a financial endpoint.
 */
const verifyPaymentLimiter = makeLimiter({
  name:         'verify-payment',
  windowMs:     60 * 1000,
  max:          10,
  keyGenerator: userKey,
  failClosed:   true,
});

/**
 * Webhook limiter — Razorpay webhook endpoint.
 * FAIL-CLOSED: Redis down → 503.
 * Key: IP (Razorpay delivery infrastructure, not authenticated users).
 * Threshold: 100/min per IP — accommodates burst delivery without blocking
 * legitimate retries from Razorpay's server pool.
 *
 * NOTE: globalLimiter skips this path (FIX-2), so webhookLimiter is the sole
 * rate-control layer for /api/v1/payment/webhook/razorpay.
 */
const webhookLimiter = makeLimiter({
  name:         'webhook',
  windowMs:     60 * 1000,
  max:          100,
  keyGenerator: ipKey,
  failClosed:   true,
});

/**
 * Admin limiter — dashboard + export routes.
 * Fail-open (admin downtime > imperfect limiting).
 * Key: user ID.
 */
const adminLimiter = makeLimiter({
  name:         'admin',
  windowMs:     15 * 60 * 1000,
  max:          100,
  keyGenerator: userKey,
  failClosed:   false,
});

const adminReconcile = adminLimiter;

/**
 * Idempotency conflict limiter — repeated conflicting idempotency keys.
 * Fail-open. Key: IP (not yet authenticated at conflict detection point).
 *
 * CAUTION: 3 req / 5 min is tight. Verify the frontend never generates
 * more than 3 idempotency conflicts in 5 minutes under normal retry logic.
 */
const idempotencyConflictLimiter = makeLimiter({
  name:         'idempotency_conflict',
  windowMs:     5 * 60 * 1000,
  max:          3,
  keyGenerator: ipKey,
  failClosed:   false,
});

module.exports = {
  globalLimiter,
  authLimiter,
  bookingLimiter,
  verifyPaymentLimiter,
  webhookLimiter,
  adminLimiter,
  adminReconcile,
  idempotencyConflictLimiter,
};