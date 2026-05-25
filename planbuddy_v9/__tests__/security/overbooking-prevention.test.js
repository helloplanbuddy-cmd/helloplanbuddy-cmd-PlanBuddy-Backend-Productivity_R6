'use strict';

/**
 * __tests__/security/overbooking-prevention.test.js
 *
 * Security Audit [M-2]: Verify seat overbooking prevention.
 *
 * Problem: Idempotency.strict prevents DUPLICATE requests (same key), but
 * two DIFFERENT users with DIFFERENT idempotency keys can both try to book
 * the same seat simultaneously → race condition → overbooking.
 *
 * Solution: Database unique constraint on (seat_id, trip_id, travel_date)
 * for active bookings (status IN ('confirmed', 'pending', 'paid')).
 *
 * Tests:
 *  1. Only one booking can be created per seat per trip date
 *  2. Second booking for same seat fails with unique constraint violation
 *  3. Cancelled bookings do not block new bookings for same seat
 *  4. Concurrent requests to book same seat — only one succeeds
 */

const db = require('../../config/db');

describe('[M-2] Overbooking Prevention via Database Constraint', () => {
  let tripId;
  let seatId;
  let user1Id;
  let user2Id;

  beforeAll(async () => {
    // Setup: create test trip and seat
    const tripResult = await db.query(
      `INSERT INTO trips (title, location, start_date)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')
       RETURNING id`,
      ['Test Trip', 'Test Location']
    );
    tripId = tripResult.rows[0].id;

    const seatResult = await db.query(
      `INSERT INTO seats (trip_id, seat_number)
       VALUES ($1, $2)
       RETURNING id`,
      [tripId, 'A1']
    );
    seatId = seatResult.rows[0].id;

    // Setup: create test users
    const user1Result = await db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['user1@test.com', 'hash', 'User 1', 'user']
    );
    user1Id = user1Result.rows[0].id;

    const user2Result = await db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['user2@test.com', 'hash', 'User 2', 'user']
    );
    user2Id = user2Result.rows[0].id;
  });

  afterAll(async () => {
    // Cleanup
    await db.query('DELETE FROM bookings WHERE trip_id = $1', [tripId]);
    await db.query('DELETE FROM seats WHERE trip_id = $1', [tripId]);
    await db.query('DELETE FROM trips WHERE id = $1', [tripId]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [user1Id, user2Id]);
  });

  describe('Test 1: Unique constraint on (seat_id, trip_id, travel_date)', () => {
    test('first booking for seat succeeds', async () => {
      const result = await db.transaction(async (client) => {
        return client.query(
          `INSERT INTO bookings (user_id, trip_id, seat_id, travel_date, status, group_size, total_amount)
           VALUES ($1, $2, $3, NOW()::DATE, $4, 1, 5000)
           RETURNING id`,
          [user1Id, tripId, seatId, 'pending']
        );
      });

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].id).toBeDefined();
    });

    test('second booking for same seat fails with unique constraint', async () => {
      let error;
      try {
        await db.transaction(async (client) => {
          return client.query(
            `INSERT INTO bookings (user_id, trip_id, seat_id, travel_date, status, group_size, total_amount)
             VALUES ($1, $2, $3, NOW()::DATE, $4, 1, 5000)
             RETURNING id`,
            [user2Id, tripId, seatId, 'pending']
          );
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error.message).toMatch(/unique|constraint/i);
    });
  });

  describe('Test 2: Cancelled bookings do not block new bookings', () => {
    test('cancelled booking allows new booking for same seat', async () => {
      // Get the first booking and mark as cancelled
      const firstBooking = await db.query(
        `SELECT id FROM bookings WHERE user_id = $1 AND seat_id = $2 LIMIT 1`,
        [user1Id, seatId]
      );

      await db.query(
        `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
        [firstBooking.rows[0].id]
      );

      // Now second user should be able to book the same seat
      const result = await db.query(
        `INSERT INTO bookings (user_id, trip_id, seat_id, travel_date, status, group_size, total_amount)
         VALUES ($1, $2, $3, NOW()::DATE, $4, 1, 5000)
         RETURNING id`,
        [user2Id, tripId, seatId, 'pending']
      );

      expect(result.rows.length).toBe(1);
    });
  });

  describe('Test 3: Concurrent booking attempts - only one succeeds', () => {
    test('two simultaneous bookings for same seat - race condition protection', async () => {
      // Create a new seat for this test
      const newSeatResult = await db.query(
        `INSERT INTO seats (trip_id, seat_number)
         VALUES ($1, $2)
         RETURNING id`,
        [tripId, 'A2']
      );
      const newSeatId = newSeatResult.rows[0].id;

      // Simulate two concurrent booking attempts
      const promise1 = db.transaction(async (client) => {
        return client.query(
          `INSERT INTO bookings (user_id, trip_id, seat_id, travel_date, status, group_size, total_amount)
           VALUES ($1, $2, $3, NOW()::DATE, $4, 1, 5000)
           RETURNING id`,
          [user1Id, tripId, newSeatId, 'pending']
        );
      }).catch(err => ({ error: err }));

      const promise2 = db.transaction(async (client) => {
        return client.query(
          `INSERT INTO bookings (user_id, trip_id, seat_id, travel_date, status, group_size, total_amount)
           VALUES ($1, $2, $3, NOW()::DATE, $4, 1, 5000)
           RETURNING id`,
          [user2Id, tripId, newSeatId, 'pending']
        );
      }).catch(err => ({ error: err }));

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // One succeeds, one fails
      const succeeded = [result1, result2].filter(r => !r.error).length;
      const failed = [result1, result2].filter(r => r.error).length;

      expect(succeeded).toBe(1);
      expect(failed).toBe(1);
    });
  });

  describe('Security audit: verify constraint exists', () => {
    test('constraint should be in place in production', async () => {
      const constraintCheck = await db.query(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_name = 'bookings'
           AND constraint_type = 'UNIQUE'
           AND constraint_name LIKE '%seat%'`
      );

      expect(constraintCheck.rows.length).toBeGreaterThan(0);
    });
  });
});
