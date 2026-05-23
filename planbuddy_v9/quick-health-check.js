#!/usr/bin/env node

/**
 * quick-health-check.js — Test if backend is running and health endpoints work
 * Run: node quick-health-check.js
 */

const http = require('http');

const endpoints = [
  { path: '/health/live', name: 'Liveness Probe' },
  { path: '/health/ready', name: 'Readiness Probe' },
  { path: '/health', name: 'Health (legacy)' },
  { path: '/metrics', name: 'Prometheus Metrics' },
  { path: '/', name: 'Root Health' },
];

async function testEndpoint(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'GET',
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: 'ok', code: res.statusCode, json });
        } catch {
          resolve({ status: 'ok', code: res.statusCode, text: data.substring(0, 100) });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ status: 'error', error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'error', error: 'Timeout (5s)' });
    });

    req.end();
  });
}

async function main() {
  console.log('🔍 PlanBuddy Backend Health Check\n');
  console.log('Testing: http://localhost:3000\n');

  let allPass = true;

  for (const endpoint of endpoints) {
    process.stdout.write(`  ${endpoint.name.padEnd(25)} ... `);
    const result = await testEndpoint(endpoint.path);

    if (result.status === 'error') {
      console.log(`❌ ${result.error}`);
      allPass = false;
    } else {
      const statusEmoji = result.code === 200 ? '✅' : '⚠️';
      console.log(`${statusEmoji} HTTP ${result.code}`);
      if (result.json?.status) {
        console.log(`                                  Status: ${result.json.status}`);
      }
    }
  }

  console.log('');
  if (allPass) {
    console.log('✅ All endpoints responding!\n');
  } else {
    console.log('❌ Backend may not be running. Start with: npm start\n');
  }
}

main().catch(console.error);
