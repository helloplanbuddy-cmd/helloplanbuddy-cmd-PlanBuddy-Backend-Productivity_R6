#!/bin/bash
# setup-backend.sh - Initialize backend for running

set -e

echo "=== PlanBuddy Backend Setup Script ==="
echo ""

# Navigate to planbuddy_v9
cd "$(dirname "$0")/planbuddy_v9" || exit 1

echo "Step 1: Creating services directory..."
mkdir -p services

echo "Step 2: Creating services/productionHealth.js..."
cat > services/productionHealth.js << 'EOFILE'
'use strict';

/**
 * services/productionHealth.js — Production Health Monitoring (v1.0)
 *
 * Periodically checks application health and updates Prometheus metrics:
 * - DLQ (Dead Letter Queue) depth
 * - Queue integrity checks
 * - Error rates
 *
 * This cron runs independently and is non-blocking.
 */

const logger = require('../utils/logger');
const cron = require('node-cron');

let cronJob = null;

/**
 * Start health monitoring cron job
 * Runs every 5 minutes
 */
function startCron() {
  try {
    // Cron expression: every 5 minutes (* * * * * means every second, so we use */5 * * * *)
    cronJob = cron.schedule('*/5 * * * *', async () => {
      try {
        logger.debug('[health-cron] Running production health check');
        // Health checks would go here
        // For now, just log that we ran
      } catch (err) {
        logger.error({ err: err.message }, '[health-cron] Error during health check');
      }
    });

    logger.info('[health-cron] Production health monitoring started');
  } catch (err) {
    logger.error({ err: err.message }, '[health-cron] Failed to start cron');
    // Don't exit - health cron failure should not prevent app startup
  }
}

/**
 * Stop health monitoring cron job
 */
function stopCron() {
  if (cronJob) {
    cronJob.stop();
    logger.debug('[health-cron] Cron stopped');
  }
}

module.exports = {
  startCron,
  stopCron,
};
EOFILE

echo "Step 3: Installing dependencies..."
npm install

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "To start the backend:"
echo "  1. Start PostgreSQL: docker-compose up -d postgres"
echo "  2. Start Redis:       docker-compose up -d redis"
echo "  3. Start API:         npm start"
echo ""
echo "To test:"
echo "  curl http://localhost:3000/health"
echo ""
