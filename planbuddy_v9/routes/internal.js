'use strict';

const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');
const queueMetricsController = require('../controllers/queueMetricsController');
const productionHealth = require('../services/productionHealth');

/**
 * Internal observability routes (/internal/*)
 * No auth — IP restricted via app.js + prometheus IP guard.
 */

// Health endpoints
router.get('/health/live', healthController.live);
router.get('/health/ready', healthController.ready);
router.get('/health/readiness', healthController.readiness);
router.get('/health/detailed', healthController.detailed);
router.get('/health/production', healthController.production);

// Trigger manual integrity check (debug only)
router.post('/health/check-integrity', async (req, res, next) => {
  try {
    await productionHealth.checkIntegrity();
    res.json({ status: 'check triggered' });
  } catch (err) {
    next(err);
  }
});

// Queue metrics endpoints
router.get('/metrics/queues', queueMetricsController.getQueueMetrics);
router.get('/metrics', queueMetricsController.getPrometheusMetrics);

module.exports = router;
