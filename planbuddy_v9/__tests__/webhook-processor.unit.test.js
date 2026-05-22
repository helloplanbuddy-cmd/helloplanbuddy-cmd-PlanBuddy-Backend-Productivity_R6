jest.mock('../config/db');
jest.mock('../controllers/razorpayWebhookController', () => ({
  applyPaymentEvent: jest.fn(),
  applyRefundEvent: jest.fn(),
}));

const db = require('../config/db');
const { applyPaymentEvent } = require('../controllers/razorpayWebhookController');

const client = { query: jest.fn() };

db.transaction = jest.fn(async (cb) => cb(client));
db.end = jest.fn(async () => {});

const worker = require('../workers/webhook-processor.worker');

describe('webhook-processor worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    client.query.mockImplementation((text, params) => {
      if (typeof text === 'string' && text.includes('INSERT INTO webhook_event_execution_log')) {
        return Promise.resolve({ rowCount: 1, rows: [{ provider_event_id: params[0] }] });
      }
      if (typeof text === 'string' && text.includes('UPDATE webhook_event_execution_log')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof text === 'string' && text.includes('UPDATE webhook_events')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
  });

  test('processEvent calls applier and marks processed using lease fencing', async () => {
    const event = {
      id: 42,
      event_type: 'payment.captured',
      payload: { payload: { payment: { entity: { id: 'pay_123' } } } },
      provider_event_id: 'evt_abc',
      lease_version: 7,
    };

    await worker.processEvent(event);

    expect(applyPaymentEvent).toHaveBeenCalledWith(client, {
      eventType: 'payment.captured',
      paymentId: 'pay_123',
      eventId: 'evt_abc',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_event_execution_log'),
      expect.any(Array),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE webhook_event_execution_log'),
      ['evt_abc'],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE webhook_events'),
      [event.id, event.lease_version],
    );
  });

  test('processEvent skips business logic when execution log already exists', async () => {
    const event = {
      id: 99,
      event_type: 'payment.captured',
      payload: { payload: { payment: { entity: { id: 'pay_dup' } } } },
      provider_event_id: 'evt_dup',
      lease_version: 3,
    };

    client.query.mockImplementation((text, params) => {
      if (typeof text === 'string' && text.includes('INSERT INTO webhook_event_execution_log')) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (typeof text === 'string' && text.includes('UPDATE webhook_events')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });

    await worker.processEvent(event);

    expect(applyPaymentEvent).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_event_execution_log'),
      expect.any(Array),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE webhook_events'),
      [event.id, event.lease_version],
    );
  });
});
