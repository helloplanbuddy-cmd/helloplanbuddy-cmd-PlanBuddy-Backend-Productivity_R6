'use strict';

const fs = require('fs');
const path = require('path');
const routes = require('../routes');
const internalRoutes = require('../routes/internal');
const { authenticate, requireRole } = require('../middleware');
const idempotency = require('../middleware/idempotency');
const internalIpGuard = require('../middleware/internalIpGuard');

const AUDIT_TARGETS = [
  {
    name: 'API routes',
    router: routes,
    basePath: '',
  },
  {
    name: 'Internal routes',
    router: internalRoutes,
    basePath: '/internal',
  },
];

function normalizeMiddlewareName(name) {
  return (name || 'anonymous').toLowerCase();
}

function extractRoutes(router, basePath = '') {
  if (!router || !router.stack) return [];

  return router.stack.flatMap((layer) => {
    if (layer.route) {
      const route = layer.route;
      const methods = Object.keys(route.methods).filter((method) => route.methods[method]);
      const path = `${basePath}${route.path}`;
      const stack = route.stack.map((mw) => ({
        name: mw.name || 'anonymous',
        handle: mw.handle,
      }));

      return methods.map((method) => ({ method: method.toUpperCase(), path, stack }));
    }

    if (layer.handle && layer.handle.stack) {
      return extractRoutes(layer.handle, basePath);
    }

    return [];
  });
}

function getHandlerIndex(route) {
  return route.stack.length - 1;
}

function findFirstMiddleware(route, matcher) {
  return route.stack.findIndex((layer) => matcher(normalizeMiddlewareName(layer.name)));
}

function routeExpectations(route) {
  const path = route.path;
  const hasAdminPath = path.includes('/admin');
  const requiresAuth = /^(\/admin|\/bookings|\/payment\/create-order|\/payment\/verify|\/payment\/status)/.test(path);
  const isWebhook = path.includes('/payment/webhook/razorpay');
  const hasIdempotencyStrict = route.stack.some((layer) => normalizeMiddlewareName(layer.name).includes('idempotencystrict'));

  return {
    requiresAuth,
    requiresRole: hasAdminPath,
    requiresIdempotencyStrict: hasIdempotencyStrict,
    isWebhook,
  };
}

function evaluateRoute(route) {
  const expectations = routeExpectations(route);
  const result = {
    route,
    status: 'VERIFIED',
    issues: [],
    checks: [],
  };
  const handlerIndex = getHandlerIndex(route);
  const authIndex = findFirstMiddleware(route, (name) => name.includes('authenticate'));
  const roleIndex = findFirstMiddleware(route, (name) => name.includes('requirerole'));
  const webhookIndex = findFirstMiddleware(route, (name) => name.includes('webhook'));

  if (expectations.requiresAuth) {
    result.checks.push('auth required');
    if (authIndex === -1) {
      result.status = 'ISSUE';
      result.issues.push('authentication middleware missing');
    } else if (authIndex > handlerIndex) {
      result.status = 'ISSUE';
      result.issues.push('authentication middleware appears after handler');
    }
  }

  if (expectations.requiresRole) {
    result.checks.push('admin role required');
    if (roleIndex === -1) {
      result.status = 'ISSUE';
      result.issues.push('admin role middleware missing');
    } else if (roleIndex > handlerIndex) {
      result.status = 'ISSUE';
      result.issues.push('admin role middleware appears after handler');
    }
  }

  if (expectations.isWebhook) {
    result.checks.push('webhook endpoint');
    if (authIndex !== -1) {
      result.status = 'ISSUE';
      result.issues.push('webhook route should not require authentication');
    }
    if (webhookIndex === -1) {
      result.status = 'ISSUE';
      result.issues.push('webhook limiter middleware missing');
    } else if (webhookIndex > handlerIndex) {
      result.status = 'ISSUE';
      result.issues.push('webhook limiter appears after handler');
    }
  }

  if (expectations.requiresIdempotencyStrict) {
    result.checks.push('idempotency.strict required');
    const idempotencyIndex = findFirstMiddleware(route, (name) => name.includes('idempotencystrict'));
    if (idempotencyIndex === -1) {
      result.status = 'ISSUE';
      result.issues.push('idempotency.strict middleware missing');
    } else if (idempotencyIndex > handlerIndex) {
      result.status = 'ISSUE';
      result.issues.push('idempotency.strict appears after handler');
    }
  }

  if (result.status === 'VERIFIED' && result.checks.length === 0) {
    result.status = 'NOT_CHECKED';
    result.issues.push('no enforcement expectations for this route in the current audit model');
  }

  return result;
}

function buildRequestStub({ path = '/', method = 'GET', ip = '203.0.113.5', headers = {} } = {}) {
  return {
    method,
    path,
    originalUrl: path,
    ip,
    headers,
    socket: { remoteAddress: ip },
    requestId: 'route-audit',
    user: null,
  };
}

function buildResponseStub() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    jsonCalled: false,
    endCalled: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.jsonCalled = true;
      return this;
    },
    end(payload) {
      this.body = payload;
      this.endCalled = true;
      return this;
    },
  };
  return res;
}

