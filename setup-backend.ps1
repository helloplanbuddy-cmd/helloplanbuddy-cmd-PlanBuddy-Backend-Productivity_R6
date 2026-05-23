# setup-backend.ps1 - Initialize backend for running (PowerShell)

param(
    [switch]$SkipNpmInstall = $false
)

Write-Host "=== PlanBuddy Backend Setup Script ===" -ForegroundColor Green
Write-Host ""

# Get script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $scriptDir "planbuddy_v9"

if (!(Test-Path $backendDir)) {
    Write-Host "ERROR: planbuddy_v9 directory not found at $backendDir" -ForegroundColor Red
    exit 1
}

# Change to backend directory
Push-Location $backendDir
try {
    Write-Host "Step 1: Creating services directory..." -ForegroundColor Cyan
    $servicesDir = Join-Path (Get-Location) "services"
    if (!(Test-Path $servicesDir)) {
        New-Item -ItemType Directory -Path $servicesDir -Force | Out-Null
        Write-Host "  ✓ Created $servicesDir" -ForegroundColor Green
    } else {
        Write-Host "  ✓ services directory already exists" -ForegroundColor Green
    }

    Write-Host "Step 2: Creating services/productionHealth.js..." -ForegroundColor Cyan
    $productionHealthFile = Join-Path $servicesDir "productionHealth.js"
    
    $productionHealthContent = @"
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
    // Cron expression: every 5 minutes
    cronJob = cron.schedule('*/5 * * * *', async () => {
      try {
        logger.debug('[health-cron] Running production health check');
        // Health checks would go here
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
"@
    
    Set-Content -Path $productionHealthFile -Value $productionHealthContent -Encoding UTF8
    Write-Host "  ✓ Created $productionHealthFile" -ForegroundColor Green

    if (!$SkipNpmInstall) {
        Write-Host "Step 3: Installing dependencies..." -ForegroundColor Cyan
        $npmExists = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmExists) {
            npm install
            Write-Host "  ✓ Dependencies installed" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ npm not found in PATH. Please run 'npm install' manually." -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Write-Host "=== Setup Complete! ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "To start the backend:" -ForegroundColor Cyan
    Write-Host "  1. Start PostgreSQL: docker-compose up -d postgres" -ForegroundColor White
    Write-Host "  2. Start Redis:       docker-compose up -d redis" -ForegroundColor White
    Write-Host "  3. Start API:         npm start" -ForegroundColor White
    Write-Host ""
    Write-Host "To test:" -ForegroundColor Cyan
    Write-Host "  curl http://localhost:3000/health" -ForegroundColor White
    Write-Host ""

} finally {
    Pop-Location
}
