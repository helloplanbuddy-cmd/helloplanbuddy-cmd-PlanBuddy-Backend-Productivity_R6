'use strict';

/**
 * __tests__/security/razorpay-tls-validation.test.js
 *
 * Security Audit [f-017]: Verify TLS certificate validation for Razorpay SDK
 *
 * Tests:
 *  1. Razorpay config does NOT disable TLS certificate validation
 *  2. No custom HTTP agent with rejectUnauthorized: false is passed
 *  3. SDK constructor only receives key_id and key_secret
 *  4. Source code audit confirms no TLS bypass patterns
 */

const fs = require('fs');
const path = require('path');

describe('[f-017] Razorpay TLS Certificate Validation Audit', () => {
  const razorpayConfigPath = path.join(__dirname, '../../config/razorpay.js');
  const exactlyOnceRefundPath = path.join(__dirname, '../../services/exactlyOnceRefund.js');
  let razorpaySource;
  let exactlyOnceSource;

  beforeAll(() => {
    razorpaySource = fs.readFileSync(razorpayConfigPath, 'utf8');
    exactlyOnceSource = fs.readFileSync(exactlyOnceRefundPath, 'utf8');
  });

  // ── TEST 1: No rejectUnauthorized: false in Razorpay config ────────────────
  describe('Test 1: TLS must not be disabled in Razorpay config', () => {
    test('razorpay.js must NOT contain rejectUnauthorized: false in executable code', () => {
      // Strip comments before checking
      const codeWithoutComments = razorpaySource
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(codeWithoutComments).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(codeWithoutComments).not.toMatch(/rejectUnauthorized\s*:\s*0/);
    });

    test('razorpay.js must NOT use rejectUnauthorized in executable code', () => {
      // Remove comments and check only executable code
      const codeWithoutComments = razorpaySource
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(codeWithoutComments.toLowerCase()).not.toContain('rejectunauthorized');
    });
  });

  // ── TEST 2: No custom HTTP agent that bypasses TLS ─────────────────────────
  describe('Test 2: No custom HTTP agent with disabled TLS', () => {
    test('razorpay.js must NOT create a custom http.Agent', () => {
      expect(razorpaySource).not.toMatch(/new\s+(https?\.)?Agent/i);
    });

    test('razorpay.js must NOT pass an agent option to Razorpay constructor', () => {
      // The constructor should only have key_id and key_secret
      const constructorMatch = razorpaySource.match(
        /new\s+Razorpay\s*\(\s*\{[\s\S]*?\}\s*\)/
      );
      expect(constructorMatch).not.toBeNull();
      const constructorBody = constructorMatch[0];
      expect(constructorBody).not.toMatch(/agent\s*:/);
    });

    test('exactlyOnceRefund.js must NOT create a custom http.Agent', () => {
      expect(exactlyOnceSource).not.toMatch(/new\s+(https?\.)?Agent/i);
    });

    test('exactlyOnceRefund.js must NOT contain rejectUnauthorized', () => {
      expect(exactlyOnceSource.toLowerCase()).not.toContain('rejectunauthorized');
    });
  });

  // ── TEST 3: SDK constructor receives only expected options ─────────────────
  describe('Test 3: Razorpay constructor options audit', () => {
    test('constructor must only contain key_id and key_secret', () => {
      // Extract the constructor call
      const match = razorpaySource.match(
        /new\s+Razorpay\s*\(\s*(\{[\s\S]*?\})\s*\)/
      );
      expect(match).not.toBeNull();

      const optionsBlock = match[1];
      // Should contain key_id
      expect(optionsBlock).toMatch(/key_id\s*:/);
      // Should contain key_secret
      expect(optionsBlock).toMatch(/key_secret\s*:/);
      // Should NOT contain any other options that could affect TLS
      expect(optionsBlock).not.toMatch(/agent\s*:/);
      expect(optionsBlock).not.toMatch(/rejectUnauthorized\s*:/);
      expect(optionsBlock).not.toMatch(/strictSSL\s*:\s*false/);
      expect(optionsBlock).not.toMatch(/insecure\s*:\s*true/);
    });

    test('exported config must reference the singleton client', () => {
      const razorpayConfig = require('../../config/razorpay');
      expect(razorpayConfig.client).toBeDefined();
      expect(razorpayConfig.razorpay).toBeDefined();
      // Both should point to the same instance
      expect(razorpayConfig.client).toBe(razorpayConfig.razorpay);
    });
  });

  // ── TEST 4: Source-wide TLS bypass scan ────────────────────────────────────
  describe('Test 4: Full codebase TLS bypass scan', () => {
    test('must not find NODE_TLS_REJECT_UNAUTHORIZED=0 in any source file', () => {
      // This is a critical check: if any file sets this env var, TLS is disabled globally
      const configDir = path.join(__dirname, '../../config');
      const servicesDir = path.join(__dirname, '../../services');
      const controllersDir = path.join(__dirname, '../../controllers');

      const dirsToScan = [configDir, servicesDir, controllersDir];
      const dangerousPatterns = [
        /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
        /process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
      ];

      for (const dir of dirsToScan) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
        for (const file of files) {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          for (const pattern of dangerousPatterns) {
            expect(content).not.toMatch(pattern);
          }
        }
      }
    });

    test('must contain SECURITY comment documenting TLS is enabled', () => {
      // The file should document that TLS is enabled by default
      expect(razorpaySource).toMatch(/SECURITY\s*\[f-017\]/i);
      expect(razorpaySource).toMatch(/TLS\s+certificate\s+validation\s+is\s+ENABLED/i);
    });
  });

  // ── TEST 5: Node.js version compatibility note ─────────────────────────────
  describe('Test 5: Node.js TLS defaults verification', () => {
    test('Node.js version should validate certificates by default', () => {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
      // Node.js 17+ validates certificates by default
      expect(majorVersion).toBeGreaterThanOrEqual(17);
    });

    test('global rejectUnauthorized should not be disabled', () => {
      // Ensure no test or process has disabled TLS globally
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0');
    });
  });
});
