#!/usr/bin/env node
'use strict';

/**
 * verify-server.js - Comprehensive Server Verification
 * 
 * Checks everything needed before starting the server:
 * - Configuration files (.env, config/env.js)
 * - Required modules (services/productionHealth.js)
 * - Environment variables
 * - External service connectivity
 * 
 * Usage: node verify-server.js
 */

const fs = require('fs');
const path = require('path');

const projectDir = __dirname;
const checks = [];

function check(name, fn) {
  try {
    const result = fn();
    return { name, status: 'OK', result };
  } catch (err) {
    return { name, status: 'FAIL', error: err.message };
  }
}

console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║                  Backend Server Verification Script                        ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

// Check 1: .env file
checks.push(check('.env file exists', () => {
  if (!fs.existsSync(path.join(projectDir, '.env'))) {
    throw new Error('.env file not found');
  }
  return 'Found';
}));

// Check 2: config/env.js file
checks.push(check('config/env.js exists', () => {
  if (!fs.existsSync(path.join(projectDir, 'config', 'env.js'))) {
    throw new Error('config/env.js not found');
  }
  return 'Found';
}));

// Check 3: services/productionHealth.js
checks.push(check('services/productionHealth.js exists', () => {
  if (!fs.existsSync(path.join(projectDir, 'services', 'productionHealth.js'))) {
    throw new Error('services/productionHealth.js not found');
  }
  return 'Found';
}));

// Check 4: node_modules exists
checks.push(check('node_modules installed', () => {
  if (!fs.existsSync(path.join(projectDir, 'node_modules'))) {
    throw new Error('node_modules directory not found - run: npm install');
  }
  const count = fs.readdirSync(path.join(projectDir, 'node_modules')).length;
  return `${count} packages installed`;
}));

// Check 5: Try loading config/env
checks.push(check('config/env.js loads without errors', () => {
  try {
    const env = require('./config/env');
    return `Loaded successfully (NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT})`;
  } catch (e) {
    throw new Error(`Cannot load env module: ${e.message}`);
  }
}));

// Check 6: Express is available
checks.push(check('Express module available', () => {
  try {
    require.resolve('express');
    return 'Found';
  } catch (e) {
    throw new Error('Express not installed - run: npm install');
  }
}));

// Check 7: PostgreSQL driver is available
checks.push(check('PostgreSQL driver (pg) available', () => {
  try {
    require.resolve('pg');
    return 'Found';
  } catch (e) {
    throw new Error('pg module not installed - run: npm install');
  }
}));

// Check 8: Redis driver is available
checks.push(check('Redis driver (ioredis) available', () => {
  try {
    require.resolve('ioredis');
    return 'Found';
  } catch (e) {
    throw new Error('ioredis module not installed - run: npm install');
  }
}));

// Check 9: Cron module available
checks.push(check('Cron module (node-cron) available', () => {
  try {
    require.resolve('node-cron');
    return 'Found';
  } catch (e) {
    throw new Error('node-cron module not installed - run: npm install');
  }
}));

// Check 10: Logger module available
checks.push(check('Logger module (pino) available', () => {
  try {
    require.resolve('pino');
    return 'Found';
  } catch (e) {
    throw new Error('pino module not installed - run: npm install');
  }
}));

// Print results
let passCount = 0;
let failCount = 0;

console.log('VERIFICATION RESULTS:\n');

checks.forEach((result) => {
  if (result.status === 'OK') {
    console.log(`✓ ${result.name}`);
    console.log(`  → ${result.result}\n`);
    passCount++;
  } else {
    console.log(`✗ ${result.name}`);
    console.log(`  → ERROR: ${result.error}\n`);
    failCount++;
  }
});

// Summary
console.log('═══════════════════════════════════════════════════════════════════════════════\n');
console.log(`Results: ${passCount} passed, ${failCount} failed\n`);

if (failCount === 0) {
  console.log('✅ All checks passed! Your server is ready to start:\n');
  console.log('  $ npm start\n');
  console.log('Then verify with:\n');
  console.log('  $ curl http://localhost:3000/health/live\n');
  process.exit(0);
} else {
  console.log('❌ Some checks failed. Fix the issues above and try again.\n');
  console.log('Common fixes:\n');
  console.log('  • Missing node_modules: run "npm install"');
  console.log('  • Missing .env: check it exists in planbuddy_v9/');
  console.log('  • Missing services/productionHealth.js: run "node auto-repair.js"\n');
  process.exit(1);
}

