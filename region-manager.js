'use strict';

/**
 * workers/region-manager.js  (v3)
 *
 * MULTI-REGION COORDINATION
 * ─────────────────────────
 * Implements epoch-based leader election using the region_leader_lock table.
 *
 * Features:
 *   + Monotonic epoch fencing — stale region writes are rejected by epoch mismatch
 *   + Renewable leader lease — primary re-acquires before expiry
 *   + Automatic failover — expired primary lease stolen by any secondary
 *   + Clock-skew tolerance — lease duration padded beyond expected skew
 *   + Duplicate region startup safety — idempotent registration
 *   + Region heartbeat for visibility (v_region_status view)
 *
 * Workers check isLocalRegionPrimary() before running leader-only tasks
 * (e.g. scheduled job creation, partition management, global rate limit reset).
 * All workers in all regions process queue jobs — only leadership gates
 * administrative/scheduled tasks.
 */

const db     = require('../config/db');
const logger = require('../utils/logger');
const { REGION } = require('./queues');

const LEADER_LEASE_MS   = REGION.LEADER_LEASE_MS ?? 30_000;
const HEARTBEAT_MS      = REGION.HEARTBEAT_MS    ?? 10_000;
// Renew at 1/3 of lease to ensure renewal before expiry under normal operation
const RENEW_AT_MS       = Math.floor(LEADER_LEASE_MS / 3);

class RegionManager {
  constructor() {
    this._regionId    = REGION.CURRENT;
    this._isPrimary   = false;
    this._epoch       = 0;
    this._timer       = null;
    this._running     = false;
  }

  get regionId()    { return this._regionId; }
  get isPrimary()   { return this._isPrimary; }
  get epoch()       { return this._epoch; }

  async start() {
    if (this._running) return;
    this._running = true;

    await this._register();
    await this._tryAcquireLeadership();

    // Heartbeat loop: renew leadership + update region heartbeat
    this._timer = setInterval(() => this._tick(), HEARTBEAT_MS);

    logger.info(
      { region: this._regionId, isPrimary: this._isPrimary, epoch: this._epoch },
      '[region-manager] Started',
    );
  }

  async stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);

    // Mark region as draining in registry
    await db.query(
      `UPDATE region_registry SET role = 'draining', last_heartbeat = NOW()
       WHERE region_id = $1`,
      [this._regionId],
    ).catch(() => {});

    logger.info({ region: this._regionId }, '[region-manager] Stopped');
  }

  /**
   * Returns true if this region currently holds the primary lease.
   * Use to gate leader-only operations.
   */
  isLocalRegionPrimary() {
    return this._isPrimary;
  }

  /**
   * Returns the current epoch. Workers include this in claim metadata
   * for audit / replay reconstruction.
   */
  getCurrentEpoch() {
    return this._epoch;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  async _register() {
    await db.query(
      `INSERT INTO region_registry (region_id, role, epoch, last_heartbeat)
       VALUES ($1, 'secondary', 1, NOW())
       ON CONFLICT (region_id) DO UPDATE
         SET last_heartbeat = NOW(), role = CASE
           WHEN region_registry.role = 'draining' THEN 'secondary'
           ELSE region_registry.role
         END`,
      [this._regionId],
    );
  }

  async _tryAcquireLeadership() {
    try {
      const { rows } = await db.query(
        'SELECT acquire_region_leader($1, $2) AS acquired',
        [this._regionId, LEADER_LEASE_MS],
      );
      const acquired = rows[0]?.acquired ?? false;

      if (acquired) {
        if (!this._isPrimary) {
          logger.info({ region: this._regionId }, '[region-manager] Became PRIMARY');
        }
        this._isPrimary = true;

        // Fetch current epoch
        const { rows: lockRows } = await db.query(
          `SELECT epoch FROM region_leader_lock WHERE lock_key = 'global_leader'`,
        );
        this._epoch = lockRows[0]?.epoch ?? this._epoch;
      } else {
        if (this._isPrimary) {
          logger.warn({ region: this._regionId }, '[region-manager] Lost PRIMARY status — another region holds lock');
        }
        this._isPrimary = false;

        // Fetch primary's epoch for our own fencing awareness
        const { rows: lockRows } = await db.query(
          `SELECT epoch FROM region_leader_lock WHERE lock_key = 'global_leader'`,
        );
        this._epoch = lockRows[0]?.epoch ?? this._epoch;
      }

      // Update our registry row
      await db.query(
        `UPDATE region_registry
         SET role = $2, epoch = $3, last_heartbeat = NOW()
         WHERE region_id = $1`,
        [this._regionId, this._isPrimary ? 'primary' : 'secondary', this._epoch],
      );
    } catch (err) {
      logger.error({ err }, '[region-manager] Leadership acquisition error');
    }
  }

  async _tick() {
    if (!this._running) return;
    try {
      await this._tryAcquireLeadership();
    } catch (err) {
      logger.error({ err }, '[region-manager] Heartbeat tick failed');
    }
  }
}

// Singleton per process
const regionManager = new RegionManager();

module.exports = regionManager;