'use strict';

/**
 * workers/base-worker.js  (v3 — Stripe/GCP/Uber-Grade)
 *
 * BASE WORKER RUNTIME
 * ───────────────────
 * v3 upgrades over v2:
 *   + LISTEN/NOTIFY wakeup — immediate poll on INSERT, reduced idle polling
 *   + Shard-aware claims — worker owns a subset of shard_keys
 *   + Distributed rate limiting — checks DB token bucket before processing
 *   + Region-aware claims — workers only claim rows for their region
 *   + OpenTelemetry tracing — span per item, trace propagation
 *   + Drain mode — graceful rolling deploy: stop accepting new items
 *   + Correlation ID threading — trace_id / correlation_id on every log
 *   + Poll efficiency metric — tracks notify-vs-poll wakeup ratio
 *   + Backpressure from rate limiter → adaptive controller feedback
 */

const { randomUUID }  = require('crypto');
const logger          = require('../utils/logger');
const engine          = require('./atomic-engine');
const controller      = require('./adaptive-controller');
const metrics         = require('./metrics-collector');
const notifyListener  = require('./notify-listener');
const shardRouter     = require('./shard-router');
const regionManager   = require('./region-manager');
const tracer          = require('./telemetry').tracer;
const db              = require('../config/db');
const {
  BATCH_SIZE,
  POLLING_INTERVAL_MS,
  NOTIFY_FALLBACK_POLL_MS,
  HEARTBEAT_INTERVAL_MS,
  LEASE_TIMEOUT_MS,
  METRICS_SNAPSHOT_INTERVAL_MS,
  RATE_LIMIT,
  REGION,
} = require('./queues');

class BaseWorker {
  /**
   * @param {object} opts
   * @param {string}   opts.queueKey
   * @param {string}   opts.tableName
   * @param {string}   [opts.workerId]
   * @param {number}   [opts.workerIndex]    — 0-based shard affinity index
   * @param {number}   [opts.totalWorkers]   — total workers for this queue (for shard split)
   */
  constructor({ queueKey, tableName, workerId, workerIndex, totalWorkers }) {
    this.queueKey     = queueKey;
    this.tableName    = tableName;
    this.workerId     = workerId   ?? `${queueKey.toLowerCase()}-${randomUUID()}`;
    this.workerIndex  = workerIndex  ?? 0;
    this.totalWorkers = totalWorkers ?? 1;
    this.batchSize    = BATCH_SIZE[queueKey]            ?? 20;
    this.pollMs       = POLLING_INTERVAL_MS[queueKey]   ?? 1_000;
    this.fallbackMs   = NOTIFY_FALLBACK_POLL_MS[queueKey] ?? 10_000;
    this.heartbeatMs  = HEARTBEAT_INTERVAL_MS[queueKey] ?? 15_000;
    this.regionId     = REGION.CURRENT;

    this._activeSlots    = 0;
    this._running        = false;
    this._draining       = false;
    this._pollTimer      = null;
    this._leaseTimer     = null;
    this._metricsTimer   = null;
    this._drainResolvers = [];
    this._shardKeys      = null;  // populated on start()

    // Observability counters
    this._stats = {
      notifyWakeups:  0,
      pollWakeups:    0,
      rateLimitHits:  0,
      itemsProcessed: 0,
      itemsFailed:    0,
    };
  }

