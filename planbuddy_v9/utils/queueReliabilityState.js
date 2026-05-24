'use strict';

/**
 * utils/queueReliabilityState.js
 *
 * Production queue reliability telemetry registry (in-memory).
 *
 * STEP 1: Telemetry Core ONLY (NO I/O, no dependencies).
 */

// Explicit state schema (deterministic, memory-only)
const defaultState = () => ({
  redis: {
    connected: false,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastError: null,
    circuitOpen: false,
  },

  queues: {
    initialized: false,
    lastInitAt: null,
    initErrors: [],
  },

  scheduler: {
    active: false,
    lastHeartbeat: null,
    lastError: null,
  },

  workers: {
    // [workerName]: { active, lastHeartbeat, lastJobAt, lastError }
  },

  backlog: {
    total: 0,
    worstQueue: null,
    worstDepth: 0,
    degraded: false,
    // optional signal quality
    lastUpdatedAt: null,
    lastError: null,
  },

  // health inputs metadata (deterministic)
  _meta: {
    lastStatusComputedAt: null,
  },
});

// Singleton instance
const state = defaultState();

function nowTs() {
  return Date.now();
}

function setState(next) {
  // Deterministic overwrite with shallow validation.
  // If caller provides partial shape, we merge explicitly.
  updatePartial(next);
}

function updatePartial(patch) {
  if (!patch || typeof patch !== 'object') return;

  if (patch.redis && typeof patch.redis === 'object') {
    Object.assign(state.redis, patch.redis);
  }

  if (patch.queues && typeof patch.queues === 'object') {
    Object.assign(state.queues, patch.queues);
    if (Array.isArray(patch.queues.initErrors)) {
      state.queues.initErrors = patch.queues.initErrors;
    }
  }

  if (patch.scheduler && typeof patch.scheduler === 'object') {
    Object.assign(state.scheduler, patch.scheduler);
  }

  if (patch.workers && typeof patch.workers === 'object') {
    for (const [workerName, workerPatch] of Object.entries(patch.workers)) {
      if (!state.workers[workerName]) {
        state.workers[workerName] = {
          active: false,
          lastHeartbeat: null,
          lastJobAt: null,
          lastError: null,
        };
      }
      Object.assign(state.workers[workerName], workerPatch || {});
    }
  }

  if (patch.backlog && typeof patch.backlog === 'object') {
    Object.assign(state.backlog, patch.backlog);
  }

  if (patch._meta && typeof patch._meta === 'object') {
    Object.assign(state._meta, patch._meta);
  }
}

function getSnapshot() {
  // O(1) structured snapshot (shallow clone to prevent mutation)
  return {
    redis: { ...state.redis },
    queues: {
      ...state.queues,
      initErrors: Array.isArray(state.queues.initErrors)
        ? [...state.queues.initErrors]
        : [],
    },
    scheduler: { ...state.scheduler },
    workers: Object.fromEntries(
      Object.entries(state.workers).map(([name, w]) => [name, { ...w }])
    ),
    backlog: { ...state.backlog },
    _meta: { ...state._meta },
  };
}

function resetForTests() {
  const fresh = defaultState();
  // overwrite state in place
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, fresh);
}

