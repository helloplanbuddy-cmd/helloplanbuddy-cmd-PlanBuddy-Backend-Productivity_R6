'use strict';

// __mocks__/redis.js

const Redis = require('ioredis-mock');

const mockRedis = new Redis();
const mockRedisQueue = new Redis();

module.exports = {
  mockRedis,
  mockRedisQueue,
  isHealthy: async () => ({
    status: 'ok',
    redis: { status: 'ok' },
    redisQueue: { status: 'ok' },
  }),
  disconnect: async () => {
    await Promise.allSettled([
      mockRedis.quit(),
      mockRedisQueue.quit(),
    ]);
  },
  // Export the originals so we can spy on them
  redis: mockRedis,
  redisQueue: mockRedisQueue,
};
