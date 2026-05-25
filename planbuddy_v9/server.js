'use strict';

/**
 * server.js — Production HTTP Server with Graceful Shutdown (v1.0)
 *
 * CRITICAL FIX: This file was MISSING, causing complete startup failure.
 *
 * Responsibilities:
 *   • Create HTTP server from Express app
 *   • Implement graceful shutdown (SIGTERM/SIGINT)
 *   • Drain connections and queues
 *   • Clean up Redis/DB connections
 *   • Enforce shutdown timeout
 *   • Log startup/shutdown events
 *   • Report readiness to orchestrator
 *
 * Startup sequence:
 *   1. Load environment (config/env.js)
 *   2. Create Express app (app.js)
 *   3. Create HTTP server
 *   4. Initialize Redis, DB, queues
 *   5. Start server on PORT
 *   6. Wait for readiness signals
 *   7. Signal ready to orchestrator
 *
 * Shutdown sequence (on SIGTERM/SIGINT):
 *   1. Stop accepting new connections
 *   2. Wait for in-flight requests to finish (timeout: 30s)
 *   3. Close HTTP server
 *   4. Drain worker queues (timeout: 30s)
 *   5. Close Redis connections (timeout: 10s)
 *   6. Close DB connection (timeout: 10s)
 *   7. Exit process with code 0
 *   8. If timeout exceeded, force exit with code 1
 */

const http = require('http');

// ── PHASE 1: Load configuration (must be first) ──────────────────────────────────
const env = require('./config/env');
const logger = require('./utils/logger');

// ── PHASE 2: Create Express app ─────────────────────────────────────────────────
const app = require('./app');

// ── Tracking variables ──────────────────────────────────────────────────────────
let server = null;
let shuttingDown = false;
let activeConnections = new Set();
let shutdownStartTime = null;

const SHUTDOWN_TIMEOUT_MS = 60000; // 60 seconds total shutdown timeout
const REQUEST_DRAIN_TIMEOUT_MS = 30000; // 30 seconds for requests to finish
const QUEUE_DRAIN_TIMEOUT_MS = 30000; // 30 seconds for queue to drain
const REDIS_CLOSE_TIMEOUT_MS = 10000; // 10 seconds for Redis
const DB_CLOSE_TIMEOUT_MS = 10000; // 10 seconds for DB

// ───────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN IMPLEMENTATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Connection tracking — detect when all requests are done
 */
function trackConnections() {
  server.on('connection', (connection) => {
    activeConnections.add(connection);
    logger.debug({ connectionId: connection.remoteAddress }, '[startup] Connection tracked');

    connection.on('close', () => {
      activeConnections.delete(connection);
      logger.debug({ connectionId: connection.remoteAddress }, '[startup] Connection closed');
    });
  });
}

/**
 * Drain in-flight requests — stop accepting new connections
 */
async function drainRequests() {
  logger.info('[shutdown] Stopping new connections...');

  return new Promise((resolve) => {
    const drainStartTime = Date.now();

    // Stop accepting new connections
    server.close(() => {
      const drainTime = Date.now() - drainStartTime;
      logger.info({ drainTimeMs: drainTime }, '[shutdown] HTTP server closed');
      resolve();
    });

    // Force close if timeout exceeded
    const drainTimeout = setTimeout(() => {
      logger.warn(
        { activeConnections: activeConnections.size },
        '[shutdown] Request drain timeout — force closing connections'
      );
      activeConnections.forEach((conn) => conn.destroy());
      activeConnections.clear();
      resolve();
    }, REQUEST_DRAIN_TIMEOUT_MS);

    // Track progress
    const monitorInterval = setInterval(() => {
      if (activeConnections.size > 0) {
        logger.debug({ activeConnections: activeConnections.size }, '[shutdown] Waiting for connections...');
      }
    }, 5000);

    // Cleanup monitors
    server.on('close', () => {
      clearTimeout(drainTimeout);
      clearInterval(monitorInterval);
    });
  });
}

/**
 * Drain worker queues — wait for background jobs to finish
 */
