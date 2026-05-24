/*
Stage 3-5 automated auditor.
- Reads `reports/audit-master.json` (Stage 0-2)
- Performs failure-mode heuristics (Stage 3)
- Runs `scripts/routeAudit.js` to gather negative/attack findings (Stage 4)
- Consolidates risk scoring and final verdict (Stage 5 + Final)
- Writes `reports/audit-master-full.json`
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORT_IN = path.resolve(__dirname, '../reports/audit-master.json');
const REPORT_OUT = path.resolve(__dirname, '../reports/audit-master-full.json');

function loadMaster() {
  if (!fs.existsSync(REPORT_IN)) throw new Error('base report not found: ' + REPORT_IN);
  return JSON.parse(fs.readFileSync(REPORT_IN, 'utf8'));
}

function failureModeAnalysis(master) {
  const findings = [];
  const routes = master.stage0.routes;
  const stage1 = master.stage1;

  for (const rIdx in routes) {
    const r = routes[rIdx];
    const s1 = stage1.find(x => x.route.path === r.path && x.route.method === r.method) || { checks: {} };
    const method = r.method;
    const pathStr = r.path;

    // Mutation but no idempotency -> partial write risk
    if (['POST','PUT','DELETE','PATCH'].includes(method)) {
      const idempotencyMissing = !s1.checks || ((s1.checks.idempotency && s1.checks.idempotency.status === 'MISSING'));
      if (idempotencyMissing) {
        findings.push({ route: r, failure: 'DB/partial-write on dependency failure', severity: 'HIGH', reason: 'mutation without idempotency guard', evidence: s1.checks ? s1.checks.idempotency : null });
      }
    }

    // Webhook with no rate-limit -> replay / flood risk
    if (pathStr.includes('/payment/webhook')) {
      const rateMissing = !s1.checks || ((s1.checks.rateLimit && s1.checks.rateLimit.status === 'MISSING'));
      if (rateMissing) {
        findings.push({ route: r, failure: 'Webhook replay/flood risk', severity: 'MEDIUM', reason: 'webhook endpoint missing rate limiting', evidence: s1.checks ? s1.checks.rateLimit : null });
      }
    }

    // Internal routes unguarded -> critical
    if (pathStr.startsWith('/internal')) {
      // check whether internal guard present globally will be checked separately
      // individual internal endpoints without auth considered HIGH by default
      const authMissing = !s1.checks || ((s1.checks.auth && s1.checks.auth.status === 'MISSING'));
      if (authMissing) {
        findings.push({ route: r, failure: 'Internal endpoint accessible without guard', severity: 'CRITICAL', reason: 'internal route lacks auth/internal guard', evidence: s1.checks ? s1.checks.auth : null });
      }
    }
  }

  // also check global config systems heuristics
  if (master.stage0.configSystems.redis === false) {
    findings.push({ failure: 'Redis presence unknown', severity: 'MEDIUM', reason: 'Rate-limiter backing store not detected; may degrade under load' });
  }

  return findings;
}

function runNegativeAudit() {
  // Run existing routeAudit.js and capture stdout/stderr
  const cmd = process.execPath; // node
  const script = path.resolve(__dirname, 'routeAudit.js');
  const res = spawnSync(cmd, [script], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status,
  };
}

function consolidateRisk(master, failureFindings, negRun) {
  const critical = [];
  const medium = [];
  const low = [];

  // From failure findings
  for (const f of failureFindings) {
    const summary = {
      route: f.route ? { method: f.route.method, path: f.route.path } : undefined,
      issue: f.failure,
      reason: f.reason,
      severity: f.severity,
    };
    if (f.severity === 'CRITICAL') critical.push(summary);
    else if (f.severity === 'HIGH' || f.severity === 'MEDIUM') medium.push(summary);
    else low.push(summary);
  }

  // From negative audit stdout parse some indicators
  const raw = (negRun.stdout || '') + '\n' + (negRun.stderr || '');
  // simple heuristics: look for 'auth middleware did not short-circuit' or 'did not short-circuit on missing token'
  if (/did not short-circuit/.test(raw) || /auth middleware did not short-circuit/.test(raw)) {
    critical.push({ issue: 'Auth middleware failed negative test', reason: 'auth did not block missing token in at least one route' });
  }
  if (/idempotency.strict did not short-circuit/.test(raw)) {
    medium.push({ issue: 'Idempotency guard failed negative test', reason: 'idempotency.strict did not enforce presence of Idempotency-Key' });
  }

  // Compute coverage and uncertainty metrics
  const totalRoutes = master.stage1.length;
  const totalChecks = totalRoutes * 5; // auth, rbac, rateLimit, idempotency, validation
  let knownChecks = 0;
  let missingAuthCount = 0;
  for (const s of master.stage1) {
    for (const k of ['auth','rbac','rateLimit','idempotency','validation']) {
      const c = s.checks[k];
      if (c && c.status) knownChecks += 1;
      if (k === 'auth' && c && c.status === 'MISSING') missingAuthCount += 1;
    }
  }
  const coverageScore = Math.round((knownChecks / totalChecks) * 100);

  const unknownStage1 = totalChecks - knownChecks;
  const unknownStage2 = master.stage2.filter(x => x.checks.execution_order_valid === 'UNKNOWN').length;
  const unknownPct = Math.round(((unknownStage1 + unknownStage2) / (totalChecks + totalRoutes)) * 100);

  // Security confidence: heuristic combining known coverage and findings
  let securityConfidence = 10;
  securityConfidence -= Math.min(5, Math.round(unknownPct / 10));
  securityConfidence -= Math.min(5, critical.length);
  securityConfidence = Math.max(0, Math.min(10, securityConfidence));

  // Runtime certainty: percent of routes with execution order validated (YES or NO)
  const execValidated = master.stage2.filter(x => x.checks.execution_order_valid === 'YES' || x.checks.execution_order_valid === 'NO').length;
  const runtimeCertainty = Math.round((execValidated / totalRoutes) * 100);

  // Final verdict follows hard constraints: if unknownPct > 30% -> UNKNOWN; else NO if criticals exist
  let finalVerdict = 'NO';
  if (unknownPct > 30) finalVerdict = 'UNKNOWN';
  else if (critical.length > 0) finalVerdict = 'NO';
  else finalVerdict = 'YES';

  return { critical, medium, low, finalVerdict, securityConfidence, coverageScore, runtimeCertainty, unknownPct, missingAuthCount };
}

(async function main() {
  try {
    const master = loadMaster();
    const failureFindings = failureModeAnalysis(master);
    const negRun = runNegativeAudit();

    const consolidation = consolidateRisk(master, failureFindings, negRun);

    const out = {
      generatedAt: new Date().toISOString(),
      baseReport: master,
      failureFindings,
      negativeAudit: { status: negRun.status, stdout: negRun.stdout.split('\n').slice(0,500).join('\n'), stderr: negRun.stderr.split('\n').slice(0,200).join('\n') },
      consolidated: consolidation,
    };

    fs.writeFileSync(REPORT_OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log('Audit master full report written to', REPORT_OUT);

    // Exit codes: 0 if finalVerdict YES, 1 if NO, 3 if UNKNOWN
    if (consolidation.finalVerdict === 'YES') process.exit(0);
    if (consolidation.finalVerdict === 'NO') process.exit(1);
    process.exit(3);
  } catch (err) {
    console.error('auditMasterFull failed:', err);
    process.exit(4);
  }
})();
