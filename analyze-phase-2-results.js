#!/usr/bin/env node

/**
 * PHASE -2 FORENSIC ANALYSIS ENGINE
 * 
 * Processes k6 JSON output and extracts evidence-based metrics.
 * Produces actionable forensic report.
 */

const fs = require('fs');
const path = require('path');

class ForensicAnalyzer {
  constructor(resultsDir = './phase-2-results') {
    this.resultsDir = resultsDir;
    this.results = {};
  }

  /**
   * Load all baseline test results
   */
  loadBaselineResults() {
    console.log('\n🔍 Loading baseline results...\n');

    const pattern = /baseline-(\d+)-users\.json/;
    const files = fs.readdirSync(this.resultsDir)
      .filter(f => pattern.test(f))
      .sort((a, b) => {
        const aNum = parseInt(a.match(/(\d+)/)[1]);
        const bNum = parseInt(b.match(/(\d+)/)[1]);
        return aNum - bNum;
      });

    files.forEach(file => {
      const filePath = path.join(this.resultsDir, file);
      const match = file.match(/baseline-(\d+)-users/);
      const vuCount = parseInt(match[1]);

      try {
        const data = fs.readFileSync(filePath, 'utf8')
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            try {
              return JSON.parse(line);
            } catch (e) {
              return null;
            }
          })
          .filter(obj => obj !== null);

        const metrics = this.extractMetrics(data);
        this.results[vuCount] = metrics;

        console.log(`✓ Loaded: ${file}`);
      } catch (error) {
        console.error(`✗ Error loading ${file}: ${error.message}`);
      }
    });

    return this.results;
  }

  /**
   * Extract key metrics from raw k6 data
   */
  extractMetrics(data) {
    // Filter HTTP request duration points
    const durations = data
      .filter(point => point.type === 'Point' && point.metric === 'http_req_duration')
      .map(point => point.value)
      .sort((a, b) => a - b);

    if (durations.length === 0) {
      return null;
    }

    const p50 = this.percentile(durations, 0.50);
    const p95 = this.percentile(durations, 0.95);
    const p99 = this.percentile(durations, 0.99);

    // Extract summary stats
    const summary = data.find(obj => obj.type === 'Summary' && obj.data?.summaries);
    
    const metrics = {
      duration: durations,
      p50: Math.round(p50),
      p95: Math.round(p95),
      p99: Math.round(p99),
      min: Math.round(Math.min(...durations)),
      max: Math.round(Math.max(...durations)),
      avg: Math.round(durations.reduce((a, b) => a + b) / durations.length),
      count: durations.length,
    };

    // Add throughput if available
    if (summary?.data?.summaries?.['http_reqs']) {
      const httpReqs = summary.data.summaries['http_reqs'];
      metrics.throughput = Math.round(httpReqs.value / 60); // req/sec (assuming 60s test)
      metrics.totalRequests = httpReqs.value;
    }

    // Add error rate if available
    if (summary?.data?.summaries?.['http_req_failed']) {
      const failed = summary.data.summaries['http_req_failed'];
      metrics.errorRate = (failed.value * 100).toFixed(2); // percentage
    }

    return metrics;
  }

  /**
   * Calculate percentile from sorted array
   */
  percentile(arr, p) {
    if (arr.length === 0) return 0;
    const index = Math.ceil(arr.length * p) - 1;
    return arr[index] || arr[arr.length - 1];
  }

  /**
   * Generate latency analysis table
   */
  generateLatencyTable() {
    console.log('\n' + '='.repeat(100));
    console.log('BASELINE LATENCY ANALYSIS (p50/p95/p99)');
    console.log('='.repeat(100));

    console.log('\nUsers  │   p50 (ms)   │   p95 (ms)   │   p99 (ms)   │  Min (ms)  │  Max (ms)  │  Avg (ms)');
    console.log('───────┼──────────────┼──────────────┼──────────────┼────────────┼────────────┼────────────');

    Object.keys(this.results)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .forEach(vu => {
        const m = this.results[vu];
        if (m) {
          console.log(
            `${vu.padStart(6, ' ')} │ ${String(m.p50).padStart(12, ' ')} │ ${String(m.p95).padStart(12, ' ')} │ ${String(m.p99).padStart(12, ' ')} │ ${String(m.min).padStart(10, ' ')} │ ${String(m.max).padStart(10, ' ')} │ ${String(m.avg).padStart(10, ' ')}`
          );
        }
      });

    console.log('───────┴──────────────┴──────────────┴──────────────┴────────────┴────────────┴────────────');
  }

  /**
   * Identify saturation point (where p95 exceeds threshold)
   */
  identifySaturation(p95Threshold = 500) {
    console.log('\n' + '='.repeat(100));
    console.log(`SATURATION ANALYSIS (p95 > ${p95Threshold}ms threshold)`);
    console.log('='.repeat(100) + '\n');

    let saturationFound = false;
    const vus = Object.keys(this.results)
      .map(v => parseInt(v))
      .sort((a, b) => a - b);

    vus.forEach(vu => {
      const m = this.results[vu];
      if (m) {
        const status = m.p95 > p95Threshold ? '⚠️  SATURATED' : '✓ OK';
        console.log(`  ${vu} users: p95=${m.p95}ms ${status}`);
        
        if (m.p95 > p95Threshold && !saturationFound) {
          saturationFound = true;
          console.log(`\n  → SATURATION BEGINS AROUND ${vu} users (p95 > ${p95Threshold}ms)`);
        }
      }
    });

    return saturationFound;
  }

  /**
   * Identify collapse point (where errors spike or p95 explodes)
   */
  identifyCollapse(errorThreshold = 5, p95Threshold = 2000) {
    console.log('\n' + '='.repeat(100));
    console.log(`COLLAPSE ANALYSIS (errors > ${errorThreshold}% OR p95 > ${p95Threshold}ms)`);
    console.log('='.repeat(100) + '\n');

    const vus = Object.keys(this.results)
      .map(v => parseInt(v))
      .sort((a, b) => a - b);

    let collapseVU = null;

    vus.forEach(vu => {
      const m = this.results[vu];
      if (m) {
        const errorRate = parseFloat(m.errorRate || 0);
        const isCollapsed = errorRate > errorThreshold || m.p95 > p95Threshold;
        const status = isCollapsed ? '💥 COLLAPSE' : '✓ OK';
        
        console.log(`  ${vu} users: ${errorRate}% errors, p95=${m.p95}ms ${status}`);
        
        if (isCollapsed && !collapseVU) {
          collapseVU = vu;
          console.log(`\n  → COLLAPSE BEGINS AROUND ${vu} users`);
          console.log(`     Error rate: ${errorRate}%`);
          console.log(`     p95 latency: ${m.p95}ms`);
        }
      }
    });

    return collapseVU;
  }

  /**
   * Recommend safe capacity (30% headroom from saturation)
   */
  recommendCapacity() {
    console.log('\n' + '='.repeat(100));
    console.log('CAPACITY RECOMMENDATION');
    console.log('='.repeat(100) + '\n');

    const vus = Object.keys(this.results)
      .map(v => parseInt(v))
      .sort((a, b) => a - b);

    let saturationVU = null;
    vus.forEach(vu => {
      const m = this.results[vu];
      if (m && m.p95 > 500 && !saturationVU) {
        saturationVU = vu;
      }
    });

    if (!saturationVU) {
      console.log('  ⚠️  Could not determine saturation point from available tests');
      console.log('     Run additional tests at higher user counts\n');
      return;
    }

    const safeCapacity = Math.floor(saturationVU * 0.7); // 30% headroom
    const saturationMetrics = this.results[saturationVU];

    console.log(`  Saturation point: ${saturationVU} users (p95 = ${saturationMetrics.p95}ms)`);
    console.log(`  Safe capacity (30% headroom): ${safeCapacity} users`);
    console.log(`  Estimated throughput: ${saturationMetrics.throughput || '?'} req/sec`);
    console.log(`\n  ✓ PRODUCTION DEPLOYMENT RECOMMENDED AT: <= ${safeCapacity} concurrent users\n`);
  }

  /**
   * Generate forensic verdict
   */
  generateVerdict() {
    console.log('='.repeat(100));
    console.log('FORENSIC VERDICT');
    console.log('='.repeat(100) + '\n');

    const highestVU = Math.max(...Object.keys(this.results).map(v => parseInt(v)));
    const highestMetrics = this.results[highestVU];

    let score = 0;
    let issues = [];

    // Check latency
    if (highestMetrics.p95 < 500) {
      console.log('✓ Latency: EXCELLENT (p95 < 500ms at peak load)');
      score += 25;
    } else if (highestMetrics.p95 < 1000) {
      console.log('⚠️  Latency: ACCEPTABLE (p95 < 1000ms at peak load)');
      score += 15;
    } else {
      console.log('✗ Latency: POOR (p95 > 1000ms at peak load)');
      issues.push('High latency at peak load');
      score += 5;
    }

    // Check error rate
    const errorRate = parseFloat(highestMetrics.errorRate || 0);
    if (errorRate < 1) {
      console.log('✓ Stability: EXCELLENT (< 1% error rate at peak)');
      score += 25;
    } else if (errorRate < 5) {
      console.log('⚠️  Stability: ACCEPTABLE (< 5% error rate at peak)');
      score += 15;
      issues.push(`Elevated error rate: ${errorRate}%`);
    } else {
      console.log('✗ Stability: POOR (> 5% error rate at peak)');
      score += 5;
      issues.push(`High error rate: ${errorRate}%`);
    }

    // Check capacity
    if (highestVU >= 500) {
      console.log('✓ Capacity: GOOD (tested to 500+ concurrent users)');
      score += 25;
    } else if (highestVU >= 250) {
      console.log('⚠️  Capacity: MODERATE (tested to 250-500 users)');
      score += 15;
      issues.push('Limited capacity testing');
    } else {
      console.log('⚠️  Capacity: UNKNOWN (tested below 250 users)');
      score += 10;
      issues.push('Insufficient load testing');
    }

    // Check consistency
    const allGood = Object.keys(this.results)
      .map(v => parseInt(v))
      .every(vu => this.results[vu].errorRate <= 1);

    if (allGood) {
      console.log('✓ Consistency: EXCELLENT (stable across all load levels)');
      score += 25;
    } else {
      console.log('⚠️  Consistency: ISSUES (errors at some load levels)');
      score += 10;
      issues.push('Inconsistent stability');
    }

    console.log(`\n  FORENSIC SCORE: ${score}/100`);

    if (issues.length > 0) {
      console.log('\n  Outstanding Issues:');
      issues.forEach((issue, idx) => {
        console.log(`    ${idx + 1}. ${issue}`);
      });
    }

    console.log(`\n  PRODUCTION READINESS: ${score >= 75 ? '✅ READY' : '⚠️  NEEDS WORK'}\n`);

    return score;
  }

  /**
   * Run full analysis
   */
  runFullAnalysis() {
    console.log('\n╔════════════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                    PHASE -2 FORENSIC ANALYSIS ENGINE                                          ║');
    console.log('║                  Evidence-Based Runtime Performance Report                                    ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════════════════════════╝');

    this.loadBaselineResults();

    if (Object.keys(this.results).length === 0) {
      console.error('\n✗ No baseline results found. Run baseline tests first.\n');
      return;
    }

    this.generateLatencyTable();
    this.identifySaturation();
    this.identifyCollapse();
    this.recommendCapacity();
    const score = this.generateVerdict();

    console.log('╔════════════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                            END OF FORENSIC ANALYSIS REPORT                                     ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════════════════════════╝\n');

    return score;
  }
}

// Main execution
if (require.main === module) {
  const resultsDir = process.argv[2] || './phase-2-results';
  
  const analyzer = new ForensicAnalyzer(resultsDir);
  analyzer.runFullAnalysis();
}

module.exports = ForensicAnalyzer;
