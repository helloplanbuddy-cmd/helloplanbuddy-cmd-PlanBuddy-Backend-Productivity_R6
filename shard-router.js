'use strict';

/**
 * workers/shard-router.js  (v3)
 *
 * SHARD ROUTER — HASH PARTITION DISTRIBUTION
 * ───────────────────────────────────────────
 * Distributes queue jobs across N hash shards to reduce index contention
 * at hyperscale (100M+ rows). Workers claim a subset of shard_keys,
 * avoiding full-table lock competition.
 *
 * Sharding model:
 *   shard_key = hash(jobId or tenantId) % TOTAL_SHARDS
 *
 * Worker affinity:
 *   - Workers register their shard affinity on startup
 *   - With N workers and S shards, each worker owns S/N shards
 *   - Unowned shards are claimed by any available worker (failover)
 *
 * Insert-time routing:
 *   ShardRouter.computeShardKey(id) — deterministic shard for a given ID
 *   ShardRouter.getWorkerShards(workerId, queueKey) — shards owned by worker
 *
 * This enables:
 *   - Linear horizontal scaling with low contention
 *   - Tenant-aware distribution (same tenant → same shard → ordering)
 *   - Partition pruning on the shard_key index
 */

const crypto = require('crypto');
const db     = require('../config/db');
const logger = require('../utils/logger');
const { TOTAL_SHARDS } = require('./queues');

class ShardRouter {
  constructor() {
    this._affinityCache = {}; // workerId → { queueKey → shard[] }
  }

  /**
   * Compute deterministic shard_key for a job.
   * @param {string} id  — job UUID or tenant ID
   * @param {string} queueKey
   * @returns {number}
   */
  computeShardKey(id, queueKey) {
    const total = TOTAL_SHARDS[queueKey] ?? 8;
    // Use first 8 hex chars of SHA256 as a stable integer
    const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
    return parseInt(hash, 16) % total;
  }

  /**
   * Register a worker's shard affinity in DB.
   * Called once on worker startup.
   * @param {string} workerId
   * @param {string} queueKey
   * @param {string} tableName
   * @param {number[]} shardNumbers
   */
  async registerWorkerShards(workerId, queueKey, tableName, shardNumbers) {
    const total = TOTAL_SHARDS[queueKey] ?? 8;

    for (const shardNum of shardNumbers) {
      const shardId = `${queueKey}:${shardNum}`;
      await db.query(
        `INSERT INTO queue_shards (shard_id, queue_key, shard_number, total_shards, table_name, worker_affinity)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (queue_key, shard_number) DO UPDATE
           SET worker_affinity = $6, active = TRUE`,
        [shardId, queueKey, shardNum, total, tableName, workerId],
      );
    }

    this._affinityCache[`${workerId}:${queueKey}`] = shardNumbers;
    logger.info({ workerId, queueKey, shards: shardNumbers }, '[shard-router] Worker shard affinity registered');
  }

  /**
   * Compute which shard numbers a worker should own given total workers.
   * Round-robin distribution. Stable as long as workerIndex and totalWorkers don't change.
   *
   * @param {number} workerIndex   — 0-based index of this worker
   * @param {number} totalWorkers  — total number of workers for this queue
   * @param {string} queueKey
   * @returns {number[]}
   */
  computeWorkerShards(workerIndex, totalWorkers, queueKey) {
    const total = TOTAL_SHARDS[queueKey] ?? 8;
    const shards = [];
    for (let s = 0; s < total; s++) {
      if (s % totalWorkers === workerIndex) {
        shards.push(s);
      }
    }
    return shards.length > 0 ? shards : Array.from({ length: total }, (_, i) => i);
  }

  /**
   * Get the shard numbers this worker is responsible for.
   * Falls back to ALL shards if no affinity registered (ensures no jobs are orphaned).
   *
   * @param {string} workerId
   * @param {string} queueKey
   * @returns {Promise<number[]>}
   */
  async getWorkerShards(workerId, queueKey) {
    const cacheKey = `${workerId}:${queueKey}`;
    if (this._affinityCache[cacheKey]) return this._affinityCache[cacheKey];

    try {
      const { rows } = await db.query(
        `SELECT shard_number FROM queue_shards
         WHERE queue_key = $1 AND worker_affinity = $2 AND active = TRUE`,
        [queueKey, workerId],
      );

      if (rows.length > 0) {
        const shards = rows.map(r => r.shard_number);
        this._affinityCache[cacheKey] = shards;
        return shards;
      }
    } catch (err) {
      logger.warn({ err, workerId, queueKey }, '[shard-router] Failed to fetch shard affinity — using all shards');
    }

    // No affinity — claim all shards (single worker or failover)
    const total = TOTAL_SHARDS[queueKey] ?? 8;
    return Array.from({ length: total }, (_, i) => i);
  }

  /**
   * Clear affinity cache (call on worker reconfiguration).
   */
  clearCache(workerId, queueKey) {
    delete this._affinityCache[`${workerId}:${queueKey}`];
  }
}

// Singleton
const shardRouter = new ShardRouter();

module.exports = shardRouter;