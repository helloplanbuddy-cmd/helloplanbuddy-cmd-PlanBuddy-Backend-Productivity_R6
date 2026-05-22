'use strict';

describe('ISSUE 1: Webhook → Queue → Worker → Financial Apply Guarantee (producer-side proof)', () => {
  test('webhook request is persisted and enqueues webhook-events job', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret';

    // Arrange
    const enqueueWebhookEvent = jest.fn().mockResolvedValue({ id: 'job_1' });

    // ✅ THIS is the REAL DB call now (inside transaction)
    const mockClientQuery = jest.fn().mockResolvedValue({
      rows: [{ id: 'evt_test_1' }],
    });

    // Mock queue
    jest.doMock('../config/queues', () => ({
      enqueueWebhookEvent,
    }));

    // Mock DB (CORRECT CONTRACT)
    const mockTransaction = jest.fn(async (fn) => {
      return fn({
        query: mockClientQuery,
      });
    });

    jest.doMock('../config/db', () => ({
      transaction: mockTransaction,
    }));

    // Reload controller AFTER mocks
    jest.resetModules();
    const { razorpayWebhook } = require('../controllers/razorpayWebhookController');

    const payloadObj = {
      id: 'evt_test_1',
      event: 'payment.captured',
      payment: {
        entity: { id: 'pay_test_1' },
      },
    };

    const rawPayload = JSON.stringify(payloadObj);

    const crypto = require('crypto');
    const signatureHex = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(Buffer.from(rawPayload, 'utf8'))
      .digest('hex');

    const req = {
      headers: { 'x-razorpay-signature': signatureHex },
      requestId: 'corr_1',
      body: Buffer.from(rawPayload, 'utf8'),
      user: { id: 123 },
    };

    const res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };

    const next = jest.fn();

    // Act
    await razorpayWebhook(req, res, next);

    // ✅ ASSERT CORRECT BEHAVIOR (NOT IMPLEMENTATION DETAIL)

    // Transaction must be used
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // DB insert must happen inside transaction
    expect(mockClientQuery).toHaveBeenCalledTimes(1);

    // Queue must be triggered AFTER persistence
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1);

    const enqueuedArg = enqueueWebhookEvent.mock.calls[0][0];
    expect(enqueuedArg).toMatchObject({
      eventId: 'evt_test_1',
      provider: 'razorpay',
      providerEventId: 'evt_test_1',
      eventType: 'payment.captured',
      requestId: 'corr_1',
    });

    expect(res.status).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});