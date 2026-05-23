#!/usr/bin/env node
'use strict';

/**
 * Simple environment check script
 * Runs without dependencies to verify config/env.js works
 */

console.log('=== PlanBuddy Backend Environment Check ===\n');

// Check if .env file exists
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envExists = fs.existsSync(envPath);
console.log(`✓ .env file exists: ${envExists}`);

const envJsPath = path.join(__dirname, 'config', 'env.js');
const envJsExists = fs.existsSync(envJsPath);
console.log(`✓ config/env.js exists: ${envJsExists}`);

if (!envExists || !envJsExists) {
  console.log('\n❌ CRITICAL: Missing configuration files');
  process.exit(1);
}

// Try loading env module
try {
  const env = require('./config/env');
  console.log('\n✓ config/env.js loaded successfully');
  console.log(`  PORT: ${env.PORT}`);
  console.log(`  NODE_ENV: ${env.NODE_ENV}`);
  console.log(`  DATABASE_URL: ${env.DATABASE_URL.substring(0, 30)}...`);
  console.log(`  REDIS_URL: ${env.REDIS_URL}`);
} catch (e) {
  console.log('\n❌ Failed to load config/env.js');
  console.log(`Error: ${e.message}`);
  process.exit(1);
}

console.log('\n✓ Environment check passed!\n');
process.exit(0);