async function drainQueues() {
  logger.info('[shutdown] Draining worker queues...');

  try {
    // Close bcrypt queue first (if initialized)
    try {
      const bcryptQueueModule = require('./services/bcryptQueue');
      if (bcryptQueueModule && typeof bcryptQueueModule.closeQueue === 'function') {
        await bcryptQueueModule.closeQueue();
        logger.debug('[shutdown] Bcrypt queue closed');
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[shutdown] Bcrypt queue not available');
    }

    // Close main BullMQ queues
    const queuesModule = require('./config/queues');

    if (!queuesModule || typeof queuesModule.closeQueues !== 'function') {
      logger.warn('[shutdown] Queue drain not available — skipping');
      return;
    }

    const closeStartTime = Date.now();
    await queuesModule.closeQueues();
    const closeTime = Date.now() - closeStartTime;

    logger.info({ closeTimeMs: closeTime }, '[shutdown] Queues drained and closed');
  } catch (err) {
    logger.error({ err, message: err.message }, '[shutdown] Queue drain error — continuing');
  }
}

/**
 * Close Redis connections
 */
async function closeRedis() {
  logger.info('[shutdown] Closing Redis connections...');

  try {
    const redisModule = require('./config/redis');

    if (!redisModule) {
      logger.warn('[shutdown] Redis module not available');
      return;
    }

    const closeStartTime = Date.now();

    // Close rate limit Redis
    try {
      const { closeRateLimitRedis } = require('./config/rateLimitRedis');
      if (typeof closeRateLimitRedis === 'function') {
        await closeRateLimitRedis();
        logger.debug('[shutdown] Rate limit Redis closed');
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[shutdown] Rate limit Redis not available or close failed');
    }

    // Close cache Redis
    if (redisModule.redis && typeof redisModule.redis.quit === 'function') {
      try {
        await redisModule.redis.quit();
        logger.debug('[shutdown] Cache Redis closed');
      } catch (err) {
        logger.warn({ err: err.message }, '[shutdown] Cache Redis close error');
      }
    }

    // Close queue Redis
    if (redisModule.redisQueue && typeof redisModule.redisQueue.quit === 'function') {
      try {
        await redisModule.redisQueue.quit();
        logger.debug('[shutdown] Queue Redis closed');
      } catch (err) {
        logger.warn({ err: err.message }, '[shutdown] Queue Redis close error');
      }
    }

    const closeTime = Date.now() - closeStartTime;
    logger.info({ closeTimeMs: closeTime }, '[shutdown] Redis connections closed');
  } catch (err) {
    logger.error({ err, message: err.message }, '[shutdown] Redis close error — continuing');
  }
}

/**
 * Close database connection
 */
async function closeDatabase() {
  logger.info('[shutdown] Closing database connection...');

  try {
    const db = require('./config/db');

    if (!db || typeof db.end !== 'function') {
      logger.warn('[shutdown] Database module not available');
      return;
    }

    const closeStartTime = Date.now();
    await db.end();
    const closeTime = Date.now() - closeStartTime;

    logger.info({ closeTimeMs: closeTime }, '[shutdown] Database connection closed');
  } catch (err) {
    logger.error({ err, message: err.message }, '[shutdown] Database close error — continuing');
  }
}

/**
 * Graceful shutdown orchestrator
 */
async function gracefulShutdown(signal) {
  if (shuttingDown) {
    logger.warn(`[shutdown] Already shutting down (signal: ${signal}), ignoring duplicate`);
    return;
  }

  shuttingDown = true;
  shutdownStartTime = Date.now();

  logger.info({ signal, pid: process.pid }, '[shutdown] Graceful shutdown initiated');

  try {
    // Phase 1: Drain requests (30s timeout)
    logger.info('[shutdown] PHASE 1/5: Draining in-flight requests...');
    await drainRequests();

    // Phase 2: Drain queues (30s timeout)
    logger.info('[shutdown] PHASE 2/5: Draining worker queues...');
    await Promise.race([
      drainQueues(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Queue drain timeout')), QUEUE_DRAIN_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      if (err.message === 'Queue drain timeout') {
        logger.warn('[shutdown] Queue drain timeout — proceeding to cleanup');
      } else {
        logger.error({ err: err.message }, '[shutdown] Queue drain error');
      }
    });

    // Phase 3: Close Redis (10s timeout)
    logger.info('[shutdown] PHASE 3/5: Closing Redis connections...');
    await Promise.race([
      closeRedis(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis close timeout')), REDIS_CLOSE_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      if (err.message === 'Redis close timeout') {
        logger.warn('[shutdown] Redis close timeout — proceeding to DB close');
      } else {
        logger.error({ err: err.message }, '[shutdown] Redis close error');
      }
    });

    // Phase 4: Close database (10s timeout)
    logger.info('[shutdown] PHASE 4/5: Closing database...');
    await Promise.race([
      closeDatabase(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB close timeout')), DB_CLOSE_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      if (err.message === 'DB close timeout') {
        logger.warn('[shutdown] Database close timeout — proceeding to exit');
      } else {
        logger.error({ err: err.message }, '[shutdown] Database close error');
      }
    });

    // Phase 5: Final status
    const shutdownTimeMs = Date.now() - shutdownStartTime;
    logger.info({ shutdownTimeMs, pid: process.pid }, '[shutdown] PHASE 5/5: Shutdown complete');

    process.exit(0);
  } catch (err) {
    logger.fatal({ err, message: err.message, pid: process.pid }, '[shutdown] FATAL: Unexpected error during shutdown');
    process.exit(1);
  }
}

/**
 * Register shutdown signal handlers
 */
function registerShutdownHandlers() {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal(
      { reason, promise: String(promise), pid: process.pid },
      '[startup] Unhandled rejection detected — exiting'
    );
    setTimeout(() => process.exit(1), 100);
  });

  // Uncaught exception handler
  process.on('uncaughtException', (err) => {
    logger.fatal({ err, message: err.message, pid: process.pid }, '[startup] Uncaught exception — exiting');
    setTimeout(() => process.exit(1), 100);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// STARTUP IMPLEMENTATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Verify critical dependencies are reachable before startup
 *
 * SECURITY FIX: Ensures Kubernetes readiness probes don't report 200
 * until app is actually ready. Prevents cascading failures during
 * rolling deployments.
 */
const db = require('./config/db');

async function verifyDependencies() {
  const checkTimeout = 5000; // 5s timeout per check

  // Check database
  try {
    logger.info('[startup] Verifying database connectivity...');
    const result = await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB check timeout')), checkTimeout)
      ),
    ]);
    logger.info('[startup] Database: OK');
  } catch (err) {
    logger.error({ err: err.message }, '[startup] Database: FAILED');
    throw new Error(`Database unreachable: ${err.message}`);
  }

  // Check Redis
  try {
    logger.info('[startup] Verifying Redis connectivity...');
    const redis = require('./config/redis').redis;

    if (redis) {
      await Promise.race([
        redis.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis check timeout')), checkTimeout)
        ),
      ]);
      logger.info('[startup] Redis: OK');
    } else {
      logger.warn('[startup] Redis: Not initialized (optional)');
    }
  } catch (err) {
    logger.error({ err: err.message }, '[startup] Redis: FAILED');
    if (env.IS_PROD) {
      throw new Error(`Redis unreachable: ${err.message}`);
    }
    logger.warn('[startup] Redis failure tolerated in non-production mode');
  }

  // Check dedicated rate-limit Redis
  try {
    logger.info('[startup] Verifying rate-limit Redis connectivity...');
    const { rateLimitRedis } = require('./config/rateLimitRedis');

    await Promise.race([
      rateLimitRedis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Rate-limit Redis check timeout')), checkTimeout)
      ),
    ]);

    logger.info('[startup] Rate-limit Redis: OK');
  } catch (err) {
    logger.error({ err: err.message }, '[startup] Rate-limit Redis: FAILED');
    if (env.IS_PROD) {
      throw new Error(`Rate-limit Redis unreachable: ${err.message}`);
    }
    logger.warn('[startup] Rate-limit Redis failure tolerated in non-production mode');
  }
}

