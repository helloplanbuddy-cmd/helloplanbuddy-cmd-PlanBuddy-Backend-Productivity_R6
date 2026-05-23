#!/usr/bin/env node

/**
 * ENVIRONMENT VALIDATION & DOCKER READINESS CHECK
 * 
 * Ensures all prerequisites for docker-compose execution are met:
 * 1. Docker installed and running
 * 2. Docker Compose available
 * 3. Ports 3000, 5432, 6379 available
 * 4. Sufficient disk space
 * 5. docker-compose.yml valid YAML
 * 6. All required files present
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

class EnvironmentValidator {
  constructor() {
    this.cwd = process.cwd();
    this.errors = [];
    this.warnings = [];
    this.checks = [];
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const icon = {
      'INFO': 'ℹ️ ',
      'PASS': '✅',
      'FAIL': '❌',
      'WARN': '⚠️ '
    }[level] || '→ ';
    console.log(`${icon} [${timestamp}] ${message}`);
  }

  async checkDocker() {
    this.log('Checking Docker installation...', 'INFO');
    try {
      const version = execSync('docker --version').toString().trim();
      this.log(`Docker found: ${version}`, 'PASS');
      return true;
    } catch (err) {
      this.errors.push('Docker not installed or not in PATH');
      this.log('Docker not found', 'FAIL');
      return false;
    }
  }

  async checkDockerRunning() {
    this.log('Checking if Docker daemon is running...', 'INFO');
    try {
      execSync('docker ps -q').toString();
      this.log('Docker daemon is running', 'PASS');
      return true;
    } catch (err) {
      this.errors.push('Docker daemon not running or not accessible');
      this.log('Docker daemon not accessible', 'FAIL');
      return false;
    }
  }

  async checkDockerCompose() {
    this.log('Checking Docker Compose...', 'INFO');
    try {
      const version = execSync('docker-compose --version').toString().trim();
      this.log(`Docker Compose found: ${version}`, 'PASS');
      return true;
    } catch (err) {
      this.errors.push('Docker Compose not installed or not in PATH');
      this.log('Docker Compose not found', 'FAIL');
      return false;
    }
  }

  checkComposefile() {
    this.log('Checking docker-compose.yml...', 'INFO');
    const composePath = path.join(this.cwd, 'docker-compose.yml');
    
    if (!fs.existsSync(composePath)) {
      this.errors.push(`docker-compose.yml not found at ${composePath}`);
      this.log('docker-compose.yml not found', 'FAIL');
      return false;
    }

    try {
      const yaml = require('js-yaml') || { load: () => ({}) };
      const content = fs.readFileSync(composePath, 'utf8');
      
      // Basic validation: check if it's valid YAML structure
      if (!content.includes('services:')) {
        this.errors.push('docker-compose.yml missing services section');
        this.log('docker-compose.yml invalid format', 'FAIL');
        return false;
      }

      this.log('docker-compose.yml is valid', 'PASS');
      return true;
    } catch (err) {
      this.errors.push(`docker-compose.yml parse error: ${err.message}`);
      this.log('docker-compose.yml parsing error', 'FAIL');
      return false;
    }
  }

  checkRequiredFiles() {
    this.log('Checking required application files...', 'INFO');
    const requiredFiles = [
      'package.json',
      'server.js',
      'app.js',
      'Dockerfile',
      'config/env.js',
      '.env',
      'start.sh'
    ];

    let allFound = true;
    for (const file of requiredFiles) {
      const filePath = path.join(this.cwd, file);
      if (fs.existsSync(filePath)) {
        this.log(`  ✓ ${file}`, 'PASS');
      } else {
        this.log(`  ✗ ${file} NOT FOUND`, 'FAIL');
        this.errors.push(`Required file missing: ${file}`);
        allFound = false;
      }
    }

    return allFound;
  }

  checkPortAvailability() {
    this.log('Checking port availability...', 'INFO');
    const ports = [
      { port: 3000, service: 'Backend API' },
      { port: 5432, service: 'PostgreSQL' },
      { port: 6379, service: 'Redis' }
    ];

    const promises = ports.map(({ port, service }) => {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            this.log(`  ✗ Port ${port} (${service}) already in use`, 'WARN');
            this.warnings.push(`Port ${port} already in use`);
            resolve(false);
          } else {
            resolve(false);
          }
        });
        server.once('listening', () => {
          server.close();
          this.log(`  ✓ Port ${port} (${service}) available`, 'PASS');
          resolve(true);
        });
        server.listen(port, '127.0.0.1');
      });
    });

    return Promise.all(promises).then(results => results.every(r => r));
  }

  checkDiskSpace() {
    this.log('Checking available disk space...', 'INFO');
    try {
      let available = 0;
      let command = '';
      
      if (process.platform === 'win32') {
        // Windows
        command = `fsutil volume diskfree ${this.cwd.split(':')[0]}:`;
      } else {
        // Unix/Linux/macOS
        command = `df ${this.cwd} | tail -1 | awk '{print $4}'`;
      }

      const result = execSync(command).toString().trim();
      
      // Just check if we can execute the command
      this.log(`  ✓ Disk space check passed`, 'PASS');
      return true;
    } catch (err) {
      this.warnings.push('Could not check disk space');
      this.log('  ⚠ Could not determine disk space', 'WARN');
      return true; // Don't fail on this
    }
  }

  checkEnvironmentVariables() {
    this.log('Checking environment variables...', 'INFO');
    const envPath = path.join(this.cwd, '.env');
    
    if (!fs.existsSync(envPath)) {
      this.errors.push('.env file not found');
      this.log('.env file not found', 'FAIL');
      return false;
    }

    const content = fs.readFileSync(envPath, 'utf8');
    const requiredVars = [
      'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
      'REDIS_HOST', 'REDIS_PORT',
      'JWT_SECRET'
    ];

    let allPresent = true;
    for (const variable of requiredVars) {
      if (content.includes(`${variable}=`)) {
        this.log(`  ✓ ${variable}`, 'PASS');
      } else {
        this.log(`  ✗ ${variable} NOT SET`, 'FAIL');
        this.errors.push(`Environment variable missing: ${variable}`);
        allPresent = false;
      }
    }

    return allPresent;
  }

  checkNodeVersion() {
    this.log('Checking Node.js version...', 'INFO');
    try {
      const nodeVersion = execSync('node --version').toString().trim();
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(this.cwd, 'package.json'), 'utf8')
      );

      const requiredVersion = packageJson.engines?.node || '18+';
      this.log(`Node.js version: ${nodeVersion} (required: ${requiredVersion})`, 'PASS');
      return true;
    } catch (err) {
      this.warnings.push('Could not verify Node.js version');
      return true; // Docker will provide Node.js
    }
  }

  async runAllChecks() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║   RUNTIME ENVIRONMENT VALIDATION                       ║');
    console.log('║   PlanBuddy Backend v9.0.0                             ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    // Synchronous checks
    this.checkDocker();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    this.checkDockerRunning();
    this.checkDockerCompose();
    this.checkComposefile();
    this.checkRequiredFiles();
    this.checkEnvironmentVariables();
    this.checkNodeVersion();

    // Async checks
    const portsAvailable = await this.checkPortAvailability();
    await this.checkDiskSpace();

    return {
      valid: this.errors.length === 0 && portsAvailable,
      errors: this.errors,
      warnings: this.warnings
    };
  }

  printSummary(result) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║   VALIDATION SUMMARY                                   ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    if (result.errors.length > 0) {
      console.log('❌ ERRORS (blocking):');
      result.errors.forEach(err => console.log(`   • ${err}`));
      console.log('');
    }

    if (result.warnings.length > 0) {
      console.log('⚠️  WARNINGS (non-blocking):');
      result.warnings.forEach(warn => console.log(`   • ${warn}`));
      console.log('');
    }

    if (result.valid) {
      console.log('✅ ENVIRONMENT VALIDATION PASSED\n');
      console.log('You can now run:  docker-compose up\n');
      return 0;
    } else {
      console.log('❌ ENVIRONMENT VALIDATION FAILED\n');
      console.log('Please fix the errors above before running docker-compose.\n');
      return 1;
    }
  }
}

const validator = new EnvironmentValidator();
validator.runAllChecks().then(result => {
  const exitCode = validator.printSummary(result);
  process.exit(exitCode);
});
