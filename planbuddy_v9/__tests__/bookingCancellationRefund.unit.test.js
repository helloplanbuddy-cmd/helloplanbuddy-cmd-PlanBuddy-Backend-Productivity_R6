'use strict';

const db = require('../config/db');
const RefundService = require('../services/refundService');
const EmailService = require('../services/emailService');

jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../services/refundService', () => ({ initiateRefund: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendBookingCancellation: jest.fn() }));

const bookingController = require('../controllers/bookingController');

describe('Booking cancellation refund', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should call RefundService.initiateRefund with correct explicit args for full refund', async () => {
    const bookingId = 'booking-abc-123';
    const existingBooking = {
      id: bookingId,
      user_id: 'user-123',
      status: 'confirmed',
      payment_status: 'paid',
      trip_title: 'Test Trip',
    };

    db.query.mockResolvedValueOnce({ rows: [existingBooking] })
      .mockResolvedValueOnce({ rows: [{ id: bookingId }] })
      .mockResolvedValueOnce({ rows: [existingBooking] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-123', email: 'user@test.com', name: 'Test User' }] });

    const req = {
      params: { bookingId },
      body: { reason: 'Changed plans' },
      user: { id: 'user-123', role: 'user' },
      requestId: 'req-999',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await bookingController.cancelBooking(req, res, next);

    expect(RefundService.initiateRefund).toHaveBeenCalledTimes(1);
    expect(RefundService.initiateRefund).toHaveBeenCalledWith(
      bookingId,
      null,
      'Changed plans',
      'user-123'
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: expect.stringContaining('Booking cancelled and refund initiated'),
    }));
  });

  test('should return idempotent booking cancellation in progress when update claim fails', async () => {
    const bookingId = 'booking-inflight-123';
    const existingBooking = {
      id: bookingId,
      user_id: 'user-456',
      status: 'confirmed',
      payment_status: 'paid',
      trip_title: 'Test Trip',
    };

    db.query.mockResolvedValueOnce({ rows: [existingBooking] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existingBooking] });

    const req = {
      params: { bookingId },
      body: { reason: 'Duplicate request' },
      user: { id: 'user-456', role: 'user' },
      requestId: 'req-1000',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await bookingController.cancelBooking(req, res, next);

    expect(RefundService.initiateRefund).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'Booking cancellation already in progress.',
    }));
  });
});
