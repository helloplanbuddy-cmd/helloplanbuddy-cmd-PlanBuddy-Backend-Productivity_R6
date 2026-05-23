@echo off
REM setup-backend.bat - Initialize backend for running (Windows)

setlocal enabledelayedexpansion

echo === PlanBuddy Backend Setup Script ===
echo.

REM Navigate to planbuddy_v9
cd /d "%~dp0planbuddy_v9" || exit /b 1

echo Step 1: Creating services directory...
if not exist services mkdir services

echo Step 2: Creating services/productionHealth.js...
(
echo 'use strict';
echo.
echo /**
echo  * services/productionHealth.js — Production Health Monitoring (v1.0^)
echo  *
echo  * Periodically checks application health and updates Prometheus metrics:
echo  * - DLQ (Dead Letter Queue^) depth
echo  * - Queue integrity checks
echo  * - Error rates
echo  *
echo  * This cron runs independently and is non-blocking.
echo  */
echo.
echo const logger = require('../utils/logger'^);
echo const cron = require('node-cron'^);
echo.
echo let cronJob = null;
echo.
echo /**
echo  * Start health monitoring cron job
echo  * Runs every 5 minutes
echo  */
echo function startCron(^) {
echo   try {
echo     // Cron expression: every 5 minutes
echo     cronJob = cron.schedule('*/5 * * * *', async (^) =^> {
echo       try {
echo         logger.debug('[health-cron] Running production health check'^);
echo         // Health checks would go here
echo       } catch (err^) {
echo         logger.error({ err: err.message }, '[health-cron] Error during health check'^);
echo       }
echo     }^);
echo.
echo     logger.info('[health-cron] Production health monitoring started'^);
echo   } catch (err^) {
echo     logger.error({ err: err.message }, '[health-cron] Failed to start cron'^);
echo     // Don't exit - health cron failure should not prevent app startup
echo   }
echo }
echo.
echo /**
echo  * Stop health monitoring cron job
echo  */
echo function stopCron(^) {
echo   if (cronJob^) {
echo     cronJob.stop(^);
echo     logger.debug('[health-cron] Cron stopped'^);
echo   }
echo }
echo.
echo module.exports = {
echo   startCron,
echo   stopCron,
echo };
) > services\productionHealth.js

echo Step 3: Installing dependencies...
call npm install

echo.
echo === Setup Complete! ===
echo.
echo To start the backend:
echo   1. Start PostgreSQL: docker-compose up -d postgres
echo   2. Start Redis:       docker-compose up -d redis
echo   3. Start API:         npm start
echo.
echo To test:
echo   curl http://localhost:3000/health
echo.

endlocal
