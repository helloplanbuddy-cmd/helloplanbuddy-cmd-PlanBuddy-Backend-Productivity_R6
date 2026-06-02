'use strict';

/**
 * config/redis.test-mock.js — Test-safe Redis mock
 *
 * Replaces real ioredis connections during Jest test execution.
 * Provides:
 *   - Mock redis client (cache)
 *   - Mock redisQueue client (BullMQ)
 *   - Mock isHealthy() returning { status: 'ok', ... }
 *   - Mock disconnect() (no-op)
 *
 * All clients are in-memory/fake — no network I/O.
 */

const EventEmitter = require('events');

// ─── Fake Redis client ────────────────────────────────────────────────────────

class FakeRedisClient extends EventEmitter {
  constructor(name = 'test') {
    super();
    this.name = name;
    this.status = 'ready';
    this._data = new Map();
    this._callLog = [];

    // Simulate async connect
    setImmediate(() => this.emit('ready'));
  }

  ping() {
    return Promise.resolve('PONG');
  }

  get(key) {
    this._callLog.push(['get', key]);
    return Promise.resolve(this._data.get(key) || null);
  }

  set(key, value, ...args) {
    this._callLog.push(['set', key, value, ...args]);
    this._data.set(key, value);
    return Promise.resolve('OK');
  }

  del(...keys) {
    this._callLog.push(['del', ...keys]);
    keys.forEach((k) => this._data.delete(k));
    return Promise.resolve(keys.length);
  }

  incr(key) {
    this._callLog.push(['incr', key]);
    const val = parseInt(this._data.get(key) || '0', 10) + 1;
    this._data.set(key, String(val));
    return Promise.resolve(val);
  }

  expire(key, seconds) {
    this._callLog.push(['expire', key, seconds]);
    return Promise.resolve(1);
  }

  quit() {
    this.status = 'end';
    this.emit('end');
    return Promise.resolve();
  }

  call(...args) {
    // rate-limit-redis store uses .call()
    this._callLog.push(['call', ...args]);
    const cmd = args[0]?.toUpperCase();
    if (cmd === 'PING') return Promise.resolve('PONG');
    if (cmd === 'GET') return Promise.resolve(this._data.get(args[1]) || null);
    if (cmd === 'SET') {
      this._data.set(args[1], args[2]);
      return Promise.resolve('OK');
    }
    return Promise.resolve(null);
  }

  /** Clear call log between tests */
  clearLog() {
    this._callLog = [];
  }

  /** Access call log for assertions */
  getCallLog() {
    return this._callLog;
  }
}

// ─── Mock implementations ────────────────────────────────────────────────────

const mockRedis = new FakeRedisClient('cache');
const mockRedisQueue = new FakeRedisClient('queue');

async function mockIsHealthy() {
  return {
    status: 'ok',
    latencyMs: 1,
    checks: {
      redis: { status: 'ok', latencyMs: 0 },
      redisQueue: { status: 'ok', latencyMs: 0 },
    },
  };
}

async function mockDisconnect() {
  await Promise.allSettled([
    mockRedis.quit(),
    mockRedisQueue.quit(),
  ]);
}

module.exports = {
  redis: mockRedis,
  redisQueue: mockRedisQueue,
  isHealthy: mockIsHealthy,
  disconnect: mockDisconnect,
};