// Deterministic health computation rules
function computeStatus({ staleAfterMs = 60_000, backlogWarnDepth = 1000 } = {}) {
  const s = state;
  const ts = nowTs();

  const redisOk = !!s.redis.connected && !s.redis.circuitOpen;
  const schedulerOk =
    !!s.scheduler.active &&
    typeof s.scheduler.lastHeartbeat === 'number' &&
    ts - s.scheduler.lastHeartbeat <= staleAfterMs;

  const workers = s.workers;
  const workerEntries = Object.entries(workers);

  // If no worker telemetry exists yet, treat as degraded (no fail-open)
  const workerOk =
    workerEntries.length > 0 &&
    workerEntries.every(([_, w]) => {
      const activeOk = !!w.active;
      const heartbeatOk =
        typeof w.lastHeartbeat === 'number' && ts - w.lastHeartbeat <= staleAfterMs;
      // lastJobAt can be stale if workload idle; use heartbeat for liveness.
      return activeOk && heartbeatOk;
    });

  const queuesOk = !!s.queues.initialized && s.queues.initErrors.length === 0;

  const backlogDegraded = !!s.backlog.degraded || (s.backlog.worstDepth || 0) >= backlogWarnDepth;

  const anyRedisBad = !redisOk;
  const anyWorkerBad = !workerOk;
  const anySchedulerBad = !schedulerOk;

  // Color model: RED = hard transport/liveness issues, YELLOW = backlog/partial.
  let health = 'green';
  let reason = [];

  if (anyRedisBad) {
    health = 'red';
    reason.push('redis_down_or_circuit_open');
  }

  if (anyWorkerBad) {
    health = health === 'red' ? 'red' : 'red';
    reason.push('workers_unhealthy_or_stale');
  }

  if (anySchedulerBad) {
    health = health === 'red' ? 'red' : 'red';
    reason.push('scheduler_unhealthy_or_stale');
  }

  if (health !== 'red') {
    if (!queuesOk) {
      health = 'yellow';
      reason.push('queues_not_initialized_or_errors');
    }

    if (backlogDegraded) {
      health = health === 'yellow' ? 'yellow' : 'yellow';
      reason.push('backlog_degraded');
    }

    if (health === 'green' && reason.length === 0) {
      health = 'green';
      reason.push('stable');
    }
  }

  // Map to readiness status used by controller.
  const readiness = health === 'green' ? 'ready' : 'degraded';

  return {
    readiness, // 'ready' | 'degraded'
    health, // 'green' | 'yellow' | 'red'
    reason,
    computedAt: new Date(ts).toISOString(),
    redisOk,
    queuesOk,
    schedulerOk,
    workerOk,
    backlogDegraded,
  };
}

module.exports = {
  setState,
  updatePartial,
  getSnapshot,
  computeStatus,
  resetForTests,

  // Mutators (pure, memory-only)
  markRedisConnected() {
    state.redis.connected = true;
    state.redis.lastConnectedAt = nowTs();
    state.redis.lastDisconnectedAt = null;
    state.redis.lastError = null;
    state.redis.circuitOpen = false;
  },

  markRedisDisconnected(error) {
    state.redis.connected = false;
    state.redis.lastDisconnectedAt = nowTs();
    state.redis.lastError = error || null;
  },

  setRedisCircuitOpen(open) {
    state.redis.circuitOpen = !!open;
    if (open) {
      // keep disconnected time as-is; circuit open can happen while connected
      state.redis.lastError = state.redis.lastError || 'circuit_open';
    }
  },

  markQueueInitialized() {
    state.queues.initialized = true;
    state.queues.lastInitAt = nowTs();
    state.queues.initErrors = [];
  },

  markQueueInitError(error) {
    state.queues.initialized = false;
    state.queues.initErrors.push(String(error?.message || error));
    state.queues.lastInitAt = nowTs();
  },

  markSchedulerActive() {
    state.scheduler.active = true;
    state.scheduler.lastHeartbeat = nowTs();
    state.scheduler.lastError = null;
  },

  markSchedulerHeartbeat() {
    if (!state.scheduler.active) {
      state.scheduler.active = true;
    }
    state.scheduler.lastHeartbeat = nowTs();
    state.scheduler.lastError = null;
  },

  markSchedulerError(error) {
    state.scheduler.active = false;
    state.scheduler.lastError = String(error?.message || error);
  },

  markWorkerHeartbeat(workerName, { active = true, lastJobAt = null, error = null } = {}) {
    if (!workerName) return;
    if (!state.workers[workerName]) {
      state.workers[workerName] = {
        active: false,
        lastHeartbeat: null,
        lastJobAt: null,
        lastError: null,
      };
    }
    state.workers[workerName].active = !!active;
    state.workers[workerName].lastHeartbeat = nowTs();
    if (lastJobAt !== null) state.workers[workerName].lastJobAt = lastJobAt;
    if (error !== null) state.workers[workerName].lastError = error;
  },

  markWorkerError(workerName, error) {
    if (!workerName) return;
    if (!state.workers[workerName]) {
      state.workers[workerName] = {
        active: false,
        lastHeartbeat: null,
        lastJobAt: null,
        lastError: null,
      };
    }
    state.workers[workerName].active = false;
    state.workers[workerName].lastError = String(error?.message || error);
    state.workers[workerName].lastHeartbeat = nowTs();
  },

  updateBacklog({ total = 0, worstQueue = null, worstDepth = 0, degraded = false, lastError = null } = {}) {
    state.backlog.total = Number(total) || 0;
    state.backlog.worstQueue = worstQueue || null;
    state.backlog.worstDepth = Number(worstDepth) || 0;
    state.backlog.degraded = !!degraded;
    state.backlog.lastUpdatedAt = nowTs();
    state.backlog.lastError = lastError ? String(lastError) : null;
  },
};

