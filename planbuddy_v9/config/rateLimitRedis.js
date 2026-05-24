'use strict';

/**
 * config/rateLimitRedis.js — Dedicated ioredis client for rate limiting.
 *
 * WHY A SEPARATE CLIENT:
 *   The main Redis client (config/redis.js) is shared by BullMQ workers,
 *   session storage, and idempotency key lookups. A traffic spike that floods
 *   the rate-limit store with INCR/EXPIRE ops can saturate the shared connection,
 *   causing BullMQ job processing to stall and session lookups to time out.
 *
 * This client is identical in connection config but isolated in connection
 * pool — its ops cannot starve other subsystems.
 *
 * DEPLOYMENT:
 *   Points at the same Redis instance as config/redis.js by default.
 *   For higher isolation, point RATE_LIMIT_REDIS_URL at a separate Redis instance
 *   (e.g. a smaller ElastiCache node reserved exclusively for rate limiting).
 *
 * GRACEFUL SHUTDOWN:
 *   closeRateLimitRedis() is called from app.js SIGTERM handler alongside
 *   closeQueues() and db.end(). See graceful shutdown block in app.js.
 */

const Redis  = require('ioredis');
const logger = require('../utils/logger');

const explicitUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
const host = process.env.REDIS_HOST || '127.0.0.1';
const port = process.env.REDIS_PORT || '6379';
const REDIS_URL = explicitUrl || `redis://${host}:${port}`;

if (!REDIS_URL) {
  throw new Error(
    '[rateLimitRedis] Neither RATE_LIMIT_REDIS_URL nor REDIS_URL nor REDIS_HOST/REDIS_PORT is set. ' +
    'Rate limiting requires a Redis connection.'
  );
}

const rateLimitRedis = new Redis(REDIS_URL, {
  // Connection identity — visible in Redis CLIENT LIST output
  name: 'planbuddy-rate-limit',

  // Reconnect strategy: exponential back-off capped at 10 s.
  // express-rate-limit's fail-closed wrappers guard critical endpoints during
  // reconnect windows — this is intentional, not a gap.
  retryStrategy(times) {
    if (times > 10) {
      logger.error(
        { service: 'rateLimitRedis', attempt: times },
        '[rateLimitRedis] Max reconnect attempts exceeded — giving up'
      );
      return null; // Stop retrying; ioredis will emit 'end'
    }
    const delay = Math.min(100 * 2 ** times, 10_000);
    logger.warn(
      { service: 'rateLimitRedis', attempt: times, delayMs: delay },
      '[rateLimitRedis] Reconnecting...'
    );
    return delay;
  },

  // Don't buffer commands during reconnect — rate-limit checks should fail
  // fast (triggering fail-closed/fail-open policy) rather than queue up.
  enableOfflineQueue: false,

  // Connection pool kept small — rate-limit ops are fast INCR/GET, not
  // long-running queries.
  maxRetriesPerRequest: 1,

  // Shorter connect timeout than BullMQ — rate limiting should fail fast
  // connectTimeout: 3000,
  // commandTimeout: 500,
  connectTimeout: 3000,
  commandTimeout: 500,
});

rateLimitRedis.on('connect', () => {
  logger.info({ service: 'rateLimitRedis' }, '[rateLimitRedis] Connected');
});

rateLimitRedis.on('ready', () => {
  logger.info({ service: 'rateLimitRedis' }, '[rateLimitRedis] Ready');
});

rateLimitRedis.on('error', (err) => {
  logger.error({ service: 'rateLimitRedis', err: err.message }, '[rateLimitRedis] Error');
});

rateLimitRedis.on('close', () => {
  logger.warn({ service: 'rateLimitRedis' }, '[rateLimitRedis] Connection closed');
});

rateLimitRedis.on('end', () => {
  logger.warn({ service: 'rateLimitRedis' }, '[rateLimitRedis] Connection ended (no more retries)');
});

/**
 * Gracefully close the rate-limit Redis connection.
 * Call this from the SIGTERM handler in app.js after HTTP server.close().
 */
async function closeRateLimitRedis() {
  try {
    await rateLimitRedis.quit();
    logger.info({ service: 'rateLimitRedis' }, '[rateLimitRedis] Closed gracefully');
  } catch (err) {
    logger.error({ service: 'rateLimitRedis', err: err.message }, '[rateLimitRedis] Error on close');
  }
}

module.exports = { rateLimitRedis, closeRateLimitRedis };

