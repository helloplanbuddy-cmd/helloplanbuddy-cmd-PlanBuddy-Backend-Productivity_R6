'use strict';

jest.mock('../services/paymentReconciliationService', () => ({
  runReconciliation: jest.fn().mockResolvedValue({ processed: 1, recovered: 1, failed: 0 }),
}));

const paymentController = require('../controllers/paymentController');
const { runReconciliation } = require('../services/paymentReconciliationService');

describe('Manual reconciliation endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should invoke paymentReconciliationService.runReconciliation and return result', async () => {
    const req = {
      user: { id: 'admin-user' },
      requestId: 'req-manual-recon',
    };
    const res = {
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await paymentController.manualReconcile(req, res, next);

    expect(runReconciliation).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Manual reconciliation completed',
      data: { processed: 1, recovered: 1, failed: 0 },
    });
    expect(next).not.toHaveBeenCalled();
  });
});