  // ─── Override in concrete worker ──────────────────────────────────────────
  async processItem(item) {
    throw new Error(`[${this.queueKey}] processItem() not implemented`);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  async start() {
    if (this._running) return;
    this._running = true;

    // Compute and register shard affinity
    this._shardKeys = shardRouter.computeWorkerShards(
      this.workerIndex, this.totalWorkers, this.queueKey,
    );
    await shardRouter.registerWorkerShards(
      this.workerId, this.queueKey, this.tableName, this._shardKeys,
    );

    logger.info(
      { worker: this.workerId, queue: this.queueKey, shards: this._shardKeys },
      '[base-worker] Worker started',
    );

    await this._registerHeartbeat();

    // LISTEN/NOTIFY wakeup
    notifyListener.on('wakeup', (payload) => {
      if (this._matchesWakeup(payload)) {
        this._stats.notifyWakeups++;
        this._triggerImmediatePoll();
      }
    });

    // Ensure rate limit bucket exists for this queue's provider
    if (RATE_LIMIT.ENABLED[this.queueKey]) {
      const provider = RATE_LIMIT.PROVIDER[this.queueKey];
      const cfg      = RATE_LIMIT.PROVIDERS[provider] ?? {};
      await engine.ensureRateLimitBucket({
        bucketKey:        `${provider}:global`,
        provider,
        tenantId:         'global',
        capacity:         cfg.capacity         ?? 100,
        refillRatePerSec: cfg.refillRatePerSec ?? 10,
      });
    }

    // Fallback poll (runs even when LISTEN is active — belt and suspenders)
    this._schedulePoll(0);
    this._scheduleLeaseRecovery();
    this._scheduleMetricsSnapshot();
  }

  async stop() {
    this._running = false;
    if (this._pollTimer)    clearTimeout(this._pollTimer);
    if (this._leaseTimer)   clearInterval(this._leaseTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);

    logger.info({ worker: this.workerId }, '[base-worker] Shutdown signal — draining...');
    await this._drain();
    await this._deregisterHeartbeat();
    logger.info({ worker: this.workerId }, '[base-worker] Drain complete — worker stopped');
  }

  /**
   * Initiate graceful drain. Worker stops accepting new items but finishes in-flight ones.
   * Used during rolling deployments.
   */
  async drain() {
    if (this._draining) return;
    this._draining = true;
    controller.setDraining(this.queueKey, true);
    await engine.requestWorkerDrain(this.workerId);
    logger.info({ worker: this.workerId }, '[base-worker] Graceful drain initiated');
  }

  // ─── LISTEN/NOTIFY integration ────────────────────────────────────────────

  _matchesWakeup(payload) {
    // Match by table name + shard key
    if (payload.table !== this.tableName) return false;
    if (payload.shard_key == null) return true; // no shard info — wake anyway
    return this._shardKeys && this._shardKeys.includes(Number(payload.shard_key));
  }

  _triggerImmediatePoll() {
    if (!this._running || this._draining) return;
    // Cancel current scheduled poll and run immediately
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollTimer = setTimeout(() => this._poll(), 0);
  }

  // ─── Poll loop ────────────────────────────────────────────────────────────
  _schedulePoll(delayMs) {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    // When LISTEN is active, use longer fallback interval; when not, use normal interval
    const actualDelay = delayMs === 0
      ? 0
      : (notifyListener.isConnected ? this.fallbackMs : this.pollMs);
    this._pollTimer = setTimeout(() => this._poll(), actualDelay);
  }

  async _poll() {
    if (!this._running) return;
    if (this._draining) {
      // In drain mode: still poll but don't start new items, just wait for drain
      this._schedulePoll(this.pollMs);
      return;
    }

    this._stats.pollWakeups++;

    // Circuit breaker gate
    if (!controller.canProcess(this.queueKey)) {
      this._schedulePoll(this.pollMs * 2);
      return;
    }

    // Rate limit check (queue-level, before claim)
    if (RATE_LIMIT.ENABLED[this.queueKey]) {
      const provider   = RATE_LIMIT.PROVIDER[this.queueKey];
      const bucketKey  = `${provider}:global`;
      const allowed    = await engine.acquireRateLimit(bucketKey, 1);
      if (!allowed) {
        this._stats.rateLimitHits++;
        controller.onRateLimited(this.queueKey);
        this._schedulePoll(this.pollMs * 3);
        return;
      }
    }

    const concurrency = controller.getConcurrency(this.queueKey);
    const available   = concurrency - this._activeSlots;

    if (available <= 0) {
      this._schedulePoll(this.pollMs);
      return;
    }

    let items = [];
    try {
      items = await engine.atomicClaim({
        tableName: this.tableName,
        queueKey:  this.queueKey,
        batchSize: Math.min(available, this.batchSize),
        workerId:  this.workerId,
        shardKeys: this._shardKeys,
        regionId:  this.regionId,
      });
    } catch (err) {
      logger.error({ err, worker: this.workerId }, '[base-worker] atomicClaim failed');
      this._schedulePoll(this.pollMs * 5);
      return;
    }

    if (items.length === 0) {
      this._schedulePoll(notifyListener.isConnected ? this.fallbackMs : this.pollMs);
      return;
    }

    logger.debug(
      { worker: this.workerId, claimed: items.length, concurrency },
      '[base-worker] Claimed items',
    );

    for (const item of items) {
      this._activeSlots++;
      this._executeItem(item).finally(() => {
        this._activeSlots--;
        this._notifyDrainIfIdle();
      });
    }

    const filled    = items.length >= Math.min(available, this.batchSize);
    const nextDelay = filled ? 0 : (notifyListener.isConnected ? this.fallbackMs : this.pollMs);
    this._schedulePoll(nextDelay);
  }

  // ─── Item execution ───────────────────────────────────────────────────────
  async _executeItem(item) {
    const start        = Date.now();
    const leaseVersion = item.lease_version;
    const traceId      = item.trace_id      ?? randomUUID();
    const correlId     = item.correlation_id ?? item.id;

    // OpenTelemetry span
    const span = tracer.startSpan(`${this.queueKey}.processItem`, {
      attributes: {
        'worker.id':          this.workerId,
        'worker.queue':       this.queueKey,
        'worker.region':      this.regionId,
        'job.id':             item.id,
        'job.attempt':        item.attempt_count ?? 0,
        'job.shard_key':      item.shard_key,
        'trace.id':           traceId,
        'correlation.id':     correlId,
      },
    });

    const heartbeatTimer = setInterval(async () => {
      const leaseMs = LEASE_TIMEOUT_MS[this.queueKey] ?? 30_000;
      const ok = await engine.extendLease({
        tableName: this.tableName,
        id:        item.id,
        workerId:  this.workerId,
        leaseVersion,
        extendMs:  leaseMs,
      });
      if (!ok) clearInterval(heartbeatTimer);
    }, this.heartbeatMs);

    try {
      const result = await this.processItem(item);

      await engine.commitSuccess({
        tableName:    this.tableName,
        id:           item.id,
        workerId:     this.workerId,
        leaseVersion,
        result,
      });

      controller.onSuccess(this.queueKey);
      this._stats.itemsProcessed++;

      span.setStatus({ code: 1 /* OK */ });
      logger.info(
        { worker: this.workerId, id: item.id, ms: Date.now() - start, traceId, correlId },
        '[base-worker] Item processed successfully',
      );
    } catch (err) {
      this._stats.itemsFailed++;
      span.setStatus({ code: 2 /* ERROR */, message: err.message });
      span.recordException(err);

      logger.error(
        { err, worker: this.workerId, id: item.id, ms: Date.now() - start, traceId, correlId },
        '[base-worker] Item processing failed',
      );

      await engine.commitFailure({
        tableName:    this.tableName,
        queueKey:     this.queueKey,
        id:           item.id,
        workerId:     this.workerId,
        leaseVersion,
        error:        err,
      });

      controller.onFailure(this.queueKey);
    } finally {
      clearInterval(heartbeatTimer);
      span.end();
    }
  }

  // ─── Lease recovery ───────────────────────────────────────────────────────
  _scheduleLeaseRecovery() {
    this._runLeaseRecovery();
    this._leaseTimer = setInterval(() => this._runLeaseRecovery(), 30_000);
  }

  async _runLeaseRecovery() {
    try {
      await engine.reclaimExpiredLeases({ tableName: this.tableName, queueKey: this.queueKey });
    } catch (err) {
      logger.error({ err }, '[base-worker] Lease recovery failed');
    }
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────
  _scheduleMetricsSnapshot() {
    const intervalMs = METRICS_SNAPSHOT_INTERVAL_MS ?? 30_000;
    this._metricsTimer = setInterval(() => this._captureMetrics(), intervalMs);
  }

  async _captureMetrics() {
    try {
      const circuitState = controller.getState(this.queueKey);
      await metrics.captureSnapshot({
        queue:        this.queueKey,
        tableName:    this.tableName,
        workerId:     this.workerId,
        activeSlots:  this._activeSlots,
        concurrency:  circuitState.concurrency,
        circuitState: circuitState.circuit,
        regionId:     this.regionId,
        stats:        { ...this._stats },
      });
    } catch (err) {
      logger.warn({ err }, '[base-worker] Metrics capture failed (non-fatal)');
    }
  }

  // ─── Worker heartbeat ─────────────────────────────────────────────────────
  async _registerHeartbeat() {
    try {
      await db.query(
        `INSERT INTO worker_heartbeats
           (worker_id, queue_key, region_id, started_at, last_heartbeat, active_jobs)
         VALUES ($1, $2, $3, NOW(), NOW(), 0)
         ON CONFLICT (worker_id) DO UPDATE
           SET last_heartbeat = NOW(), active_jobs = 0, region_id = $3`,
        [this.workerId, this.queueKey, this.regionId],
      );

      this._heartbeatRefreshTimer = setInterval(async () => {
        try {
          await db.query(
            `UPDATE worker_heartbeats
             SET last_heartbeat = NOW(), active_jobs = $1, drain_requested = $2
             WHERE worker_id = $3`,
            [this._activeSlots, this._draining, this.workerId],
          );
        } catch (e) {
          logger.warn({ e }, '[base-worker] Heartbeat refresh failed (non-fatal)');
        }
      }, 15_000);
    } catch (err) {
      logger.warn({ err }, '[base-worker] Failed to register heartbeat (non-fatal)');
    }
  }

  async _deregisterHeartbeat() {
    if (this._heartbeatRefreshTimer) clearInterval(this._heartbeatRefreshTimer);
    try {
      await db.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [this.workerId]);
    } catch (err) {
      logger.warn({ err }, '[base-worker] Failed to deregister heartbeat (non-fatal)');
    }
  }

  // ─── Graceful drain ───────────────────────────────────────────────────────
  _drain() {
    if (this._activeSlots === 0) return Promise.resolve();
    return new Promise((resolve) => { this._drainResolvers.push(resolve); });
  }

  _notifyDrainIfIdle() {
    if (this._activeSlots === 0 && this._drainResolvers.length > 0) {
      for (const resolve of this._drainResolvers) resolve();
      this._drainResolvers = [];
    }
  }

  /**
   * Returns current operational stats for this worker.
   */
  getStats() {
    return {
      workerId:      this.workerId,
      queueKey:      this.queueKey,
      regionId:      this.regionId,
      activeSlots:   this._activeSlots,
      draining:      this._draining,
      shardKeys:     this._shardKeys,
      notifyActive:  notifyListener.isConnected,
      ...this._stats,
    };
  }
}

module.exports = BaseWorker;

