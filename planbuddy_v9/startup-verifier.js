#!/usr/bin/env node

/**
 * startup-verifier.js
 * 
 * REPAIR MODE: Verify backend startup and health status
 * Run: node startup-verifier.js
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = process.cwd();
const STARTUP_TIMEOUT = 25000; // 25 seconds
const HEALTH_CHECK_DELAY = 5000; // Wait 5s before health check

console.log('🔍 REPAIR MODE: Backend Startup Verification\n');
console.log(`Working Directory: ${BACKEND_DIR}`);
console.log(`Command: npm start`);
console.log(`\n--- Starting backend process ---\n`);

let backendProcess = null;
let stdoutBuffer = '';
let stderrBuffer = '';

// Spawn npm start
backendProcess = spawn('npm', ['start'], {
  cwd: BACKEND_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

backendProcess.stdout.on('data', (data) => {
  const output = data.toString();
  stdoutBuffer += output;
  process.stdout.write(output); // Real-time output
});

backendProcess.stderr.on('data', (data) => {
  const output = data.toString();
  stderrBuffer += output;
  process.stderr.write(output); // Real-time error output
});

// Wait for startup
setTimeout(async () => {
  console.log('\n--- Checking if backend is running ---\n');

  // Check if process still alive
  const isRunning = !backendProcess.killed;
  console.log(`✓ Process alive: ${isRunning ? 'YES' : 'NO'}`);

  if (!isRunning) {
    console.log('\n❌ Backend crashed during startup\n');
    console.log('=== STDERR ===');
    console.log(stderrBuffer || '(no error output)');
    process.exit(1);
  }

  // Wait a bit more then test health
  console.log('\nWaiting 5 seconds before health check...');
  await new Promise(r => setTimeout(r, HEALTH_CHECK_DELAY));

  console.log('\n--- Testing health endpoints ---\n');

  const endpoints = [
    { path: '/health/live', name: 'Liveness' },
    { path: '/health/ready', name: 'Readiness' },
    { path: '/health', name: 'Health' },
  ];

  let allHealthy = true;

  for (const endpoint of endpoints) {
    try {
      const result = await new Promise((resolve) => {
        const req = http.get(
          `http://localhost:3000${endpoint.path}`,
          { timeout: 3000 },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                body: data.substring(0, 100),
              });
            });
          }
        );

        req.on('error', (err) => {
          resolve({ status: 'ERROR', error: err.message });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ status: 'TIMEOUT', error: 'No response within 3s' });
        });
      });

      const statusEmoji = result.status === 200 ? '✅' : '❌';
      console.log(`${statusEmoji} ${endpoint.name.padEnd(15)} ${endpoint.path.padEnd(20)} → ${result.status}`);

      if (result.status !== 200) {
        allHealthy = false;
        if (result.body) console.log(`   Response: ${result.body}`);
        if (result.error) console.log(`   Error: ${result.error}`);
      }
    } catch (err) {
      console.log(`❌ ${endpoint.name.padEnd(15)} ${endpoint.path.padEnd(20)} → ERROR: ${err.message}`);
      allHealthy = false;
    }
  }

  console.log('\n=== SUMMARY ===\n');
  console.log(`Backend running: ${isRunning ? '✅ YES' : '❌ NO'}`);
  console.log(`Health endpoints: ${allHealthy ? '✅ OK' : '❌ FAILED'}`);
  console.log(`\n--- STARTUP LOG (last 50 lines) ---\n`);
  const lines = stdoutBuffer.split('\n');
  lines.slice(Math.max(0, lines.length - 50)).forEach(line => {
    if (line.trim()) console.log(line);
  });

  // Cleanup
  console.log('\n\nShutting down backend process...');
  backendProcess.kill();
  process.exit(allHealthy ? 0 : 1);

}, STARTUP_TIMEOUT);

backendProcess.on('error', (err) => {
  console.error(`\n❌ Failed to spawn backend: ${err.message}`);
  process.exit(1);
});
