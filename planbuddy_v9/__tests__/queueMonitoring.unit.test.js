'use strict';

/**
 * __tests__/queueMonitoring.unit.test.js — Queue Monitoring & Backlog Visibility Tests
 *
 * RISK-008 SOLUTION: Verifies queue depth visibility and monitoring
 *
 * Tests:
 *   1. Queue stats collection (pending, active, delayed, failed)
 *   2. Multiple queue tracking
 *   3. Backlog alerts (warn threshold, critical threshold)
 *   4. Health check response format
 *   5. Metrics export for Prometheus
 *   6. Job completion tracking
 */

const queueMonitoring = require('../utils/queueMonitoring');

describe('Queue Monitoring & Backlog Visibility [RISK-008]', () => {
  // Mock queue implementation for testing
  const createMockQueue = (name, pending = 10, active = 3, delayed = 2, failed = 0) => ({
    name,
    getWaitingCount: () => Promise.resolve(pending),
    getActiveCount: () => Promise.resolve(active),
    getDelayedCount: () => Promise.resolve(delayed),
    getFailedCount: () => Promise.resolve(failed),
    getCompletedCount: () => Promise.resolve(100),
  });

  // ─── Test 1: Single Queue Stats ────────────────────────────────────────────

  describe('1. Queue Statistics Collection', () => {
    it('should collect stats from single queue', async () => {
      const queue = createMockQueue('payment-processing', 50, 5, 3, 1);
      const stats = await queueMonitoring.getQueueStats(queue);

      expect(stats).toBeDefined();
      expect(stats.name).toEqual('payment-processing');
      expect(stats.pending).toEqual(50);
      expect(stats.active).toEqual(5);
      expect(stats.delayed).toEqual(3);
      expect(stats.failed).toEqual(1);
      expect(stats.total_depth).toEqual(50 + 5 + 3);  // pending + active + delayed
    });

    it('should handle queue with no jobs', async () => {
      const queue = createMockQueue('webhook-relay', 0, 0, 0, 0);
      const stats = await queueMonitoring.getQueueStats(queue);

      expect(stats.pending).toEqual(0);
      expect(stats.total_depth).toEqual(0);
    });

    it('should return null if queue is null', async () => {
      const stats = await queueMonitoring.getQueueStats(null);
      expect(stats).toBeNull();
    });

    it('should calculate total_depth correctly', async () => {
      const queue = createMockQueue('test', 100, 20, 10, 5);
      const stats = await queueMonitoring.getQueueStats(queue);

      // total_depth = pending + active + delayed (not failed)
      expect(stats.total_depth).toEqual(130);
    });
  });

  // ─── Test 2: Multiple Queue Tracking ───────────────────────────────────────

  describe('2. Multiple Queue Monitoring', () => {
    it('should track all queues together', async () => {
      const queues = {
        payments: createMockQueue('payments', 50, 5, 2, 0),
        webhooks: createMockQueue('webhooks', 20, 2, 1, 0),
        reconciliation: createMockQueue('reconciliation', 5, 1, 0, 0),
      };

      const allStats = await queueMonitoring.getAllQueueStats(queues);

      expect(Object.keys(allStats)).toHaveLength(3);
      expect(allStats.payments.pending).toEqual(50);
      expect(allStats.webhooks.pending).toEqual(20);
      expect(allStats.reconciliation.pending).toEqual(5);
    });

    it('should aggregate total backlog', async () => {
      const queues = {
        q1: createMockQueue('q1', 30, 2, 1, 0),
        q2: createMockQueue('q2', 40, 3, 2, 0),
        q3: createMockQueue('q3', 10, 1, 0, 0),
      };

      const allStats = await queueMonitoring.getAllQueueStats(queues);
      const totalPending = Object.values(allStats).reduce((sum, q) => sum + q.pending, 0);

      expect(totalPending).toEqual(80);
    });
  });

  // ─── Test 3: Health Status & Alerts ────────────────────────────────────────

  describe('3. Queue Health & Alert Thresholds', () => {
    it('should report healthy status when below warning threshold', async () => {
      const queues = {
        q1: createMockQueue('q1', 50, 0, 0, 0),  // 50 < 100 warning
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).toBe(true);
      expect(health.totalBacklog).toEqual(50);
    });

    it('should report degraded status when exceeds critical threshold', async () => {
      const queues = {
        q1: createMockQueue('q1', 2000, 0, 0, 0),  // > 1000 critical
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).toBe(false);
      expect(health.totalBacklog).toEqual(2000);
    });

    it('should identify worst queue (highest depth)', async () => {
      const queues = {
        small: createMockQueue('small', 10, 0, 0, 0),
        medium: createMockQueue('medium', 100, 0, 0, 0),
        large: createMockQueue('large', 500, 0, 0, 0),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.worstQueue).toEqual('large');
      expect(health.worstDepth).toEqual(500);
    });

    it('should have appropriate warn/critical thresholds', () => {
      expect(queueMonitoring.QUEUE_DEPTH_WARN_THRESHOLD).toEqual(100);
      expect(queueMonitoring.QUEUE_DEPTH_CRITICAL_THRESHOLD).toEqual(1000);
    });
  });

  // ─── Test 4: Job Completion Tracking ───────────────────────────────────────

  describe('4. Job Processing Metrics', () => {
    it('should record job completion without error', () => {
      // Verify function doesn't throw
      expect(() => {
        queueMonitoring.recordJobCompletion('payment-processing', 1500, true);
      }).not.toThrow();
    });

    it('should record failed jobs', () => {
      expect(() => {
        queueMonitoring.recordJobCompletion('payment-processing', 500, false);
      }).not.toThrow();
    });

    it('should handle slow job detection', () => {
      expect(() => {
        queueMonitoring.recordJobCompletion('webhook-relay', 35000, true);  // > 30s warning
      }).not.toThrow();
    });
  });

  // ─── Test 5: Health Check Response Format ──────────────────────────────────

  describe('5. Health Check Integration', () => {
    it('should return correct queue health response structure', async () => {
      const queues = {
        q1: createMockQueue('q1', 15, 2, 1, 0),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      // Verify response structure for health controller integration
      expect(Object.keys(health)).toEqual(expect.arrayContaining([
        'healthy',
        'totalBacklog',
        'worstQueue',
        'worstDepth',
        'healthy_summary',
      ]));

      expect(health.healthy).toEqual(expect.any(Boolean));
      expect(health.totalBacklog).toEqual(expect.any(Number));
      expect(health.worstQueue).toEqual(expect.any(String));
      expect(health.worstDepth).toEqual(expect.any(Number));
      expect(health.healthy_summary).toEqual(expect.any(String));
    });

    it('should provide fallback when monitoring fails', async () => {
      const health = await queueMonitoring.getQueueHealth({});

      // When no queues, should still return valid response
      expect(health.healthy).toBe(true);  // fail-open
      expect(health.totalBacklog).toEqual(0);
    });
  });

  // ─── Test 6: Prometheus Metrics Accessibility ──────────────────────────────

  describe('6. Prometheus Metrics Export', () => {
    it('should expose queue depth gauge', () => {
      expect(queueMonitoring.queueDepthGauge).toBeDefined();
    });

    it('should expose active jobs gauge', () => {
      expect(queueMonitoring.activeJobsGauge).toBeDefined();
    });

    it('should expose failed jobs counter', () => {
      expect(queueMonitoring.failedJobsCounter).toBeDefined();
    });

    it('should expose processing time histogram', () => {
      expect(queueMonitoring.processingTimeHistogram).toBeDefined();
    });

    it('should support register method for Prometheus integration', () => {
      expect(typeof queueMonitoring.registerMetrics).toEqual('function');
    });
  });

  // ─── Test 7: Real-World Scenarios ──────────────────────────────────────────

  describe('7. Real-World Scenarios', () => {
    it('should handle sudden spike in queue depth', async () => {
      const queues = {
        payments: createMockQueue('payments', 1500, 50, 100, 2),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).toBe(false);  // 1500 > 1000 threshold
      expect(health.totalBacklog).toEqual(1500);
    });

    it('should recover when queue drains', async () => {
      // First: spike
      let queues = {
        payments: createMockQueue('payments', 2000, 50, 100, 0),
      };
      let health = await queueMonitoring.getQueueHealth(queues);
      expect(health.healthy).toBe(false);

      // Then: drained
      queues = {
        payments: createMockQueue('payments', 50, 5, 2, 0),
      };
      health = await queueMonitoring.getQueueHealth(queues);
      expect(health.healthy).toBe(true);
    });

    it('should handle multi-queue backlog aggregation', async () => {
      const queues = {
        payments: createMockQueue('payments', 600, 10, 5, 0),
        webhooks: createMockQueue('webhooks', 500, 8, 3, 0),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      // Both queues are under critical individually
      // But combined = 1100, which exceeds 1000
      expect(health.healthy).toBe(false);
      expect(health.totalBacklog).toEqual(1100);
    });
  });

  // ─── Test 8: Edge Cases ───────────────────────────────────────────────────

  describe('8. Edge Cases', () => {
    it('should handle empty queue object', async () => {
      const health = await queueMonitoring.getQueueHealth({});
      expect(health.healthy).toBe(true);
      expect(health.totalBacklog).toEqual(0);
    });

    it('should handle queue with missing count methods', async () => {
      const queue = {
        name: 'broken',
        // missing getWaitingCount, etc.
      };

      const stats = await queueMonitoring.getQueueStats(queue);
      expect(stats).toBeDefined();  // Should not crash
    });

    it('should safely fail if queue throws error', async () => {
      const queue = {
        name: 'error-queue',
        getWaitingCount: () => Promise.reject(new Error('Redis down')),
      };

      const stats = await queueMonitoring.getQueueStats(queue);
      expect(stats).toBeNull();  // Should return null on error
    });
  });
});
