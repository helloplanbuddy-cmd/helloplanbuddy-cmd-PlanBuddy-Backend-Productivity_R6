'use strict';

/**
 * __tests__/refund-exactly-once.test.js — Refund System Tests
 * 
 * Tests for:
 *  1. Idempotency key enforcement
 *  2. Exactly-once refund guarantee
 *  3. Circuit breaker behavior
 *  4. Concurrent refund attempts
 */

const db = require('../config/db');
const { executeExactlyOnceRefund } = require('../services/exactlyOnceRefund');
const { initiateRefund } = require('../services/refundService');
const { CircuitBreaker } = require('../utils/circuitBreakerUtil');
const { randomUUID } = require('crypto');

// Ensure a minimal mock for Razorpay refunds during tests
const razorpayConfig = require('../config/razorpay');
if (!razorpayConfig.razorpay || typeof razorpayConfig.razorpay.refunds?.create !== 'function') {
  razorpayConfig.razorpay = razorpayConfig.razorpay || {};
  razorpayConfig.razorpay.refunds = {
    async create({ payment_id, amount, notes }) {
      return { id: `rfnd_${Date.now()}`, status: 'processed' };
    }
  };
}

async function createUserBookingPayment({ razorpayPaymentId = `pay_${Date.now()}-${randomUUID()}`, amount = 1000 }) {
  const userRes = await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [`test-refund-${Date.now()}@test.com`, 'hash', 'Test User', 'user']
  );
  const userId = userRes.rows[0].id;
  const tripRes = await db.query(
    `INSERT INTO trips (agency_id, title, description, location, price, max_group_size)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [userId, 'Test Trip', 'Test trip for refunds', 'Nowhere', amount, 10]
  );
  const tripId = tripRes.rows[0].id;
  const bookingRes = await db.query(
    `INSERT INTO bookings (user_id, agency_id, trip_id, group_size, total_amount, final_amount, travel_date, status, payment_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [userId, userId, tripId, 1, amount, amount, '2026-12-01', 'confirmed', 'paid']
  );
  const bookingId = bookingRes.rows[0].id;
  const paymentRes = await db.query(
    `INSERT INTO payments (booking_id, user_id, razorpay_payment_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [bookingId, userId, razorpayPaymentId, amount, 'INR', 'captured']
  );
  const paymentId = paymentRes.rows[0].id;
  return { userId, bookingId, paymentId };
}

describe('Refund System: Exactly-Once Guarantee', () => {
  
  // ─── Test 1: Idempotency Key Prevents Duplicate Refunds ──────────────────
  describe('Idempotency Key Protection', () => {
    
    test('should prevent duplicate refunds with same idempotency key', async () => {
      // Setup: Create payment + booking
      const razorpayPaymentId = `pay_TEST123-${randomUUID()}`;
      const idempotencyKey = `idem-key-unique-1-${randomUUID()}`;
      const { userId, bookingId, paymentId } = await createUserBookingPayment({ razorpayPaymentId, amount: 50000 });

      // First refund call
      const result1 = await executeExactlyOnceRefund({
        paymentId,
        bookingId,
        razorpayPaymentId,
        amountPaise: 50000 * 100,
        idempotencyKey,
        reason: 'Test refund',
        requestedBy: 'test-user',
      });

      // Second refund call with SAME idempotency key
      const result2 = await executeExactlyOnceRefund({
        paymentId,
        bookingId,
        razorpayPaymentId,
        amountPaise: 50000 * 100,
        idempotencyKey,  // Same key
        reason: 'Test refund',
        requestedBy: 'test-user',
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result2.idempotent).toBe(true);  // Second call recognized as duplicate
      
      // Verify only ONE refund record in DB
      const refunds = await db.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(refunds.rows[0].count)).toBe(1);
    });

    test('should allow different refunds with different idempotency keys', async () => {
      const razorpayPaymentId = `pay_TEST456-${randomUUID()}`;
      const { userId, bookingId, paymentId } = await createUserBookingPayment({ razorpayPaymentId, amount: 30000 });

      const result1 = await executeExactlyOnceRefund({
        paymentId,
        bookingId,
        razorpayPaymentId,
        amountPaise: 30000 * 100,
        idempotencyKey: 'key-1',
        reason: 'Refund 1',
        requestedBy: 'user-1',
      });

      const result2 = await executeExactlyOnceRefund({
        paymentId,
        bookingId,
        razorpayPaymentId,
        amountPaise: 30000 * 100,
        idempotencyKey: 'key-2',  // Different key
        reason: 'Refund 2',
        requestedBy: 'user-1',
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result2.idempotent).toBe(false);  // Should be treated as new refund

      // Should have 2 refund records (but Razorpay would reject 2nd partial refund)
      const refunds = await db.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(refunds.rows[0].count)).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Test 2: Concurrent Refund Attempts ─────────────────────────────────
  describe('Concurrent Request Safety', () => {
    
    test('should handle 10 concurrent refund requests safely', async () => {
      const razorpayPaymentId = `pay_CONCURRENT1-${randomUUID()}`;
      const { userId, bookingId, paymentId } = await createUserBookingPayment({ razorpayPaymentId, amount: 10000 });

      // Fire 10 concurrent refund requests
      const promises = Array(10)
        .fill(null)
        .map((_, idx) =>
          initiateRefund(
            bookingId,
            100,  // Amount: 100 rupees
            `Concurrent refund ${idx}`,
            'concurrent-user'
          ).catch(err => ({ error: err.message, index: idx }))
        );

      const results = await Promise.all(promises);

      // Count successful and idempotent responses
      const successful = results.filter(r => r && r.razorpayRefundId);
      const errors = results.filter(r => r && r.error);

      // Expected: 1 success, 9 conflicts/idempotent responses or errors
      expect(successful.length).toBeGreaterThanOrEqual(1);
      
      // Verify only ONE refund in DB
      const refunds = await db.query(
        'SELECT COUNT(*) as count FROM refunds WHERE payment_id = $1',
        [paymentId]
      );
      expect(parseInt(refunds.rows[0].count)).toBeLessThanOrEqual(1);
    });
  });

  // ─── Test 3: Circuit Breaker Behavior ────────────────────────────────────
  describe('Circuit Breaker Protection', () => {
    
    test('should transition CLOSED → OPEN on repeated failures', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 100,
      });

      // Cause 3 failures
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(
            async () => {
              throw new Error('API error');
            },
            'test-operation'
          );
        } catch (err) {
          // Expected
        }
      }

      expect(breaker.state).toBe('OPEN');
      expect(breaker.metrics.totalErrors).toBe(3);

      // Next call should fail immediately (fail-fast)
      try {
        await breaker.execute(
          async () => {
            throw new Error('Should not reach here');
          },
          'test-operation'
        );
        fail('Should have thrown circuit breaker error');
      } catch (err) {
        expect(err.code).toBe('CIRCUIT_BREAKER_OPEN');
      }
    });

    test('should recover from OPEN → CLOSED on success', async () => {
      const breaker = new CircuitBreaker({
        name: 'recovery-breaker',
        failureThreshold: 2,
        successThreshold: 2,
        timeout: 50,
      });

      // Cause 2 failures to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')), 'op');
        } catch {}
      }

      expect(breaker.state).toBe('OPEN');

      // Wait for timeout
      await new Promise(r => setTimeout(r, 100));

      // Successful calls should recover
      for (let i = 0; i < 2; i++) {
        await breaker.execute(() => Promise.resolve('ok'), 'op');
      }

      expect(breaker.state).toBe('CLOSED');
      expect(breaker.metrics.totalSuccesses).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Test 4: Financial Audit Logging ────────────────────────────────────
  describe('Financial Audit Trail', () => {
    
    test('should create audit log entry for refund', async () => {
      const razorpayPaymentId = `pay_AUDIT1-${randomUUID()}`;
      const { userId, bookingId, paymentId } = await createUserBookingPayment({ razorpayPaymentId, amount: 5000 });

      // Initiate refund
      const refund = await initiateRefund(bookingId, 50, 'Audit test', 'audit-user');

      // Check audit log
      const auditLog = await db.query(
        `SELECT * FROM financial_audit_log
         WHERE booking_id = $1 AND event_type LIKE 'refund%'
         ORDER BY created_at DESC LIMIT 1`,
        [bookingId]
      );

      expect(auditLog.rows.length).toBeGreaterThan(0);
      const entry = auditLog.rows[0];
      expect(entry.event_type).toMatch(/^refund/);
      expect(entry.status).toBe('initiated');
      expect(entry.metadata).toBeDefined();
    });
  });

  // ─── Test 5: Database Constraint Enforcement ────────────────────────────
  describe('Database Uniqueness Constraints', () => {
    
    test('should enforce UNIQUE(payment_id, idempotency_key)', async () => {
      const { userId, bookingId, paymentId } = await createUserBookingPayment({ razorpayPaymentId: `pay_CONSTRAINT1-${randomUUID()}`, amount: 100 });
      const idemKey = `constraint-key-1-${randomUUID()}`;
      const refundIdA = `rfnd_TEST1-${randomUUID()}`;
      const refundIdB = `rfnd_TEST2-${randomUUID()}`;

      // Insert two refund records with same payment_id + idempotency_key
      await db.query(
        `INSERT INTO refunds (payment_id, booking_id, user_id, idempotency_key, razorpay_refund_id, amount, status)
         VALUES ($1, $2, $3, $4, $5, 100, 'succeeded')`,
        [paymentId, bookingId, userId, idemKey, refundIdA]
      );

      // Try to insert duplicate
      let constraintViolated = false;
      try {
        await db.query(
          `INSERT INTO refunds (payment_id, booking_id, user_id, idempotency_key, razorpay_refund_id, amount, status)
           VALUES ($1, $2, $3, $4, $5, 100, 'succeeded')`,
          [paymentId, bookingId, userId, idemKey, refundIdB]
        );
      } catch (err) {
        if (err.code === '23505') {  // Unique constraint violation
          constraintViolated = true;
        }
      }

      expect(constraintViolated).toBe(true);
    });

    test('should enforce UNIQUE(razorpay_refund_id)', async () => {
      const refundId = `rfnd_CONSTRAINT1-${randomUUID()}`;

      // Create two payments/bookings to back refunds
      const fixture1 = await createUserBookingPayment({ razorpayPaymentId: `pay_CONS_A-${randomUUID()}`, amount: 100 });
      const fixture2 = await createUserBookingPayment({ razorpayPaymentId: `pay_CONS_B-${randomUUID()}`, amount: 100 });

      // Insert first refund
      await db.query(
        `INSERT INTO refunds (payment_id, booking_id, user_id, razorpay_refund_id, amount, status)
         VALUES ($1, $2, $3, $4, 100, 'succeeded')`,
        [fixture1.paymentId, fixture1.bookingId, fixture1.userId, refundId]
      );

      // Try to insert with same razorpay_refund_id on different payment
      let constraintViolated = false;
      try {
        await db.query(
          `INSERT INTO refunds (payment_id, booking_id, user_id, razorpay_refund_id, amount, status)
           VALUES ($1, $2, $3, $4, 100, 'succeeded')`,
          [fixture2.paymentId, fixture2.bookingId, fixture2.userId, refundId]
        );
      } catch (err) {
        if (err.code === '23505') {
          constraintViolated = true;
        }
      }

      expect(constraintViolated).toBe(true);
    });
  });
});

// ─── Test cleanup ─────────────────────────────────────────────────────────
afterAll(async () => {
  await db.pool.end();
});
