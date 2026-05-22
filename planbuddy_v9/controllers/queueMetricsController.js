'use strict';

/**
 * controllers/queueMetricsController.js — Queue Metrics & Dashboard API
 *
 * Exposes:
 *   - /internal/metrics/queues (JSON stats for dashboard)
 *   - /metrics (Prometheus format for scraping)
 */

const logger = require('../utils/logger');
const queueMonitoring = require('../utils/queueMonitoring');
const register = require('prom-client').register;

// ─── GET /internal/metrics/queues ─────────────────────────────────────────────

/**
 * JSON API for dashboard: current queue status and depth
 */
exports.getQueueMetrics = async (req, res, next) => {
  try {
    const queues = require('../config/queues');

    // Get detailed stats for all queues
    const queueStats = await queueMonitoring.getAllQueueStats(queues);

    // Get queue health summary
    const queueHealth = await queueMonitoring.getQueueHealth(queues);

    res.json({
      timestamp: new Date().toISOString(),
      health: queueHealth,
      queues: queueStats,
    });
  } catch (err) {
    logger.error({ err }, '[queue-metrics] Error getting queue metrics');
    next(err);
  }
};

// ─── GET /metrics — Prometheus format ─────────────────────────────────────────

/**
 * Prometheus-compatible metrics endpoint
 * Used by Prometheus to scrape metrics every 15-60 seconds
 */
exports.getPrometheusMetrics = async (req, res, next) => {
  try {
    // Trigger queue stats collection to update metrics
    const queues = require('../config/queues');
    await queueMonitoring.getAllQueueStats(queues);

    // Return Prometheus-formatted metrics
    const metrics = await register.metrics();
    res.set('Content-Type', register.contentType);
    res.end(metrics);
  } catch (err) {
    logger.error({ err }, '[prometheus] Error generating metrics');
    res.status(500).end('Failed to generate metrics');
  }
};

module.exports = exports;
