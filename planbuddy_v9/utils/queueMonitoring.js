'use strict';

/**
 * utils/queueMonitoring.js — Queue Backlog Monitoring & Alerts
 *
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides real-time visibility into queue depths and job states:
 *   - Queue size (pending jobs)
 *   - Active jobs (currently processing)
 *   - Delayed jobs (waiting for retry)
 *   - Failed/DLQ jobs (permanent failures)
 *   - Processing time metrics
 *
 * Used by:
 *   1. Health checks: /health/ready returns queue depth
 *   2. Metrics endpoint: /metrics exports queue size as Prometheus gauge
 *   3. Alerts: Alert when queue depth > threshold
 *   4. Dashboards: Grafana graphs queue depth trends
 */

const logger = require('./logger');
const monitoring = require('./monitoring');

// Thresholds for alerting
const QUEUE_DEPTH_WARN_THRESHOLD = 100;
const QUEUE_DEPTH_CRITICAL_THRESHOLD = 1000;
const JOB_PROCESSING_TIME_WARN_MS = 30000;  // 30 seconds

// Metrics
const queueDepthGauge = new (require('prom-client')).Gauge({
  name: 'job_queue_depth',
  help: 'Number of pending jobs in queue',
  labelNames: ['queue_name'],
});

const activeJobsGauge = new (require('prom-client')).Gauge({
  name: 'job_queue_active',
  help: 'Number of actively processing jobs',
  labelNames: ['queue_name'],
});

const failedJobsCounter = new (require('prom-client')).Counter({
  name: 'job_queue_failed_total',
  help: 'Total failed jobs (moved to DLQ)',
  labelNames: ['queue_name'],
});

const processingTimeHistogram = new (require('prom-client')).Histogram({
  name: 'job_processing_duration_ms',
  help: 'Job processing duration in milliseconds',
  labelNames: ['queue_name'],
  buckets: [100, 500, 1000, 5000, 10000, 30000, 60000],
});

// ─── Get Queue Stats ──────────────────────────────────────────────────────────

/**
 * Get detailed stats for a single queue
 */
async function getQueueStats(queue) {
  try {
    if (!queue) {
      logger.warn('[queue-monitoring] Queue is null/undefined');
      return null;
    }

    const [
      waiting,
      active,
      delayed,
      failed,
      completed,
    ] = await Promise.all([
      queue.getWaitingCount?.() || 0,
      queue.getActiveCount?.() || 0,
      queue.getDelayedCount?.() || 0,
      queue.getFailedCount?.() || 0,
      queue.getCompletedCount?.() || 0,
    ]);

    const stats = {
      name: queue.name,
      pending: waiting,
      active,
      delayed,
      failed,
      completed,
      total_depth: waiting + active + delayed,
    };

    return stats;
  } catch (err) {
    logger.error({ err, queue_name: queue?.name }, '[queue-monitoring] Error getting queue stats');
    return null;
  }
}

// ─── Get All Queue Stats ──────────────────────────────────────────────────────

/**
 * Get stats for all active queues
 */
async function getAllQueueStats(queues) {
  const stats = {};

  for (const [queueName, queue] of Object.entries(queues)) {
    const queueStats = await getQueueStats(queue);
    if (queueStats) {
      stats[queueName] = queueStats;

      // Update Prometheus metrics
      queueDepthGauge.set({ queue_name: queueName }, queueStats.pending);
      activeJobsGauge.set({ queue_name: queueName }, queueStats.active);

      // Check for alerts
      if (queueStats.pending > QUEUE_DEPTH_CRITICAL_THRESHOLD) {
        logger.error(
          { queue: queueName, depth: queueStats.pending },
          '[queue-monitoring] 🚨 CRITICAL: Queue depth exceeds threshold'
        );
      } else if (queueStats.pending > QUEUE_DEPTH_WARN_THRESHOLD) {
        logger.warn(
          { queue: queueName, depth: queueStats.pending },
          '[queue-monitoring] ⚠️ WARNING: Queue depth elevated'
        );
      }
    }
  }

  return stats;
}

// ─── Health Check Helper ──────────────────────────────────────────────────────

/**
 * Check queue health for inclusion in /health/ready
 * Returns: { healthy: boolean, totalBacklog: number, worstQueue: string }
 */
async function getQueueHealth(queues) {
  try {
    const stats = await getAllQueueStats(queues);

    let totalBacklog = 0;
    let worstQueue = null;
    let worstDepth = 0;

    for (const [queueName, queueStats] of Object.entries(stats)) {
      if (queueStats) {
        totalBacklog += queueStats.pending;
        if (queueStats.pending > worstDepth) {
          worstDepth = queueStats.pending;
          worstQueue = queueName;
        }
      }
    }

    const healthy = totalBacklog <= QUEUE_DEPTH_CRITICAL_THRESHOLD;

    return {
      healthy,
      totalBacklog,
      worstQueue,
      worstDepth,
      healthy_summary: healthy ? 'all_queues_healthy' : `${worstQueue}_backlog_high`,
    };
  } catch (err) {
    logger.error({ err }, '[queue-monitoring] Error checking queue health');
    return {
      healthy: true,  // fail-open: assume healthy if monitoring fails
      totalBacklog: 0,
      worstQueue: null,
      worstDepth: 0,
      healthy_summary: 'monitoring_unavailable',
    };
  }
}

// ─── Track Job Processing ─────────────────────────────────────────────────────

/**
 * Record job completion metrics
 * Call this when a job finishes (success or failure)
 */
function recordJobCompletion(queueName, processingTimeMs, success = true) {
  try {
    processingTimeHistogram.observe({ queue_name: queueName }, processingTimeMs);

    if (!success) {
      failedJobsCounter.inc({ queue_name: queueName });
    }

    if (processingTimeMs > JOB_PROCESSING_TIME_WARN_MS) {
      logger.warn(
        { queue: queueName, duration_ms: processingTimeMs },
        '[queue-monitoring] Slow job processing detected'
      );
    }
  } catch (err) {
    logger.error({ err }, '[queue-monitoring] Error recording job completion');
  }
}

// ─── Export Metrics for Prometheus ────────────────────────────────────────────

/**
 * Register queue monitoring with Prometheus registry
 */
function registerMetrics(register) {
  try {
    register.registerMetric(queueDepthGauge);
    register.registerMetric(activeJobsGauge);
    register.registerMetric(failedJobsCounter);
    register.registerMetric(processingTimeHistogram);
    logger.info('[queue-monitoring] Prometheus metrics registered');
  } catch (err) {
    if (err.message && err.message.includes('Duplicated metrics')) {
      logger.debug('[queue-monitoring] Metrics already registered (expected on reload)');
    } else {
      logger.error({ err }, '[queue-monitoring] Error registering metrics');
    }
  }
}

module.exports = {
  getQueueStats,
  getAllQueueStats,
  getQueueHealth,
  recordJobCompletion,
  registerMetrics,

  // Thresholds (exposed for testing/tuning)
  QUEUE_DEPTH_WARN_THRESHOLD,
  QUEUE_DEPTH_CRITICAL_THRESHOLD,
  JOB_PROCESSING_TIME_WARN_MS,

  // Metrics (exposed for Prometheus scraping)
  queueDepthGauge,
  activeJobsGauge,
  failedJobsCounter,
  processingTimeHistogram,
};
