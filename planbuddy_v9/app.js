"use strict";

/**
 * app.js — Express Application Assembly (v3.3)
 *
 * FIXES from v3.2 audit (2026-05-14):
 *
 *  FIX-1 — Webhook path excluded from globalLimiter at the mount level.
 *    v3.2 mounted globalLimiter at app.use('/api', ...) which captured ALL
 *    /api/* traffic including Razorpay webhook deliveries. Under payment volume,
 *    Razorpay's delivery IPs could exhaust the 500/15min global budget, causing
 *    a 429 → retry → storm loop that stalls the payment state machine.
 *    rateLimit.js v4.1 now includes extraSkip: isWebhookPath in globalLimiter,
 *    so this is handled at the middleware layer — no changes needed in app.js
 *    beyond updating this comment block and the inline note below.
 *
 *  FIX-2 — globalLimiter skip() path bug resolved in rateLimit.js v4.1.
 *    Health probe bypass is now correctly keyed on req.path === '/health'
 *    (post-mount suffix) rather than req.path.startsWith('/api/health').
 *    No app.js change required.
 *
 *  UNCHANGED from v3.2: raw body parsing, CORS, security headers, graceful
 *  shutdown, trace ID, route structure, trust proxy, backpressure.
 *
 * Module load order matters:
 *  config/env.js MUST be required first — validates env vars, exits on failure.
 *  utils/logger.js depends on env.js.
 */

// ── env MUST be first ─────────────────────────────────────────────────────────
const env = require('./config/env');

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');

const routes                     = require('./routes');
const errorHandler               = require('./middleware/errorHandler');
const apiVersion                 = require('./middleware/apiVersion');
const { globalLimiter }          = require('./middleware/rateLimit');
const { backpressureMiddleware } = require('./middleware/backpressure');
const monitoring                 = require('./utils/monitoring');
const logger                     = require('./utils/logger');
const { traceIdMiddleware }      = require('./middleware/traceId');
const internalIpGuard            = require('./middleware/internalIpGuard');
const internalRoutes             = require('./routes/internal');

const app = express();

// ─── Trust proxy ──────────────────────────────────────────────────────────────
// '1' = trust first proxy hop. Required for Render / Railway / nginx deployments
// so req.ip reflects the real client IP for rate-limiting and logging.
//
// SECURITY FIX: X-Forwarded-For validation middleware (v1.0)
// With `trust proxy: 1`, an attacker making a direct TCP connection to the app
// port (bypassing the load balancer) can set X-Forwarded-For to any value.
// FIXED: proxyValidation middleware now strips X-Forwarded-For from non-proxy sources.
// REQUIRED: Set KNOWN_PROXY_IPS env var with your load balancer's IP(s).
// ALSO REQUIRED: Firewall rules to block direct connections to app port.
app.set('trust proxy', 1);

// ─── Proxy header validation ──────────────────────────────────────────────────
// Validates X-Forwarded-For headers come from known proxies only.
// Strips header if source IP is not in KNOWN_PROXY_IPS list.
const { proxyValidation } = require('./middleware');
app.use(proxyValidation.middleware());

// ─── HTTPS enforcement ────────────────────────────────────────────────────────
if (env.IS_PROD) {
  app.use((req, res, next) => {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    }
    next();
  });
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'geolocation=(), camera=(), microphone=()');
  if (env.IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
});

// ─── Request ID injection ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// ─── TEMPORARY forensic trace instrumentation (inline, gated) ─────────────
// Enable with: TEMP_TRACE_ENABLED=1
// Mounted before routing so we can prove traversal/execution ordering.
if (process.env.TEMP_TRACE_ENABLED === '1') {
  app.use((req, res, next) => {
    req._trace = {
      id: req.requestId,
      step: 0,
      middlewareHits: {},
    };

    req.traceHit = (name) => {
      const nextStep = (req._trace.step = (req._trace.step || 0) + 1);
      req._trace.middlewareHits[name] = (req._trace.middlewareHits[name] || 0) + 1;
      console.log(
        `[TRACE:${req._trace.id}] STEP=${nextStep} ${name} (${req._trace.middlewareHits[name]})`
      );
    };

    // Single lifecycle observer.
    res.on('finish', () => {
      console.log(
        `[TRACE:${req._trace.id}] RESPONSE_FINISH status=${res.statusCode}`
      );
    });

    res.on('close', () => {
      console.log(`[TRACE:${req._trace.id}] RESPONSE_CLOSE`);
    });

    // Prove mount traversal/entry.
    req.traceHit('ENTER app');
    next();
  });

  // Router entry tracing (mount traversal proof)
  app.use('/api/v1', (req, res, next) => {
    req.traceHit('ENTER /api/v1');
    next();
  });

  app.use('/api', (req, res, next) => {
    req.traceHit('ENTER /api');
    next();
  });
}

