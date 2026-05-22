'use strict';

/**
 * workers/notify-listener.js  (v3)
 *
 * LISTEN/NOTIFY WAKEUP SYSTEM
 * ────────────────────────────
 * PostgreSQL LISTEN/NOTIFY eliminates idle polling overhead.
 * Workers wake immediately on INSERT instead of waiting for the next poll interval.
 *
 * Features:
 *   + Reconnect handling with exponential backoff
 *   + Per-queue notification debouncing (prevents storm on bulk inserts)
 *   + Fallback polling if notifications are missed (heartbeat-safe)
 *   + Shard-aware routing (notification carries shard_key)
 *   + Race-safe: notification is advisory — workers always verify via DB claim
 *
 * CRITICAL: Notifications are best-effort. Workers MUST still poll as fallback.
 *           A notification that is missed does not cause a stuck job.
 */

const { EventEmitter } = require('events');
const db     = require('../config/db');
const logger = require('../utils/logger');

const CHANNEL           = 'queue_wakeup';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS  = 30_000;
const DEBOUNCE_MS       = 50; // coalesce notifications within 50ms window

class NotifyListener extends EventEmitter {
  constructor() {
    super();
    this._client          = null;
    this._connected       = false;
    this._reconnectTimer  = null;
    this._reconnectCount  = 0;
    this._debounceTimers  = {}; // per-table debounce
    this._stopping        = false;
  }

  /**
   * Start listening. Resolves once the first connection is established.
   * Workers call this on startup then register event listeners.
   *
   * Events emitted:
   *   'wakeup' — { table, shard_key, priority }
   */
  async start() {
    await this._connect();
    logger.info({ channel: CHANNEL }, '[notify-listener] Started — listening for queue wakeups');
  }

  async stop() {
    this._stopping = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._client) {
      try {
        await this._client.query(`UNLISTEN ${CHANNEL}`);
        this._client.removeAllListeners();
        this._client.release(true); // force-release (destroy) back to pool
      } catch (_) {}
    }
    this.removeAllListeners();
    logger.info('[notify-listener] Stopped');
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  async _connect() {
    if (this._stopping) return;

    try {
      this._client = await db.getClient();

      // Dedicated connection for LISTEN — must not be returned to pool during operation
      // We keep it checked out for the lifetime of this listener.

      this._client.on('notification', (msg) => this._onNotification(msg));
      this._client.on('error', (err) => this._onError(err));
      this._client.on('end', () => this._onEnd());

      await this._client.query(`LISTEN ${CHANNEL}`);

      this._connected     = true;
      this._reconnectCount = 0;
      logger.info('[notify-listener] Connected and listening');
      this.emit('connected');
    } catch (err) {
      logger.error({ err }, '[notify-listener] Connection failed — will retry');
      this._scheduleReconnect();
    }
  }

  _onNotification(msg) {
    if (msg.channel !== CHANNEL) return;

    let payload;
    try {
      payload = JSON.parse(msg.payload);
    } catch {
      payload = { table: 'unknown' };
    }

    const { table, shard_key: shardKey } = payload;
    const debounceKey = `${table}:${shardKey ?? '*'}`;

    // Debounce: coalesce rapid notifications to avoid a poll per INSERT on bulk load
    if (this._debounceTimers[debounceKey]) return;

    this._debounceTimers[debounceKey] = setTimeout(() => {
      delete this._debounceTimers[debounceKey];
      this.emit('wakeup', payload);
    }, DEBOUNCE_MS);
  }

  _onError(err) {
    logger.error({ err }, '[notify-listener] Client error');
    this._connected = false;
    this._scheduleReconnect();
  }

  _onEnd() {
    if (this._stopping) return;
    logger.warn('[notify-listener] Connection ended unexpectedly');
    this._connected = false;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopping || this._reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this._reconnectCount,
      RECONNECT_MAX_MS,
    );
    this._reconnectCount++;

    logger.info({ delay, attempt: this._reconnectCount }, '[notify-listener] Scheduling reconnect');

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        if (this._client) {
          this._client.removeAllListeners();
          try { this._client.release(true); } catch (_) {}
          this._client = null;
        }
      } catch (_) {}
      await this._connect();
    }, delay);
  }

  /**
   * Returns true if currently connected and listening.
   */
  get isConnected() {
    return this._connected;
  }
}

// Singleton — one LISTEN connection per process
const listener = new NotifyListener();

module.exports = listener;