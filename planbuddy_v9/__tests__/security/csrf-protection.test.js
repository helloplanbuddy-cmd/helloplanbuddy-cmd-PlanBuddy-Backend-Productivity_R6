'use strict';

/**
 * __tests__/security/csrf-protection.test.js
 *
 * Security Audit [C-3]: Verify CSRF protection via X-Requested-With header validation.
 *
 * Tests:
 *  1. GET/HEAD/OPTIONS requests are allowed without X-Requested-With
 *  2. POST/PUT/PATCH/DELETE without X-Requested-With rejected in production
 *  3. Requests WITH X-Requested-With header are allowed
 *  4. Development mode allows missing header (for testing)
 */

const csrfProtection = require('../../middleware/csrfProtection');

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../../config/env', () => ({
  IS_PROD: true,
  IS_TEST: false,
  IS_DEV: false,
}));

describe('[C-3] CSRF Protection via X-Requested-With Header', () => {
  let mockReq;
  let mockRes;
  const mockNext = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      method: 'POST',
      headers: {},
      requestId: 'test-req-1',
      ip: '127.0.0.1',
      path: '/api/v1/bookings',
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('Test 1: Safe methods (GET/HEAD/OPTIONS) bypass CSRF check', () => {
    test('GET request without X-Requested-With should be allowed', () => {
      mockReq.method = 'GET';
      csrfProtection(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('HEAD request without X-Requested-With should be allowed', () => {
      mockReq.method = 'HEAD';
      csrfProtection(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('OPTIONS request without X-Requested-With should be allowed', () => {
      mockReq.method = 'OPTIONS';
      csrfProtection(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('Test 2: State-changing requests (POST/PUT/PATCH/DELETE) require X-Requested-With', () => {
    test('POST without X-Requested-With rejected in production', () => {
      mockReq.method = 'POST';
      mockReq.headers['x-requested-with'] = undefined;

      csrfProtection(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: 'CSRF_VALIDATION_FAILED',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('PUT without X-Requested-With rejected in production', () => {
      mockReq.method = 'PUT';
      mockReq.headers['x-requested-with'] = undefined;

      csrfProtection(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('PATCH without X-Requested-With rejected in production', () => {
      mockReq.method = 'PATCH';
      csrfProtection(mockReq, mockRes, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('DELETE without X-Requested-With rejected in production', () => {
      mockReq.method = 'DELETE';
      csrfProtection(mockReq, mockRes, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });

  describe('Test 3: X-Requested-With header allows state-changing requests', () => {
    test('POST with X-Requested-With: XMLHttpRequest should be allowed', () => {
      mockReq.method = 'POST';
      mockReq.headers['x-requested-with'] = 'XMLHttpRequest';

      csrfProtection(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('DELETE with X-Requested-With header should be allowed', () => {
      mockReq.method = 'DELETE';
      mockReq.headers['x-requested-with'] = 'fetch';

      csrfProtection(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('Test 4: Development mode allows missing X-Requested-With', () => {
    test('POST without X-Requested-With allowed in dev mode', () => {
      // Temporarily mock IS_DEV
      jest.resetModules();
      jest.doMock('../../config/env', () => ({
        IS_PROD: false,
        IS_DEV: true,
      }));
      const csrfDev = require('../../middleware/csrfProtection');

      mockReq.method = 'POST';
      mockReq.headers['x-requested-with'] = undefined;

      csrfDev(mockReq, mockRes, mockNext);

      // Should be allowed but logged as info
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();

      jest.dontMock('../../config/env');
    });
  });

  describe('Security audit: verify browser form submission vectors are blocked', () => {
    test('Form submission (no X-Requested-With) cannot POST to API in production', () => {
      // Simulate form submission (does NOT set X-Requested-With)
      mockReq.method = 'POST';
      mockReq.headers['content-type'] = 'application/x-www-form-urlencoded';
      mockReq.headers['x-requested-with'] = undefined;

      csrfProtection(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CSRF_VALIDATION_FAILED',
        })
      );
    });
  });
});
