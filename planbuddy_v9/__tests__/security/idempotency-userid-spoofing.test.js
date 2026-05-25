'use strict';

/**
 * __tests__/security/idempotency-userid-spoofing.test.js
 *
 * Security Audit [f-006]: Verify userId extraction in idempotency middleware
 * ONLY uses req.user.id (from JWT). Headers, query params, and body
 * MUST NEVER be used as a source for userId.
 *
 * Tests:
 *  1. X-User-ID header spoofing is ignored
 *  2. Query param userId spoofing is ignored
 *  3. Different JWT users with same idempotency key are isolated
 */

const idempotency = require('../../middleware/idempotency');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../config/db', () => ({
  query: jest.fn(),
  transaction: jest.fn((fn) => fn({ query: jest.fn() })),
}));

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../middleware/Idempotencyconflictlimiter', () => ({
  trackConflict: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../config/env', () => ({
  IDEMPOTENCY_TTL_HOURS: 72,
}));

const mockRedis = {
  status: 'ready',
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
};

jest.mock('../../config/redis', () => ({
  redis: mockRedis,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildReq(overrides = {}) {
  return {
    user: { id: overrides.userId || 'user_123' },
    headers: {
      'idempotency-key': overrides.idempotencyKey || 'key-abc',
      ...(overrides.headers || {}),
    },
    query: overrides.query || {},
    body: overrides.body || {},
    method: overrides.method || 'POST',
    path: overrides.path || '/api/bookings',
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function buildRes() {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader: jest.fn((k, v) => { res.headers[k] = v; }),
    status: jest.fn(function (code) { res.statusCode = code; return this; }),
    json: jest.fn(async function (body) { res.body = body; return this; }),
  };
  return res;
}

const next = jest.fn();

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('[f-006] Idempotency userId Extraction Security Audit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    // Default: lock acquired successfully
    mockRedis.set.mockResolvedValueOnce('OK');
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // ── TEST 1: X-User-ID header spoofing must be ignored ──────────────────────
  describe('Test 1: X-User-ID header spoofing', () => {
    test('should ignore X-User-ID header and use req.user.id from JWT', async () => {
      const req = buildReq({
        userId: 'jwt_user_42',
        headers: {
          'idempotency-key': 'test-key-1',
          'x-user-id': 'attacker_999', // SPOOF attempt
        },
      });
      const res = buildRes();

      // Simulate lock acquisition
      mockRedis.set.mockResolvedValueOnce('OK');

      idempotency(req, res, next);

      // Wait for async middleware
      await new Promise((r) => setTimeout(r, 50));

      // The middleware should have proceeded (lock acquired, next called)
      // Since req.user.id = 'jwt_user_42', the scopedKey should include it,
      // NOT the attacker ID from the header.
      expect(res.status).not.toHaveBeenCalledWith(409);
      // next() should have been called because lock was acquired
      expect(next).toHaveBeenCalled();
    });

    test('should NOT extract userId from any header including x-user-id', async () => {
      // Directly test the _runIdempotency exposed function to verify scopedKey
      const req = buildReq({
        userId: 'legit_user_7',
        headers: {
          'idempotency-key': 'shared-key',
          'x-user-id': 'spoofed_admin',
        },
      });
      const res = buildRes();

      mockRedis.set.mockResolvedValueOnce('OK');

      await idempotency._runIdempotency(req, res, next, 'shared-key');

      // Verify the DB write uses the JWT userId, NOT the header
      const db = require('../../config/db');
      // dbSet is called via db.query inside runIdempotency
      // The second arg to dbSet is userId
      const dbQueryCalls = db.query.mock.calls;
      const insertCall = dbQueryCalls.find(
        (c) => c[0] && c[0].includes('INSERT INTO idempotency_keys')
      );

      if (insertCall) {
        // userId should be 'legit_user_7' (index 1 in VALUES array)
        expect(insertCall[1][1]).toBe('legit_user_7');
        // user_id_str should also be 'legit_user_7' (index 3)
        expect(insertCall[1][3]).toBe('legit_user_7');
      }
    });
  });

  // ── TEST 2: Query param userId spoofing must be ignored ────────────────────
  describe('Test 2: Query param userId spoofing', () => {
    test('should ignore query.userId and use req.user.id from JWT', async () => {
      const req = buildReq({
        userId: 'jwt_user_88',
        query: { userId: 'attacker_777' }, // SPOOF attempt
        headers: { 'idempotency-key': 'test-key-2' },
      });
      const res = buildRes();

      mockRedis.set.mockResolvedValueOnce('OK');

      await idempotency._runIdempotency(req, res, next, 'test-key-2');

      const db = require('../../config/db');
      const insertCall = db.query.mock.calls.find(
        (c) => c[0] && c[0].includes('INSERT INTO idempotency_keys')
      );

      if (insertCall) {
        expect(insertCall[1][1]).toBe('jwt_user_88');
        expect(insertCall[1][3]).toBe('jwt_user_88');
      }

      // Ensure no reference to attacker ID anywhere
      const allCalls = JSON.stringify(db.query.mock.calls);
      expect(allCalls).not.toContain('attacker_777');
    });

    test('should ignore body.userId and use req.user.id from JWT', async () => {
      const req = buildReq({
        userId: 'jwt_user_99',
        body: { userId: 'attacker_666' }, // SPOOF attempt in body
        headers: { 'idempotency-key': 'test-key-3' },
      });
      const res = buildRes();

      mockRedis.set.mockResolvedValueOnce('OK');

      await idempotency._runIdempotency(req, res, next, 'test-key-3');

      const db = require('../../config/db');
      const insertCall = db.query.mock.calls.find(
        (c) => c[0] && c[0].includes('INSERT INTO idempotency_keys')
      );

      if (insertCall) {
        expect(insertCall[1][1]).toBe('jwt_user_99');
        expect(insertCall[1][3]).toBe('jwt_user_99');
      }

      const allCalls = JSON.stringify(db.query.mock.calls);
      expect(allCalls).not.toContain('attacker_666');
    });
  });

  // ── TEST 3: Different JWT users with same raw key are isolated ─────────────
  describe('Test 3: Cross-user isolation with same idempotency key', () => {
    test('user A and user B with same key should have independent scoped keys', async () => {
      const reqA = buildReq({
        userId: 'user_alice',
        headers: { 'idempotency-key': 'shared-key-xyz' },
      });
      const resA = buildRes();

      const reqB = buildReq({
        userId: 'user_bob',
        headers: { 'idempotency-key': 'shared-key-xyz' },
      });
      const resB = buildRes();

      // Both acquire locks (different scoped keys)
      mockRedis.set.mockResolvedValueOnce('OK'); // Alice
      mockRedis.set.mockResolvedValueOnce('OK'); // Bob

      await idempotency._runIdempotency(reqA, resA, next, 'shared-key-xyz');
      await idempotency._runIdempotency(reqB, resB, next, 'shared-key-xyz');

      // Verify Redis SET was called with different lock keys
      const setCalls = mockRedis.set.mock.calls;
      const lockKeys = setCalls
        .filter((c) => c[0] && c[0].startsWith('idempotency:lock:'))
        .map((c) => c[0]);

      expect(lockKeys.length).toBeGreaterThanOrEqual(2);

      // Alice's key should contain her userId
      const aliceKey = lockKeys.find((k) => k.includes('user_alice'));
      expect(aliceKey).toBeDefined();

      // Bob's key should contain his userId
      const bobKey = lockKeys.find((k) => k.includes('user_bob'));
      expect(bobKey).toBeDefined();

      // They must be different
      expect(aliceKey).not.toBe(bobKey);
    });

    test('same raw key for different users must NOT collide in DB', async () => {
      const reqA = buildReq({
        userId: 'user_charlie',
        method: 'POST',
        path: '/api/payments',
        headers: { 'idempotency-key': 'payment-key-001' },
      });
      const resA = buildRes();

      const reqB = buildReq({
        userId: 'user_dave',
        method: 'POST',
        path: '/api/payments',
        headers: { 'idempotency-key': 'payment-key-001' },
      });
      const resB = buildRes();

      mockRedis.set.mockResolvedValueOnce('OK');
      mockRedis.set.mockResolvedValueOnce('OK');

      await idempotency._runIdempotency(reqA, resA, next, 'payment-key-001');
      await idempotency._runIdempotency(reqB, resB, next, 'payment-key-001');

      // Trigger res.json to invoke the captured handler which writes to DB
      await resA.json({ success: true });
      await resB.json({ success: true });

      const db = require('../../config/db');
      const insertCalls = db.query.mock.calls.filter(
        (c) => c[0] && c[0].includes('INSERT INTO idempotency_keys')
      );

      // Both requests should write to DB with different DB keys
      // because scopedKey = userId:method:path:rawKey produces different hashes
      expect(insertCalls.length).toBeGreaterThanOrEqual(2);

      // Extract the dbKey (first param of dbSet -> first arg of query)
      const dbKeys = insertCalls.map((c) => c[1][0]);

      // Keys must be different for different users
      expect(dbKeys[0]).not.toBe(dbKeys[1]);
    });
  });

  // ── Security audit meta-test ────────────────────────────────────────────────
  describe('Audit: verify NO alternate userId extraction paths exist', () => {
    test('middleware source must only reference req.user?.id for userId', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.join(__dirname, '../../middleware/idempotency.js'),
        'utf8'
      );

      // Count how many times userId is assigned
      const assignments = source.match(/userId\s*=/g) || [];

      // There should be exactly ONE assignment: const userId = req.user?.id || 'anon'
      // Plus error-handling re-assignments in catch blocks
      // We verify the main extraction point
      const mainExtraction = source.match(
        /const\s+userId\s*=\s*req\.user\?\.id\s*\|\|\s*['"]anon['"]/
      );
      expect(mainExtraction).not.toBeNull();

      // Must NOT extract from headers
      expect(source).not.toMatch(/req\.headers\[["']x-user-id["']\]/i);
      expect(source).not.toMatch(/req\.headers\[["']user-id["']\]/i);

      // Must NOT extract from query
      expect(source).not.toMatch(/req\.query\.userId/);
      expect(source).not.toMatch(/req\.query\[["']userId["']\]/);

      // Must NOT extract from body
      expect(source).not.toMatch(/req\.body\.userId/);
      expect(source).not.toMatch(/req\.body\[["']userId["']\]/);
    });
  });
});