// ─── Trace ID (must come after requestId so it can inherit it) ────────────────
app.use(traceIdMiddleware);


// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    }
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-Correlation-Id', 'X-Request-Id', 'Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-Id', 'X-API-Version'],
  maxAge:         600,
}));

// ─── CSRF Protection (SPA-only architecture) ─────────────────────────────────────
// Security Fix C-3: Validate X-Requested-With header on state-changing requests
// This header is set by SPA frameworks (XMLHttpRequest / fetch) but cannot be set
// by browser form submissions, making it an effective CSRF protection for SPA-only APIs.
const csrfProtection = require('./middleware/csrfProtection');
app.use(csrfProtection);

// ─── Raw body for Razorpay webhook (MUST come before express.json) ────────────
// Only the canonical versioned path is registered in app.js.
// route-level webhookLimiter is applied in routes/index.js,
// and globalLimiter skips these paths via isWebhookPath() in rateLimit.js.
app.use('/api/v1/payment/webhook/razorpay', express.raw({ type: 'application/json', limit: '100kb' }));

// ─── JSON / URL-encoded body parsers ─────────────────────────────────────────
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// ─── Global rate limiter (all /api/* routes) ──────────────────────────────────
// globalLimiter (rateLimit.js v4.1) automatically skips:
//   • /health paths (req.path === '/health') — health probe budget protection
//   • /payment/webhook paths — isolated to webhookLimiter (FIX-1, FIX-2)
app.use('/api', globalLimiter);

// ─── Global backpressure (request throttling) ────────────────────────────────
// Bypasses /health, /metrics, /internal — see backpressure.js.
// bookingBackpressureMiddleware is NOT mounted here globally; it is mounted
// on the specific POST /booking route in routes/bookings.js.
app.use(backpressureMiddleware);

// ─── Prometheus /metrics endpoint (internal IPs only) ─────────────────────────
app.get('/metrics', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress;

  if (!env.METRICS_ALLOWED_IPS.includes(clientIp)) {
    logger.warn({ clientIp, requestId: req.requestId }, '[metrics] Access denied');
    return res.status(403).end('Forbidden');
  }

  res.set('Content-Type', monitoring.register.contentType);
  res.end(await monitoring.register.metrics());
});

const healthController = require('./controllers/healthController');
app.get('/health/live', healthController.live);
app.get('/health/ready', healthController.ready);
app.get('/health', healthController.readiness);
app.get('/health/production', healthController.production);

// ─── Structured Pino request logging ─────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]({
      requestId:  req.requestId,
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      durationMs,
      ip:         req.ip,
      userId:     req.user?.id,
      apiVersion: req.apiVersion,
    }, 'HTTP request');
  });

  next();
});

// ─── API Routes — versioned (canonical) ──────────────────────────────────────
app.use('/api/v1', apiVersion('v1'), routes);

// ─── Legacy API mount removed ───────────────────────────────────────────────
// Legacy /api compatibility was intentionally removed to avoid duplicate route
// registration, duplicate middleware execution, and doubled rate-limit state.
// If backward compatibility is required again, reintroduce a dedicated legacy
// router instead of reusing the canonical route definitions.

// ─── Internal observability routes (IP-guarded, NOT under /api/v1) ───────────
app.use('/internal', internalIpGuard, internalRoutes);

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success:   true,
    message:   'PlanBuddy Backend API',
    version:   env.APP_VERSION || '9.0.0',
    apiUrl:    '/api/v1',
    timestamp: new Date().toISOString(),
  });
});

// ─── Health checks (unversioned, not rate-limited, not load-shed) ─────────────
app.get('/health',       healthController.readiness);
app.get('/health/live',  healthController.live);
app.get('/health/ready', healthController.ready);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    path:    req.path,
    code:    'NOT_FOUND',
  });
});

// ─── Centralised error handler (MUST be last middleware) ──────────────────────
app.use(errorHandler);

module.exports = app;
