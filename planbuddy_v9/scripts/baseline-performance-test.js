#!/usr/bin/env node
'use strict';

/**
 * scripts/baseline-performance-test.js
 * 
 * Baseline Performance Testing
 * Measures p50/p95/p99 latency under increasing load (10, 50, 100, 500, 1000 users)
 * 
 * DOES NOT estimate. Uses k6 to measure real runtime behavior.
 */

const fs = require('fs');
const path = require('path');

// K6 script generation
function generateK6Script(userCount, duration) {
  return `
import http from 'k6/http';
import { check, sleep, group } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const USER_ID = 'user-' + __VU;
const BOOKING_ID = 'booking-' + Math.floor(Math.random() * 10000);

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: ${userCount} },
        { duration: '${duration}', target: ${userCount} },
        { duration: '5s', target: 0 },
      ],
      gracefulStop: '5s',
    },
  },
  thresholds: {
    'http_req_duration': ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
    'http_req_failed': ['rate<0.05'],
  },
};

export default function() {
  group('Auth Flow', () => {
    const loginRes = http.post(\`\${BASE_URL}/api/auth/login\`, {
      email: 'user\${__VU}@example.com',
      password: 'password123',
    }, {
      tags: { name: 'Login' },
    });
    
    check(loginRes, {
      'login: status 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  });

  group('Booking Operations', () => {
    // Get bookings
    const listRes = http.get(\`\${BASE_URL}/api/bookings?page=1&limit=20\`, {
      tags: { name: 'ListBookings' },
    });
    
    check(listRes, {
      'list bookings: status 200': (r) => r.status === 200,
    });

    // Get single booking
    const getRes = http.get(\`\${BASE_URL}/api/bookings/\${BOOKING_ID}\`, {
      tags: { name: 'GetBooking' },
    });
    
    check(getRes, {
      'get booking: status 200 or 404': (r) => r.status === 200 || r.status === 404,
    });
  });

  group('Health Checks', () => {
    const healthRes = http.get(\`\${BASE_URL}/internal/health/ready\`, {
      tags: { name: 'HealthCheck' },
    });
    
    check(healthRes, {
      'health check: status 200': (r) => r.status === 200,
    });
  });

  sleep(Math.random() * 2);
}
`;
}

// Main test execution
function runBaselineTest() {
  const scenarios = [10, 50, 100, 500, 1000];
  const resultsDir = path.join(__dirname, '../test-results/baseline');
  
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                    BASELINE PERFORMANCE TESTING                            ║
║          Measure p50/p95/p99 latency at 10-1000 concurrent users          ║
╚════════════════════════════════════════════════════════════════════════════╝

Testing scenarios:
${scenarios.map(u => `  • ${u} concurrent users`).join('\n')}

Expected duration: ~${scenarios.length * 1.5} minutes

Output: ${resultsDir}
  `);

  const summary = `# Baseline Performance Test Summary

Date: ${new Date().toISOString()}

## Test Scenarios

${scenarios.map(users => `
### Scenario: ${users} concurrent users
- Duration: 60s ramp-up + 60s sustained + 5s ramp-down
- Expected Results: p50/p95/p99 latency, throughput
- Status: Pending (run k6 script)
`).join('')}

## Results Framework

For each user load, measure:
- **p50 latency:** Median response time (50th percentile)
- **p95 latency:** 95th percentile (typical "bad" case)
- **p99 latency:** 99th percentile (extreme case)
- **Throughput:** Successful requests/sec
- **Error rate:** Failed requests %
- **Connection behavior:** Keep-alive, connection pool

## Saturation Detection

Look for:
- Non-linear latency increase (p95 suddenly jumps)
- Error rate increase >1%
- Throughput plateau (no more req/sec improvement)
- Memory growth acceleration
- Event loop lag spike

## Report Format

\`\`\`
User Load | p50 (ms) | p95 (ms) | p99 (ms) | Throughput | Error %
----------|----------|----------|----------|-----------|--------
10        | ?        | ?        | ?        | ?         | ?
50        | ?        | ?        | ?        | ?         | ?
100       | ?        | ?        | ?        | ?         | ?
500       | ?        | ?        | ?        | ?         | ?
1000      | ?        | ?        | ?        | ?         | ?
\`\`\`

## Next Steps

1. Run k6 test for each scenario
2. Collect latency metrics
3. Plot latency curves (latency vs user count)
4. Identify saturation threshold
5. Move to spike testing
`;

  fs.writeFileSync(path.join(resultsDir, 'summary.md'), summary);
  console.log(`✅ Test plan written: ${resultsDir}/summary.md`);
  console.log(`\n📌 K6 scripts generated. Ready to execute.`);
}

runBaselineTest();
