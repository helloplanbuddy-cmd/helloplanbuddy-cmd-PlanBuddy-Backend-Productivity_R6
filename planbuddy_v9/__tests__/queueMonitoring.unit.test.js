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

const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
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

      expect(stats).to.exist;
      expect(stats.name).to.equal('payment-processing');
      expect(stats.pending).to.equal(50);
      expect(stats.active).to.equal(5);
      expect(stats.delayed).to.equal(3);
      expect(stats.failed).to.equal(1);
      expect(stats.total_depth).to.equal(50 + 5 + 3);  // pending + active + delayed
    });

    it('should handle queue with no jobs', async () => {
      const queue = createMockQueue('webhook-relay', 0, 0, 0, 0);
      const stats = await queueMonitoring.getQueueStats(queue);

      expect(stats.pending).to.equal(0);
      expect(stats.total_depth).to.equal(0);
    });

    it('should return null if queue is null', async () => {
      const stats = await queueMonitoring.getQueueStats(null);
      expect(stats).to.be.null;
    });

    it('should calculate total_depth correctly', async () => {
      const queue = createMockQueue('test', 100, 20, 10, 5);
      const stats = await queueMonitoring.getQueueStats(queue);

      // total_depth = pending + active + delayed (not failed)
      expect(stats.total_depth).to.equal(130);
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

      expect(Object.keys(allStats)).to.have.lengthOf(3);
      expect(allStats.payments.pending).to.equal(50);
      expect(allStats.webhooks.pending).to.equal(20);
      expect(allStats.reconciliation.pending).to.equal(5);
    });

    it('should aggregate total backlog', async () => {
      const queues = {
        q1: createMockQueue('q1', 30, 2, 1, 0),
        q2: createMockQueue('q2', 40, 3, 2, 0),
        q3: createMockQueue('q3', 10, 1, 0, 0),
      };

      const allStats = await queueMonitoring.getAllQueueStats(queues);
      const totalPending = Object.values(allStats).reduce((sum, q) => sum + q.pending, 0);

      expect(totalPending).to.equal(80);
    });
  });

  // ─── Test 3: Health Status & Alerts ────────────────────────────────────────

  describe('3. Queue Health & Alert Thresholds', () => {
    it('should report healthy status when below warning threshold', async () => {
      const queues = {
        q1: createMockQueue('q1', 50, 0, 0, 0),  // 50 < 100 warning
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).to.be.true;
      expect(health.totalBacklog).to.equal(50);
    });

    it('should report degraded status when exceeds critical threshold', async () => {
      const queues = {
        q1: createMockQueue('q1', 2000, 0, 0, 0),  // > 1000 critical
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).to.be.false;
      expect(health.totalBacklog).to.equal(2000);
    });

    it('should identify worst queue (highest depth)', async () => {
      const queues = {
        small: createMockQueue('small', 10, 0, 0, 0),
        medium: createMockQueue('medium', 100, 0, 0, 0),
        large: createMockQueue('large', 500, 0, 0, 0),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.worstQueue).to.equal('large');
      expect(health.worstDepth).to.equal(500);
    });

    it('should have appropriate warn/critical thresholds', () => {
      expect(queueMonitoring.QUEUE_DEPTH_WARN_THRESHOLD).to.equal(100);
      expect(queueMonitoring.QUEUE_DEPTH_CRITICAL_THRESHOLD).to.equal(1000);
    });
  });

  // ─── Test 4: Job Completion Tracking ───────────────────────────────────────

  describe('4. Job Processing Metrics', () => {
    it('should record job completion without error', () => {
      // Verify function doesn't throw
      expect(() => {
        queueMonitoring.recordJobCompletion('payment-processing', 1500, true);
      }).to.not.throw();
    });

    it('should record failed jobs', () => {
      expect(() => {
        queueMonitoring.recordJobCompletion('payment-processing', 500, false);
      }).to.not.throw();
    });

    it('should handle slow job detection', () => {
      expect(() => {
        queueMonitoring.recordJobCompletion('webhook-relay', 35000, true);  // > 30s warning
      }).to.not.throw();
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
      expect(health).to.have.keys([
        'healthy',
        'totalBacklog',
        'worstQueue',
        'worstDepth',
        'healthy_summary',
      ]);

      expect(health.healthy).to.be.a('boolean');
      expect(health.totalBacklog).to.be.a('number');
      expect(health.worstQueue).to.be.a('string');
      expect(health.worstDepth).to.be.a('number');
      expect(health.healthy_summary).to.be.a('string');
    });

    it('should provide fallback when monitoring fails', async () => {
      const health = await queueMonitoring.getQueueHealth({});

      // When no queues, should still return valid response
      expect(health.healthy).to.be.true;  // fail-open
      expect(health.totalBacklog).to.equal(0);
    });
  });

  // ─── Test 6: Prometheus Metrics Accessibility ──────────────────────────────

  describe('6. Prometheus Metrics Export', () => {
    it('should expose queue depth gauge', () => {
      expect(queueMonitoring.queueDepthGauge).to.exist;
    });

    it('should expose active jobs gauge', () => {
      expect(queueMonitoring.activeJobsGauge).to.exist;
    });

    it('should expose failed jobs counter', () => {
      expect(queueMonitoring.failedJobsCounter).to.exist;
    });

    it('should expose processing time histogram', () => {
      expect(queueMonitoring.processingTimeHistogram).to.exist;
    });

    it('should support register method for Prometheus integration', () => {
      expect(typeof queueMonitoring.registerMetrics).to.equal('function');
    });
  });

  // ─── Test 7: Real-World Scenarios ──────────────────────────────────────────

  describe('7. Real-World Scenarios', () => {
    it('should handle sudden spike in queue depth', async () => {
      const queues = {
        payments: createMockQueue('payments', 1500, 50, 100, 2),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      expect(health.healthy).to.be.false;  // 1500 > 1000 threshold
      expect(health.totalBacklog).to.equal(1500);
    });

    it('should recover when queue drains', async () => {
      // First: spike
      let queues = {
        payments: createMockQueue('payments', 2000, 50, 100, 0),
      };
      let health = await queueMonitoring.getQueueHealth(queues);
      expect(health.healthy).to.be.false;

      // Then: drained
      queues = {
        payments: createMockQueue('payments', 50, 5, 2, 0),
      };
      health = await queueMonitoring.getQueueHealth(queues);
      expect(health.healthy).to.be.true;
    });

    it('should handle multi-queue backlog aggregation', async () => {
      const queues = {
        payments: createMockQueue('payments', 600, 10, 5, 0),
        webhooks: createMockQueue('webhooks', 500, 8, 3, 0),
      };

      const health = await queueMonitoring.getQueueHealth(queues);

      // Both queues are under critical individually
      // But combined = 1100, which exceeds 1000
      expect(health.healthy).to.be.false;
      expect(health.totalBacklog).to.equal(1100);
    });
  });

  // ─── Test 8: Edge Cases ───────────────────────────────────────────────────

  describe('8. Edge Cases', () => {
    it('should handle empty queue object', async () => {
      const health = await queueMonitoring.getQueueHealth({});
      expect(health.healthy).to.be.true;
      expect(health.totalBacklog).to.equal(0);
    });

    it('should handle queue with missing count methods', async () => {
      const queue = {
        name: 'broken',
        // missing getWaitingCount, etc.
      };

      const stats = await queueMonitoring.getQueueStats(queue);
      expect(stats).to.exist;  // Should not crash
    });

    it('should safely fail if queue throws error', async () => {
      const queue = {
        name: 'error-queue',
        getWaitingCount: () => Promise.reject(new Error('Redis down')),
      };

      const stats = await queueMonitoring.getQueueStats(queue);
      expect(stats).to.be.null;  // Should return null on error
    });
  });
});
