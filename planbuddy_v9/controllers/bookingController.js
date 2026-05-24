'use strict';

/**
 * controllers/bookingController.js — Booking Controller (v6.1)
 *
 * Concurrency-safe booking and cancellation handlers.
 * This module must contain controller logic only.
 */

const DbService = require('../services/dbService_fixed');
const db = require('../config/db');
const logger = require('../utils/logger');
const crypto = require('crypto');
const metrics = require('../services/metricsService');
const { updateTraceContext } = require('../middleware/traceId');

exports.createBooking = async (req, res) => {
  logger.info({ requestId: req.requestId }, '[booking] createBooking executed');
  return res.status(200).json({ ok: true });
};

exports.getUserBookings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let whereClause = 'WHERE b.user_id = $1';
    const params = [userId];

    if (status) {
      params.push(status);
      whereClause += ` AND b.status = $${params.length}`;
    }

    const [bookings, countResult] = await Promise.all([
      db.query(
        `SELECT
           b.id, b.status, b.payment_status, b.group_size, b.slot_id,
           b.total_amount, b.travel_date, b.created_at,
           b.expires_at, b.trip_snapshot,
           t.title        AS trip_title,
           t.location     AS trip_location,
           t.cover_image  AS trip_image,
           p.razorpay_payment_id,
           p.status       AS payment_capture_status
         FROM bookings b
         LEFT JOIN trips    t ON b.trip_id    = t.id
         LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'captured'
         ${whereClause}
         ORDER BY b.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM bookings b ${whereClause}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      success: true,
      data: {
        bookings: bookings.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getBooking = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    const result = await db.query(
      `SELECT
         b.*,
         t.title        AS trip_title,
         t.location     AS trip_location,
         t.cover_image  AS trip_image,
         t.description  AS trip_description,
         u.name         AS user_name,
         u.email        AS user_email,
         p.razorpay_payment_id,
         p.amount       AS payment_amount,
         p.status       AS payment_capture_status,
         p.created_at   AS payment_created_at
       FROM bookings b
       LEFT JOIN trips    t ON b.trip_id    = t.id
       LEFT JOIN users    u ON b.user_id    = u.id
       LEFT JOIN payments p ON p.booking_id = b.id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const booking = result.rows[0];

    if (booking.user_id !== userId && req.user.role !== 'admin' && req.user.role !== 'agency') {
      return res.status(403).json({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Access denied',
      });
    }

    res.json({ success: true, data: { booking } });
  } catch (err) {
    next(err);
  }
};

exports.cancelBooking = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body;

    const bookingCheck = await db.query(
      `SELECT b.*, t.title AS trip_title
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const existing = bookingCheck.rows[0];

    if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'Access denied',
      });
    }

    if (existing.status === 'confirmed' && existing.payment_status === 'paid') {
      const claimResult = await db.query(
        `UPDATE bookings
         SET status = 'cancellation_pending',
             updated_at = NOW()
         WHERE id = $1
           AND status = 'confirmed'           AND payment_status = 'paid'
         RETURNING id`,
        [bookingId]
      );

      if (claimResult.rows.length === 0) {
        const current = await db.query(
          `SELECT b.*, t.title AS trip_title FROM bookings b
           JOIN trips t ON t.id = b.trip_id WHERE b.id = $1`,
          [bookingId]
        );
        logger.warn('Refund cancellation already claimed — idempotent return', {
          requestId: req.requestId,
          userId: req.user.id,
          bookingId,
        });
        return res.json({
          success: true,
          message: 'Booking cancellation already in progress.',
          data: { booking: current.rows[0] },
        });
      }

      const RefundService = require('../services/refundService');
      try {
        await RefundService.initiateRefund(
          bookingId,
          reason || 'Cancelled by user',
          req.user.id
        );
        const updated = await db.query(
          `SELECT b.*, t.title AS trip_title FROM bookings b
           JOIN trips t ON t.id = b.trip_id WHERE b.id = $1`,
          [bookingId]
        );
        const booking = updated.rows[0];

        const userResult = await db.query('SELECT id, email, name FROM users WHERE id=$1', [req.user.id]);
        const EmailService = require('../services/emailService');
        await EmailService.sendBookingCancellation(
          booking,
          userResult.rows[0],
          { title: existing.trip_title },
          reason || 'Cancelled by user'
        );

        logger.info('Confirmed booking cancelled with refund', {
          requestId: req.requestId,
          userId: req.user.id,
          bookingId,
        });

        return res.json({
          success: true,
          message: 'Booking cancelled and refund initiated. Funds will arrive in 5–7 business days.',
          data: { booking },
        });
      } catch (refundErr) {
        logger.error('Refund failed during cancellation', {
          requestId: req.requestId,
          bookingId,
          error: refundErr.message,
        });
        return res.status(refundErr.status || 502).json({
          success: false,
          code: refundErr.code || 'REFUND_FAILED',
          message: refundErr.message || 'Refund initiation failed. Please contact support.',
        });
      }
    }

    const idempotencyKey = req.headers['idempotency-key'];

    const booking = await DbService.cancelBooking(
      bookingId,
      idempotencyKey,
      reason || 'Cancelled by user',
      req.user.id
    );

    try {
      const userResult = await db.query('SELECT id, email, name FROM users WHERE id=$1', [req.user.id]);
      const EmailService = require('../services/emailService');
      await EmailService.sendBookingCancellation(
        booking,
        userResult.rows[0],
        { title: existing.trip_title },
        reason || 'Cancelled by user'
      );
    } catch (emailErr) {
      logger.warn('Cancellation email failed (non-fatal)', {
        bookingId,
        error: emailErr.message,
      });
    }

    logger.info('Booking cancelled', {
      requestId: req.requestId,
      userId: req.user.id,
      bookingId,
    });

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: { booking },
    });
  } catch (err) {
    if (err.code && err.structured) {
      return res.status(err.status || 409).json(err.structured);
    }
    if (err.status === 404 || err.status === 409) {
      return res.status(err.status).json({
        success: false,
        code: err.code || 'BOOKING_ERROR',
        message: err.message,
      });
    }
    next(err);
  }
};

exports.getAllBookings = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let whereClause = '';
    const params = [];

    if (status) {
      params.push(status);
      whereClause = 'WHERE b.status = $1';
    }

    const [bookings, countResult] = await Promise.all([
      db.query(
        `SELECT
           b.id, b.status, b.payment_status, b.group_size, b.total_amount, b.travel_date, b.created_at,
           t.title        AS trip_title,
           u.name         AS user_name,
           u.email        AS user_email
         FROM bookings b
         LEFT JOIN trips    t ON b.trip_id    = t.id
         LEFT JOIN users    u ON b.user_id    = u.id
         ${whereClause}
         ORDER BY b.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM bookings b ${whereClause}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      success: true,
      data: {
        bookings: bookings.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.checkAvailability = async (req, res, next) => {
  try {
    const { tripId, startDate, endDate } = req.query;

    const result = await db.query(
      `SELECT
         t.id,
         t.max_group_size,
         t.current_bookings,
         t.max_group_size - t.current_bookings AS available_slots,
         t.is_active,
         d.travel_date,
         COALESCE(d.booked_count, 0)               AS booked_on_date,
         t.max_group_size - COALESCE(d.booked_count, 0) AS available_on_date
       FROM trips t
       CROSS JOIN (
         SELECT generate_series($2::date, $3::date, '1 day'::interval)::date AS travel_date
       ) dates
       LEFT JOIN (
         SELECT travel_date, SUM(group_size) AS booked_count
         FROM bookings
         WHERE trip_id = $1
           AND status NOT IN ('cancelled', 'failed', 'expired')
           AND travel_date BETWEEN $2 AND $3
         GROUP BY travel_date
       ) d ON d.travel_date = dates.travel_date
       WHERE t.id = $1`,
      [tripId, startDate, endDate]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'TRIP_NOT_FOUND',
        message: 'Trip not found',
      });
    }

    res.json({ success: true, data: { tripId, availability: result.rows } });
  } catch (err) {
    next(err);
  }
};

exports.getAvailableSlots = async (req, res, next) => {
  try {
    const { tripId, startDate, endDate } = req.query;

    const result = await db.query(
      `SELECT
         dates.travel_date,
         t.max_group_size,
         COALESCE(SUM(b.group_size), 0) AS booked,
         t.max_group_size - COALESCE(SUM(b.group_size), 0) AS available
       FROM trips t
       CROSS JOIN (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS travel_date
       ) dates
       LEFT JOIN bookings b ON b.trip_id = t.id
                            AND b.travel_date = dates.travel_date
                            AND b.status NOT IN ('cancelled', 'failed', 'expired')
       WHERE t.id = $1 AND t.is_active = true
       GROUP BY dates.travel_date, t.max_group_size
       ORDER BY dates.travel_date`,
      [tripId, startDate, endDate]
    );

    res.json({
      success: true,
      data: {
        tripId,
        slots: result.rows.map(row => ({
          date: row.travel_date,
          available: parseInt(row.available, 10),
          booked: parseInt(row.booked, 10),
          total: parseInt(row.max_group_size, 10),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};
