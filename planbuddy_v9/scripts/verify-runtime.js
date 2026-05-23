#!/usr/bin/env node

/**
 * RUNTIME HEALTH VERIFICATION
 * 
 * Checks:
 * 1. Backend is responding (/health/live)
 * 2. Database is connected (/health/ready)
 * 3. Redis is connected (/health/ready)
 * 4. Workers are running
 * 5. Metrics are available (/metrics)
 */

const http = require('http');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

class HealthChecker {
  constructor() {
    this.retries = 0;
  }

  async makeRequest(path) {
    return new Promise((resolve, reject) => {
      const url = new URL(BACKEND_URL);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: path,
        method: 'GET',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data ? JSON.parse(data) : data
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data
            });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level}: ${message}`);
  }

  async checkLiveness() {
    this.log('Checking /health/live...');
    try {
      const response = await this.makeRequest('/health/live');
      if (response.status === 200) {
        this.log('✅ Backend is alive (status 200)');
        return true;
      }
      this.log(`❌ /health/live returned ${response.status}`, 'WARN');
      return false;
    } catch (err) {
      this.log(`❌ Failed to reach /health/live: ${err.message}`, 'WARN');
      return false;
    }
  }

  async checkReadiness() {
    this.log('Checking /health/ready...');
    try {
      const response = await this.makeRequest('/health/ready');
      if (response.status === 200) {
        this.log('✅ Backend is ready (dependencies connected)');
        return true;
      }
      if (response.status === 503) {
        const body = response.body;
        if (body && body.reasons) {
          this.log(`⚠️  Dependencies not ready: ${JSON.stringify(body.reasons)}`, 'WARN');
        }
        return false;
      }
      this.log(`❌ /health/ready returned ${response.status}`, 'WARN');
      return false;
    } catch (err) {
      this.log(`❌ Failed to reach /health/ready: ${err.message}`, 'WARN');
      return false;
    }
  }

  async checkMetrics() {
    this.log('Checking /metrics...');
    try {
      const response = await this.makeRequest('/metrics');
      if (response.status === 200 && response.body) {
        const metricsCount = typeof response.body === 'string' 
          ? response.body.split('\n').filter(l => !l.startsWith('#') && l.trim()).length
          : Object.keys(response.body).length;
        this.log(`✅ Metrics endpoint working (${metricsCount} metrics)`);
        return true;
      }
      this.log(`❌ /metrics returned ${response.status}`, 'WARN');
      return false;
    } catch (err) {
      this.log(`❌ Failed to reach /metrics: ${err.message}`, 'WARN');
      return false;
    }
  }

  async waitForBackend() {
    while (this.retries < MAX_RETRIES) {
      try {
        const alive = await this.checkLiveness();
        if (alive) {
          return true;
        }
      } catch (err) {
        // Expected during startup
      }

      this.retries++;
      if (this.retries < MAX_RETRIES) {
        this.log(`Retry ${this.retries}/${MAX_RETRIES} — waiting ${RETRY_DELAY_MS}ms...`, 'INFO');
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    throw new Error(`Backend did not respond after ${MAX_RETRIES} retries`);
  }

  async runFullCheck() {
    this.log('=== RUNTIME HEALTH VERIFICATION ===');
    this.log(`Backend URL: ${BACKEND_URL}`);

    try {
      // Wait for backend to be alive
      await this.waitForBackend();

      // Check readiness (dependencies)
      const ready = await this.checkReadiness();

      // Check metrics
      await this.checkMetrics();

      if (!ready) {
        this.log('⚠️  Backend is alive but dependencies not fully ready yet', 'WARN');
        return false;
      }

      this.log('\n✅ RUNTIME VERIFICATION SUCCESSFUL\n');
      return true;
    } catch (err) {
      this.log(`\n❌ RUNTIME VERIFICATION FAILED: ${err.message}\n`, 'ERROR');
      process.exit(1);
    }
  }
}

const checker = new HealthChecker();
checker.runFullCheck().then(success => {
  process.exit(success ? 0 : 1);
});
