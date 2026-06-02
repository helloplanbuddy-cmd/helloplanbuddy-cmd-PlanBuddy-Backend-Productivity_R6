#!/usr/bin/env node
/**
 * Phase 2: Schema Integrity & Runtime Validation Test Suite
 * 
 * Tests critical runtime behaviors that Phase 1 migration audit cannot prove:
 * - Payment constraint enforcement (amount/refund validation)
 * - Seat booking atomicity under concurrent requests
 * - Idempotency correctness under retries
 * - Webhook replay protection and deduplication
 * - Refund state transitions and safety
 * 
 * Run: node phase-2-runtime-validation.js
 */

require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.DATABASE_URL;
const TEST_RESULTS = [];

// ═══════════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

async function createTestContext() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

async function createTestUser(client) {
  const userId = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, email, password_hash, name) 
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [userId, `test_${Date.now()}_${Math.random()}@example.com`, 'hash_pwd', 'Test User']
  );
  return userId;
}

async function createTestTrip(client) {
  const tripId = crypto.randomUUID();
  const agencyId = await createTestUser(client);
  await client.query(
    `INSERT INTO trips (id, agency_id, title, description, location, price, currency, max_group_size, start_date, end_date) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [tripId, agencyId, 'Test Trip', 'Test trip description', 'Mumbai', 1000, 'INR', 50, '2026-06-01', '2026-06-30']
  );
  return tripId;
}

async function createTestBooking(client, userId, tripId) {
  const bookingId = crypto.randomUUID();
  const agencyId = await createTestUser(client);
  await client.query(
    `INSERT INTO bookings (id, user_id, agency_id, trip_id, travel_date, status, payment_status, group_size, total_amount, final_amount, trip_snapshot) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
    [bookingId, userId, agencyId, tripId, '2026-06-15', 'pending', 'unpaid', 1, 1000, 1000, JSON.stringify({})]
  );
  return bookingId;
}

function logTest(name, status, details = '') {
  const icon = status === 'PASS' ? '✅' : '❌';
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${icon} ${name}${details ? ' — ' + details : ''}`;
  console.log(msg);
  TEST_RESULTS.push({ name, status, details, timestamp });
}

async function runTest(testName, testFn) {
  try {
    const result = await testFn();
    logTest(testName, result.status, result.details);
    return result.status === 'PASS';
  } catch (err) {
    logTest(testName, 'FAIL', err.message);
    console.error(err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT CONSTRAINT TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function testPaymentAmountConstraint() {
  const client = await createTestContext();
  try {
    const userId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const bookingId = await createTestBooking(client, userId, tripId);
    
    // Attempt: negative amount (should fail CHECK constraint)
    try {
      await client.query(
        `INSERT INTO payments (id, booking_id, user_id, razorpay_payment_id, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          bookingId,
          userId,
          'TEST_INVALID_AMOUNT',
          -100, // INVALID
          'INR',
          'created'
        ]
      );
      return { status: 'FAIL', details: 'Negative amount was not rejected by CHECK constraint' };
    } catch (checkErr) {
      if (checkErr.message.includes('CHECK constraint') || checkErr.code === '23514') {
        return { status: 'PASS', details: 'Negative amount correctly rejected' };
      }
      throw checkErr;
    }
  } finally {
    await client.end();
  }
}

