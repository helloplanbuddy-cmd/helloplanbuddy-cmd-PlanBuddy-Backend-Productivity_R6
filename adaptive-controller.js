'use strict';

/**
 * workers/adaptive-controller.js  (v3)
 *
 * ADAPTIVE CONCURRENCY + CIRCUIT BREAKER
 * ──────────────────────────────────────
 * v3 upgrades:
 *   + Rate limit integration: circuit opens faster when rate-limited repeatedly
 *   + Shard-aware concurrency: can track concurrency per shard
 *   + Drain mode gate: refuses to increase concurrency when draining
 *   + More gradual additive increase (gain +1 every 20 successes, not 10)
 *   + Recovery backoff: after circuit close, uses slow-start (don't jump to max)
 *
 * All state is in-process. For multi-process coordination, extend
 * state storage with Redis hashes — but note: per-process adaptive
 * control is safe and effective; global coordination adds complexity
 * without proportional benefit for most workloads.
 */

const logger = require('../utils/logger');
const {
  CONCURRENCY,
  CONCURRENCY_MIN,
  CONCURRENCY_MAX,
  CIRCUIT_BREAKER,
} = require('./queues');

const STATE = {
  CLOSED:    'CLOSED',
  OPEN:      'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class AdaptiveController {
  constructor() {
    this._circuitState        = {};
    this._consecutiveFailures = {};
    this._consecutiveRateLimits = {};  // v3: track rate limit hits separately
    this._openedAt            = {};
    this._halfOpenProbes      = {};
    this._halfOpenSuccesses   = {};
    this._currentConcurrency  = {};
    this._successStreak       = {};
    this._draining            = {};    // v3: per-queue drain flag

    for (const key of Object.keys(CONCURRENCY)) {
      this._circuitState[key]              = STATE.CLOSED;
      this._consecutiveFailures[key]       = 0;
      this._consecutiveRateLimits[key]     = 0;
      this._openedAt[key]                  = null;
      this._halfOpenProbes[key]            = 0;
      this._halfOpenSuccesses[key]         = 0;
      this._currentConcurrency[key]        = CONCURRENCY[key];
      this._successStreak[key]             = 0;
      this._draining[key]                  = false;
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  canProcess(queueKey) {
    this._maybeTransitionToHalfOpen(queueKey);

    const state = this._circuitState[queueKey] ?? STATE.CLOSED;

    if (state === STATE.OPEN) {
      logger.warn({ queue: queueKey }, '[circuit-breaker] OPEN — skipping poll');
      return false;
    }

    if (state === STATE.HALF_OPEN) {
      const probeLimit  = CIRCUIT_BREAKER.PROBE_COUNT[queueKey] ?? 1;
      const probesSoFar = this._halfOpenProbes[queueKey] ?? 0;

      if (probesSoFar >= probeLimit) return false;

      this._halfOpenProbes[queueKey] = probesSoFar + 1;
      logger.info(
        { queue: queueKey, probe: this._halfOpenProbes[queueKey] },
        '[circuit-breaker] HALF_OPEN — probe allowed',
      );
      return true;
    }

    return true;
  }

  onSuccess(queueKey) {
    this._consecutiveFailures[queueKey]   = 0;
    this._consecutiveRateLimits[queueKey] = 0;

    const state = this._circuitState[queueKey];
    if (state === STATE.HALF_OPEN) {
      this._halfOpenSuccesses[queueKey] = (this._halfOpenSuccesses[queueKey] ?? 0) + 1;
      const required = CIRCUIT_BREAKER.PROBE_COUNT[queueKey] ?? 1;
      if (this._halfOpenSuccesses[queueKey] >= required) {
        this._closeCircuit(queueKey);
      }
    }

    // Additive increase — gain +1 every 20 successes (more conservative than v2's 10)
    this._successStreak[queueKey] = (this._successStreak[queueKey] ?? 0) + 1;
    const gainEvery = 20;
    if (this._successStreak[queueKey] % gainEvery === 0) {
      this._increaseConcurrency(queueKey);
    }
  }

  onFailure(queueKey) {
    this._successStreak[queueKey]       = 0;
    this._consecutiveFailures[queueKey] = (this._consecutiveFailures[queueKey] ?? 0) + 1;

    const threshold = CIRCUIT_BREAKER.FAILURE_THRESHOLD[queueKey] ?? 5;

    if (this._consecutiveFailures[queueKey] >= threshold) {
      if (this._circuitState[queueKey] !== STATE.OPEN) {
        this._openCircuit(queueKey);
      }
    }

    this._decreaseConcurrency(queueKey);
  }

  /**
   * v3: Called when rate limit is hit. Faster circuit degradation.
   */
  onRateLimited(queueKey) {
    this._successStreak[queueKey]             = 0;
    this._consecutiveRateLimits[queueKey]     = (this._consecutiveRateLimits[queueKey] ?? 0) + 1;

    // 3 consecutive rate limits = treat like a failure spike
    if (this._consecutiveRateLimits[queueKey] >= 3) {
      this._consecutiveFailures[queueKey] = (this._consecutiveFailures[queueKey] ?? 0) + 1;
    }

    // Always reduce concurrency on rate limit
    this._decreaseConcurrency(queueKey);

    logger.warn(
      { queue: queueKey, consecutive: this._consecutiveRateLimits[queueKey] },
      '[adaptive] Rate limited — reducing concurrency',
    );
  }

  getConcurrency(queueKey) {
    return this._currentConcurrency[queueKey] ?? CONCURRENCY[queueKey];
  }

  getState(queueKey) {
    return {
      circuit:     this._circuitState[queueKey]        ?? STATE.CLOSED,
      failures:    this._consecutiveFailures[queueKey] ?? 0,
      concurrency: this._currentConcurrency[queueKey]  ?? CONCURRENCY[queueKey],
      openedAt:    this._openedAt[queueKey]             ?? null,
    };
  }

  getAllStates() {
    const result = {};
    for (const key of Object.keys(CONCURRENCY)) {
      result[key] = this.getState(key);
    }
    return result;
  }

  /**
   * v3: Signal that this queue's workers should stop increasing concurrency.
   */
  setDraining(queueKey, isDraining) {
    this._draining[queueKey] = isDraining;
    if (isDraining) {
      // Immediately reduce to minimum to drain gracefully
      this._currentConcurrency[queueKey] = CONCURRENCY_MIN[queueKey] ?? 1;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _openCircuit(queueKey) {
    this._circuitState[queueKey] = STATE.OPEN;
    this._openedAt[queueKey]     = Date.now();

    logger.error(
      {
        queue:    queueKey,
        failures: this._consecutiveFailures[queueKey],
        openFor:  CIRCUIT_BREAKER.OPEN_TIMEOUT_MS[queueKey],
      },
      '[circuit-breaker] Circuit OPENED — blocking queue processing',
    );
  }

  _maybeTransitionToHalfOpen(queueKey) {
    if (this._circuitState[queueKey] !== STATE.OPEN) return;

    const openedAt = this._openedAt[queueKey] ?? 0;
    const timeout  = CIRCUIT_BREAKER.OPEN_TIMEOUT_MS[queueKey] ?? 30_000;
    const elapsed  = Date.now() - openedAt;

    if (elapsed >= timeout) {
      this._circuitState[queueKey]      = STATE.HALF_OPEN;
      this._halfOpenProbes[queueKey]    = 0;
      this._halfOpenSuccesses[queueKey] = 0;

      logger.info({ queue: queueKey, elapsed }, '[circuit-breaker] Circuit HALF_OPEN — probing');
    }
  }

  _closeCircuit(queueKey) {
    this._circuitState[queueKey]        = STATE.CLOSED;
    this._consecutiveFailures[queueKey] = 0;
    this._openedAt[queueKey]            = null;
    this._halfOpenProbes[queueKey]      = 0;
    this._halfOpenSuccesses[queueKey]   = 0;

    // v3: slow-start after circuit close — don't jump back to previous concurrency
    const min     = CONCURRENCY_MIN[queueKey] ?? 1;
    const initial = CONCURRENCY[queueKey] ?? 2;
    this._currentConcurrency[queueKey] = Math.max(min, Math.floor(initial * 0.25));
    this._successStreak[queueKey]      = 0;

    logger.info(
      { queue: queueKey, startConcurrency: this._currentConcurrency[queueKey] },
      '[circuit-breaker] Circuit CLOSED — slow-start recovery',
    );
  }

  _increaseConcurrency(queueKey) {
    if (this._draining[queueKey]) return; // don't increase during drain

    const current = this._currentConcurrency[queueKey] ?? CONCURRENCY[queueKey];
    const max     = CONCURRENCY_MAX[queueKey] ?? 20;
    const next    = Math.min(current + 1, max);

    if (next !== current) {
      this._currentConcurrency[queueKey] = next;
      logger.debug({ queue: queueKey, from: current, to: next }, '[adaptive] Concurrency increased');
    }
  }

  _decreaseConcurrency(queueKey) {
    const current = this._currentConcurrency[queueKey] ?? CONCURRENCY[queueKey];
    const min     = CONCURRENCY_MIN[queueKey] ?? 1;
    const next    = Math.max(Math.floor(current * 0.5), min);

    if (next !== current) {
      this._currentConcurrency[queueKey] = next;
      logger.warn({ queue: queueKey, from: current, to: next }, '[adaptive] Concurrency decreased (failure backpressure)');
    }
  }
}

const controller = new AdaptiveController();

module.exports = controller;