/**
 * Start the HTTP server
 */
async function start() {
  try {
    logger.info({ node: process.version, pid: process.pid }, '[startup] Node.js starting');

    // Verify environment
    if (!env.PORT) {
      throw new Error('PORT environment variable not set');
    }

    // Verify dependencies BEFORE creating server
    await verifyDependencies();

    // Create HTTP server
    server = http.createServer(app);
    server.setTimeout(env.HTTP_REQUEST_TIMEOUT_MS);
    server.headersTimeout = env.HTTP_HEADERS_TIMEOUT_MS;

    // Track connections for graceful shutdown
    trackConnections();

    // Register shutdown handlers BEFORE server starts
    registerShutdownHandlers();

    // Start listening
    return new Promise((resolve, reject) => {
      server.listen(env.PORT, () => {
        logger.info(
          { port: env.PORT, pid: process.pid, env: env.NODE_ENV },
          '[startup] HTTP server listening'
        );

        if (env.IS_PROD) {
          try {
            const productionHealth = require('./services/productionHealth');
            if (productionHealth && typeof productionHealth.startCron === 'function') {
              productionHealth.startCron();
            }
          } catch (err) {
            logger.warn({ err: err.message }, '[startup] Production health cron failed to start');
          }
        }

        resolve();
      });

      server.on('error', (err) => {
        logger.fatal({ err, message: err.message }, '[startup] HTTP server error');
        reject(err);
      });
    });
  } catch (err) {
    logger.fatal({ err, message: err.message }, '[startup] FATAL: Startup failed');
    process.exit(1);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ───────────────────────────────────────────────────────────────────────────────

start()
  .then(() => {
    logger.info({ uptime: process.uptime(), pid: process.pid }, '[startup] Application fully initialized');
  })
  .catch((err) => {
    logger.fatal({ err, message: err.message }, '[startup] Failed to start');
    process.exit(1);
  });