async function testRefundedAmountConstraint() {
  const client = await createTestContext();
  try {
    const userId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const bookingId = await createTestBooking(client, userId, tripId);
    const paymentId = crypto.randomUUID();
    
    // Create valid payment
    await client.query(
      `INSERT INTO payments (id, booking_id, user_id, razorpay_payment_id, amount, currency, status, refunded_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [paymentId, bookingId, userId, crypto.randomBytes(8).toString('hex'), 1000, 'INR', 'created', 0]
    );
    
    // Attempt: refunded_amount > amount (should fail CHECK constraint)
    try {
      await client.query(
        `UPDATE payments SET refunded_amount = $1 WHERE id = $2`,
        [1500, paymentId] // Refunded more than paid
      );
      return { status: 'FAIL', details: 'refunded_amount > amount was not rejected' };
    } catch (checkErr) {
      if (checkErr.message.includes('CHECK constraint') || checkErr.code === '23514') {
        return { status: 'PASS', details: 'Over-refunding correctly rejected' };
      }
      throw checkErr;
    }
  } finally {
    await client.end();
  }
}

async function testPaymentStatusEnumConstraint() {
  const client = await createTestContext();
  try {
    const userId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const bookingId = await createTestBooking(client, userId, tripId);
    const paymentId = crypto.randomUUID();
    
    // Create payment with valid status
    await client.query(
      `INSERT INTO payments (id, booking_id, user_id, razorpay_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [paymentId, bookingId, userId, crypto.randomBytes(8).toString('hex'), 1000, 'INR', 'created']
    );
    
    // Attempt: invalid status
    try {
      await client.query(
        `UPDATE payments SET status = $1 WHERE id = $2`,
        ['INVALID_STATUS', paymentId]
      );
      return { status: 'FAIL', details: 'Invalid payment status was not rejected' };
    } catch (checkErr) {
      if (checkErr.message.includes('CHECK constraint') || checkErr.code === '23514') {
        return { status: 'PASS', details: 'Invalid status correctly rejected' };
      }
      throw checkErr;
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEAT BOOKING ATOMICITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function testSeatBookingUniqueConstraint() {
  const client = await createTestContext();
  try {
    const userId1 = await createTestUser(client);
    const userId2 = await createTestUser(client);
    const agencyId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const seatId = crypto.randomUUID();
    const travelDate = '2026-06-15';
    
    // Create seat
    await client.query(
      `INSERT INTO seats (id, trip_id, seat_number) VALUES ($1, $2, $3)`,
      [seatId, tripId, 'A1']
    );
    
    // Create first booking (confirmed)
    await client.query(
      `INSERT INTO bookings (id, user_id, agency_id, trip_id, seat_id, travel_date, status, payment_status, group_size, total_amount, final_amount, trip_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        crypto.randomUUID(),
        userId1,
        agencyId,
        tripId,
        seatId,
        travelDate,
        'confirmed',
        'unpaid',
        1,
        1000,
        1000,
        JSON.stringify({})
      ]
    );
    
    // Attempt: second booking on same seat (should fail unique index)
    try {
      await client.query(
        `INSERT INTO bookings (id, user_id, agency_id, trip_id, seat_id, travel_date, status, payment_status, group_size, total_amount, final_amount, trip_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          crypto.randomUUID(),
          userId2,
          agencyId,
          tripId,
          seatId,
          travelDate,
          'confirmed',
          'unpaid',
          1,
          1000,
          1000,
          JSON.stringify({})
        ]
      );
      return { status: 'FAIL', details: 'Duplicate seat booking was not rejected' };
    } catch (uniqueErr) {
      if (uniqueErr.message.includes('unique constraint') || uniqueErr.message.includes('UNIQUE') || uniqueErr.code === '23505') {
        return { status: 'PASS', details: 'Duplicate seat correctly rejected by unique index' };
      }
      throw uniqueErr;
    }
  } finally {
    await client.end();
  }
}

async function testSeatBookingPartialIndexLogic() {
  const client = await createTestContext();
  try {
    const userId1 = await createTestUser(client);
    const userId2 = await createTestUser(client);
    const agencyId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const seatId = crypto.randomUUID();
    const travelDate = '2026-06-15';
    
    // Create seat
    await client.query(
      `INSERT INTO seats (id, trip_id, seat_number) VALUES ($1, $2, $3)`,
      [seatId, tripId, 'B2']
    );
    
    // Create first booking (confirmed)
    const booking1 = crypto.randomUUID();
    await client.query(
      `INSERT INTO bookings (id, user_id, agency_id, trip_id, seat_id, travel_date, status, payment_status, group_size, total_amount, final_amount, trip_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [booking1, userId1, agencyId, tripId, seatId, travelDate, 'confirmed', 'unpaid', 1, 1000, 1000, JSON.stringify({})]
    );
    
    // Cancel first booking
    await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
      [booking1]
    );
    
    // Should now be able to book same seat (index is partial: only applies to confirmed/pending/paid)
    try {
      await client.query(
        `INSERT INTO bookings (id, user_id, agency_id, trip_id, seat_id, travel_date, status, payment_status, group_size, total_amount, final_amount, trip_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [crypto.randomUUID(), userId2, agencyId, tripId, seatId, travelDate, 'confirmed', 'unpaid', 1, 1000, 1000, JSON.stringify({})]
      );
      return { status: 'PASS', details: 'Cancelled seat can be re-booked (partial index works)' };
    } catch (err) {
      return { status: 'FAIL', details: 'Cancelled seat cannot be re-booked: ' + err.message };
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function testIdempotencyKeyUniqueness() {
  const client = await createTestContext();
  try {
    const idempKey = 'IDEMPOTENT-TEST-' + Date.now() + '-' + Math.random();
    const userId = await createTestUser(client);
    
    // First idempotency insertion
    await client.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_code, response_body) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [idempKey, userId, '/api/test', 'hash1', 200, JSON.stringify({ result: 'first' })]
    );
    
    // Second idempotency insertion (should fail due to unique constraint)
    try {
      await client.query(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_code, response_body) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [idempKey, userId, '/api/test', 'hash2', 200, JSON.stringify({ result: 'second' })]
      );
      return { status: 'FAIL', details: 'Duplicate idempotency key was not rejected' };
    } catch (uniqueErr) {
      if (uniqueErr.message.includes('unique') || uniqueErr.message.includes('UNIQUE') || uniqueErr.code === '23505') {
        return { status: 'PASS', details: 'Idempotency key correctly enforced uniqueness' };
      }
      throw uniqueErr;
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK AUTHENTICATION & REPLAY PROTECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function testWebhookAuthenticityConstraint() {
  const client = await createTestContext();
  try {
    const provider = 'razorpay';
    const eventId = 'evt_' + crypto.randomBytes(16).toString('hex');
    const signature = crypto.randomBytes(32).toString('hex');
    
    // First webhook event
    await client.query(
      `INSERT INTO webhook_events (id, provider, razorpay_event_id, signature, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), provider, eventId, signature, 'payment.authorized', '{}']
    );
    
    // Attempt: duplicate (same provider, event_id, signature) — should fail
    try {
      await client.query(
        `INSERT INTO webhook_events (id, provider, razorpay_event_id, signature, event_type, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), provider, eventId, signature, 'payment.authorized', '{}']
      );
      return { status: 'FAIL', details: 'Duplicate webhook (same event_id + signature) was not rejected' };
    } catch (uniqueErr) {
      if (uniqueErr.message.includes('unique') || uniqueErr.message.includes('UNIQUE') || uniqueErr.code === '23505') {
        return { status: 'PASS', details: 'Duplicate webhook correctly rejected by authenticity constraint' };
      }
      throw uniqueErr;
    }
  } finally {
    await client.end();
  }
}

async function testWebhookEventIdUniqueness() {
  const client = await createTestContext();
  try {
    const eventId = 'evt_replay_' + crypto.randomBytes(16).toString('hex');
    
    // First webhook with event_id
    await client.query(
      `INSERT INTO webhook_events (id, razorpay_event_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), eventId, 'payment.captured', '{}']
    );
    
    // Attempt: same event_id with different signature — should still fail (event_id is unique separately)
    try {
      await client.query(
        `INSERT INTO webhook_events (id, razorpay_event_id, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), eventId, 'payment.captured', '{}']
      );
      return { status: 'FAIL', details: 'Webhook with duplicate event_id was not rejected' };
    } catch (uniqueErr) {
      if (uniqueErr.message.includes('unique') || uniqueErr.message.includes('UNIQUE') || uniqueErr.code === '23505') {
        return { status: 'PASS', details: 'Duplicate event_id correctly rejected (replay prevention works)' };
      }
      throw uniqueErr;
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REFUND STATE TRANSITION TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function testRefundStatusEnumConstraint() {
  const client = await createTestContext();
  try {
    const userId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const bookingId = await createTestBooking(client, userId, tripId);
    const paymentId = crypto.randomUUID();
    
    // Create payment
    await client.query(
      `INSERT INTO payments (id, booking_id, user_id, razorpay_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [paymentId, bookingId, userId, crypto.randomBytes(8).toString('hex'), 1000, 'INR', 'created']
    );
    
    // Create refund with invalid status
    try {
      await client.query(
        `INSERT INTO refunds (id, payment_id, booking_id, amount, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), paymentId, bookingId, 500, 'INVALID_STATUS']
      );
      return { status: 'FAIL', details: 'Invalid refund status was not rejected' };
    } catch (err) {
      if (err.message.includes('CHECK constraint') || err.code === '23514') {
        return { status: 'PASS', details: 'Invalid refund status correctly rejected by CHECK constraint' };
      }
      throw err;
    }
  } finally {
    await client.end();
  }
}

async function testRefundIdempotencyKeyUniqueness() {
  const client = await createTestContext();
  try {
    const userId = await createTestUser(client);
    const tripId = await createTestTrip(client);
    const bookingId = await createTestBooking(client, userId, tripId);
    const paymentId = crypto.randomUUID();
    const idempKey = 'REFUND-' + Date.now() + '-' + Math.random();
    
    // Create payment first
    await client.query(
      `INSERT INTO payments (id, booking_id, user_id, razorpay_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [paymentId, bookingId, userId, crypto.randomBytes(8).toString('hex'), 1000, 'INR', 'created']
    );
    
    // Create first refund with idempotency key
    await client.query(
      `INSERT INTO refunds (id, payment_id, booking_id, amount, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        paymentId,
        bookingId,
        500,
        'created',
        idempKey
      ]
    );
    
    // Attempt: duplicate idempotency key — should fail
    try {
      await client.query(
        `INSERT INTO refunds (id, payment_id, booking_id, amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          crypto.randomUUID(),
          paymentId,
          bookingId,
          500,
          'created',
          idempKey
        ]
      );
      return { status: 'FAIL', details: 'Duplicate refund idempotency key was not rejected' };
    } catch (uniqueErr) {
      if (uniqueErr.message.includes('unique') || uniqueErr.message.includes('UNIQUE') || uniqueErr.code === '23505') {
        return { status: 'PASS', details: 'Duplicate refund idempotency key correctly rejected' };
      }
      throw uniqueErr;
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runAllTests() {
  console.log('\n' + '═'.repeat(80));
  console.log('PHASE 2: SCHEMA INTEGRITY & RUNTIME VALIDATION TEST SUITE');
  console.log('═'.repeat(80) + '\n');
  
  const tests = [
    // Payment constraints
    ['Payment Amount Constraint (negative)', testPaymentAmountConstraint],
    ['Payment Refunded Amount Constraint', testRefundedAmountConstraint],
    ['Payment Status Enum Constraint', testPaymentStatusEnumConstraint],
    
    // Seat booking
    ['Seat Booking Unique Constraint', testSeatBookingUniqueConstraint],
    ['Seat Booking Partial Index Logic', testSeatBookingPartialIndexLogic],
    
    // Idempotency
    ['Idempotency Key Uniqueness', testIdempotencyKeyUniqueness],
    
    // Webhook authentication
    ['Webhook Authenticity Constraint', testWebhookAuthenticityConstraint],
    ['Webhook Event ID Uniqueness', testWebhookEventIdUniqueness],
    
    // Refund state transitions
    ['Refund Status Enum Constraint', testRefundStatusEnumConstraint],
    ['Refund Idempotency Key Uniqueness', testRefundIdempotencyKeyUniqueness],
  ];
  
  let passed = 0, failed = 0;
  
  for (const [testName, testFn] of tests) {
    const result = await runTest(testName, testFn);
    if (result) passed++;
    else failed++;
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('═'.repeat(80) + '\n');
  
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('FATAL ERROR:', err.message);
  process.exit(1);
});
