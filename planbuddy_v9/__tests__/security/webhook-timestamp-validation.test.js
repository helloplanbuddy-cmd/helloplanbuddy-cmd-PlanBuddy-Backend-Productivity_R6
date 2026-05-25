'use strict';

/**
 * __tests__/security/webhook-timestamp-validation.test.js
 *
 * Security Audit [f-018]: Verify webhook timestamp freshness enforcement.
 *
 * Tests:
 *  1. Timestamp within 5-minute window is accepted
 *  2. Timestamp older than 5 minutes is rejected
 *  3. Replay timestamp from 10 days ago is rejected
 *  4. Future timestamp is rejected
 *  5. Missing timestamp is rejected
 */

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../config/env', () => ({
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  WEBHOOK_TIMESTAMP_WINDOW_SECS: 300,
}));

const webhookAuthenticityService = require('../../services/webhookAuthenticityService');

describe('[f-018] Webhook Timestamp Validation', () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    Date.now = originalDateNow;
    jest.restoreAllMocks();
  });

  describe('Test 1: Within window', () => {
    test('accepts timestamps within the configured 5-minute window', () => {
      Date.now = jest.fn(() => 1_700_000_000_000);

      const timestamp = 1_700_000_000 - 120;

      const result = webhookAuthenticityService.verifyIngressTimestamp(timestamp, {
        requestId: 'req_within_window',
      });

      expect(result.verified).toBe(true);
      expect(result.timestamp).toBe(timestamp);
      expect(result.ageSeconds).toBe(120);
    });
  });

  describe('Test 2: Older than 5 minutes', () => {
    test('rejects timestamps older than the configured window', () => {
      Date.now = jest.fn(() => 1_700_000_000_000);

      const timestamp = 1_700_000_000 - 301;

      expect(() => {
        webhookAuthenticityService.verifyIngressTimestamp(timestamp, {
          requestId: 'req_old',
        });
      }).toThrow('too old');
    });
  });

  describe('Test 3: Replay attack timestamp', () => {
    test('rejects timestamps from 10 days ago', () => {
      Date.now = jest.fn(() => 1_700_000_000_000);

      const timestamp = 1_700_000_000 - (10 * 24 * 60 * 60);

      expect(() => {
        webhookAuthenticityService.verifyIngressTimestamp(timestamp, {
          requestId: 'req_replay',
        });
      }).toThrow('too old');
    });
  });

  describe('Test 4: Future timestamp', () => {
    test('rejects timestamps in the future', () => {
      Date.now = jest.fn(() => 1_700_000_000_000);

      const timestamp = 1_700_000_000 + 60;

      expect(() => {
        webhookAuthenticityService.verifyIngressTimestamp(timestamp, {
          requestId: 'req_future',
        });
      }).toThrow('future');
    });
  });

  describe('Test 5: Missing timestamp', () => {
    test('rejects missing timestamps', () => {
      Date.now = jest.fn(() => 1_700_000_000_000);

      expect(() => {
        webhookAuthenticityService.verifyIngressTimestamp(undefined, {
          requestId: 'req_missing',
        });
      }).toThrow('Missing X-Razorpay-Timestamp header');
    });
  });
});