async function runNegativeChecks(route) {
  const findings = [];
  const expectations = routeExpectations(route);

  if (expectations.requiresAuth && findFirstMiddleware(route, (name) => name.includes('authenticate')) !== -1) {
    const req = buildRequestStub({ path: route.path, method: route.method, headers: {} });
    const res = buildResponseStub();
    let nextCalled = false;
    try {
      await authenticate(req, res, () => { nextCalled = true; });
      if (nextCalled) {
        findings.push('auth middleware did not short-circuit on missing token');
      } else if (res.statusCode !== 401) {
        findings.push(`auth middleware returned ${res.statusCode} instead of 401 when token absent`);
      }
    } catch (err) {
      findings.push(`auth middleware threw error during negative test: ${err.message}`);
    }
  }

  if (expectations.requiresRole && findFirstMiddleware(route, (name) => name.includes('requirerole')) !== -1) {
    const req = buildRequestStub({ path: route.path, method: route.method, headers: {} });
    req.user = { id: 'user-1', role: 'user' };
    const res = buildResponseStub();
    let nextCalled = false;
    const middleware = requireRole('admin');
    try {
      middleware(req, res, () => { nextCalled = true; });
      if (nextCalled) {
        findings.push('requireRole did not short-circuit for unauthorized role');
      } else if (res.statusCode !== 403) {
        findings.push(`requireRole returned ${res.statusCode} instead of 403 for unauthorized role`);
      }
    } catch (err) {
      findings.push(`requireRole threw error during negative test: ${err.message}`);
    }
  }

  if (expectations.requiresIdempotencyStrict && findFirstMiddleware(route, (name) => name.includes('idempotencystrict')) !== -1) {
    const req = buildRequestStub({ path: route.path, method: route.method, headers: {} });
    const res = buildResponseStub();
    let nextCalled = false;
    try {
      idempotency.strict(req, res, () => { nextCalled = true; });
      if (nextCalled) {
        findings.push('idempotency.strict did not short-circuit when Idempotency-Key is missing');
      } else if (res.statusCode !== 400) {
        findings.push(`idempotency.strict returned ${res.statusCode} instead of 400 when key is absent`);
      }
    } catch (err) {
      findings.push(`idempotency.strict threw error during negative test: ${err.message}`);
    }
  }

  return findings;
}

function verifyInternalMount() {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const internalMountPattern = /app\.use\(\s*['"]\/internal['"]\s*,\s*internalIpGuard\s*,\s*internalRoutes\s*\)/;
  if (!internalMountPattern.test(appSource)) {
    return [{
      type: 'MOUNT_CHECK',
      issue: 'internal route guard mount not found in app.js',
      detail: "Expected app.use('/internal', internalIpGuard, internalRoutes) with the guard before internal routes",
    }];
  }
  return [];
}

function formatResult(result) {
  return {
    method: result.route.method,
    path: result.route.path,
    status: result.status,
    checks: result.checks,
    issues: result.issues,
  };
}

function printAuditSummary(results, internalMountFindings, negativeFindings) {
  console.log('\n=== Route Enforcement Audit Summary ===');
  for (const result of results) {
    const item = formatResult(result);
    const line = `${item.method.padEnd(6)} ${item.path.padEnd(45)} ${item.status}`;
    console.log(line);
    if (item.issues.length > 0) {
      for (const issue of item.issues) {
        console.log(`    - ${issue}`);
      }
    }
  }

  if (internalMountFindings.length > 0) {
    console.log('\n=== Internal mount findings ===');
    for (const finding of internalMountFindings) {
      console.log(`- [${finding.type}] ${finding.issue}`);
    }
  }

  if (negativeFindings.length > 0) {
    console.log('\n=== Negative execution checks ===');
    for (const finding of negativeFindings) {
      console.log(`- [${finding.route.method}] ${finding.route.path} => ${finding.issue}`);
    }
  }
}

(async () => {
  const results = [];
  const negativeFindings = [];

  for (const target of AUDIT_TARGETS) {
    const routeDefs = extractRoutes(target.router, target.basePath);
    routeDefs.forEach((routeDef) => {
      const evaluation = evaluateRoute(routeDef);
      results.push(evaluation);
    });
  }

  const internalMountFindings = verifyInternalMount();

  for (const result of results) {
    const routeNegatives = await runNegativeChecks(result.route);
    routeNegatives.forEach((issue) => {
      negativeFindings.push({ route: result.route, issue });
    });
  }

  printAuditSummary(results, internalMountFindings, negativeFindings);

  const hasIssues = results.some((result) => result.status === 'ISSUE') || internalMountFindings.length > 0 || negativeFindings.length > 0;
  const hasUnchecked = results.some((result) => result.status === 'NOT_CHECKED');

  console.log(`\nAudit completion status: ${hasIssues ? 'ISSUES_FOUND' : 'PASS'}${hasUnchecked ? ' (some routes not checked)' : ''}`);

  if (hasIssues) {
    process.exit(1);
  }

  process.exit(0);
})();
