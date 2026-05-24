/*
 Stage-wise automated auditor (Stage 0-2) for the codebase.
 - Stage 0: Inventory (routes, middleware, controllers, dependencies, config)
 - Stage 1: Enforcement coverage per route (auth/rbac/rate-limit/idempotency/validation presence)
 - Stage 2: Execution order validation

 Output: writes `reports/audit-master.json` with structured results.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const routes = require('../routes');
const internalRoutes = require('../routes/internal');
const middleware = require('../middleware');

const OUT_DIR = path.resolve(__dirname, '../reports');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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
      const stack = route.stack.map((mw) => ({ name: mw.name || 'anonymous' }));
      return methods.map((method) => ({ method: method.toUpperCase(), path, stack }));
    }

    if (layer.handle && layer.handle.stack) {
      return extractRoutes(layer.handle, basePath);
    }

    return [];
  });
}

function listMiddlewareExports(mwModule) {
  if (!mwModule) return [];
  return Object.keys(mwModule)
    .filter((k) => typeof mwModule[k] === 'function')
    .map((k) => k);
}

function collectDependencies() {
  const pkg = require('../package.json');
  return {
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
  };
}

function collectConfigSystems() {
  // best-effort: look for env usage and presence of redis/pg configs
  const cfg = {
    db: false,
    redis: false,
    auth: false,
    queues: false,
  };
  try {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
    cfg.db = /pg|postgres|sequelize/.test(appJs) || /process\.env\.(PG|DATABASE|DB_)/i.test(appJs);
    cfg.redis = /redis|ioredis/.test(appJs) || /process\.env\.(REDIS|REDIS_URL)/i.test(appJs);
    cfg.auth = /jsonwebtoken|jwt|authenticate|passport/.test(appJs) || /process\.env\.(JWT|SECRET)/i.test(appJs);
    cfg.queues = /bull|bullmq|queue/.test(appJs);
  } catch (e) {
    // ignore
  }
  return cfg;
}

function stage0Inventory() {
  // parse app.js mounts to compute middleware inheritance and canonical mount paths
  const appSource = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const mounts = parseAppMounts(appSource);

  // extract router routes (unmounted) and then attach mount prefixes where applicable
  const apiRoutes = extractRoutes(routes, '');
  const intRoutes = extractRoutes(internalRoutes, '');

  const allRoutes = apiRoutes.concat(intRoutes).map((r) => {
    // compute inherited middleware from mounts where mount.path matches route path
    const inherited = [];
    const mountHits = [];
    for (const m of mounts) {
      if (!m.path || m.path === '') {
        // global mount applies to all
        inherited.push(...m.middlewareNames);
        mountHits.push({ path: m.path, middleware: m.middlewareNames });
        continue;
      }
      // ensure route path starts with mount.path (consider trailing slashes)
      const routePath = r.path || '';
      if (routePath === m.path || routePath.startsWith(m.path + '/') || routePath.startsWith(m.path)) {
        inherited.push(...m.middlewareNames);
        mountHits.push({ path: m.path, middleware: m.middlewareNames });
      }
    }

    return Object.assign({}, r, { inheritedMiddleware: inherited, mountHits });
  });

  const middlewareList = listMiddlewareExports(middleware);
  const dependencies = collectDependencies();
  const configSystems = collectConfigSystems();

  return { routes: allRoutes, mounts, middleware: middlewareList, dependencies, configSystems };
}

function parseAppMounts(appSource) {
  // Very small parser to extract app.use/app.get mounts and middleware names in order
  const mounts = [];
  const re = /app\.(use|get|post|patch|put|delete)\s*\(([^;]+?)\);/gs;
  let m;
  while ((m = re.exec(appSource)) !== null) {
    const full = m[2].trim();
    // capture top-level comma-separated args (naive, but sufficient for common patterns)
    const args = splitTopLevelArgs(full);
    if (args.length === 0) continue;
    let first = args[0].trim();
    let path = '';
    let middlewareArgs = [];
    if (/^['\"]/.test(first)) {
      // string path
      path = first.replace(/^['\"]|['\"]$/g, '');
      middlewareArgs = args.slice(1);
    } else {
      middlewareArgs = args;
    }

    const middlewareNames = middlewareArgs.map((a) => {
      // strip function calls like apiVersion('v1') -> apiVersion
      const s = a.trim();
      const match = s.match(/^([a-zA-Z0-9_$.]+)/);
      if (!match) return s;
      const raw = match[1];
      const parts = raw.split('.');
      return parts[parts.length - 1];
    }).filter(Boolean);

    mounts.push({ path, middlewareNames, raw: full });
  }
  return mounts;
}

function splitTopLevelArgs(s) {
  const res = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      res.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) res.push(cur);
  return res.map((r) => r.trim()).filter(Boolean);
}

function routeExpectations(route) {
  const path = route.path;
  const hasAdminPath = path.includes('/admin');
  const requiresAuth = /^(\/admin|\/bookings|\/payment\/create-order|\/payment\/verify|\/payment\/status)/.test(path);
  const isWebhook = path.includes('/payment/webhook/razorpay');

  return {
    requiresAuth,
    requiresRole: hasAdminPath,
    isWebhook,
  };
}

function stage1Enforcement(inventory) {
  const results = inventory.routes.map((route) => {
    const checks = {};
    const routeStack = (route.stack || []).map((s) => normalizeMiddlewareName(s.name));
    const inherited = (route.inheritedMiddleware || []).map((n) => normalizeMiddlewareName(n));
    const combined = [...inherited, ...routeStack];

    // helper to detect presence and provenance
    function detect(term) {
      const inRoute = routeStack.some((n) => n.includes(term));
      const inMount = inherited.some((n) => n.includes(term));
      return { present: inRoute || inMount, inRoute, inMount };
    }

    const authDet = detect('authenticate') || detect('auth');
    const rbacDet = detect('requirerole') || detect('require_role') || detect('role');
    const rateDet = detect('rate') || detect('limiter');
    const idemDet = detect('idempotency');
    const valDet = detect('validate') || detect('zod') || detect('schema');

    checks.auth = { status: authDet.present ? 'PRESENT' : 'MISSING', evidence: authDet.present ? (authDet.inRoute ? 'route' : 'mount') : null };
    checks.rbac = { status: rbacDet.present ? 'PRESENT' : 'MISSING', evidence: rbacDet.present ? (rbacDet.inRoute ? 'route' : 'mount') : null };
    checks.rateLimit = { status: rateDet.present ? 'PRESENT' : 'MISSING', evidence: rateDet.present ? (rateDet.inRoute ? 'route' : 'mount') : null };
    checks.idempotency = { status: idemDet.present ? 'PRESENT' : 'MISSING', evidence: idemDet.present ? (idemDet.inRoute ? 'route' : 'mount') : null };
    checks.validation = { status: valDet.present ? 'PRESENT' : 'MISSING', evidence: valDet.present ? (valDet.inRoute ? 'route' : 'mount') : null };

    // attach proof binding
    const proof = {
      routeStack: routeStack,
      inherited: inherited,
      mounts: route.mountHits || [],
    };

    return { route: { method: route.method, path: route.path }, checks, proof };
  });

  return results;
}

function stage2ExecutionOrder(inventory) {
  // Validate that auth appears before handler (handler is last stack item)
  const results = inventory.routes.map((route) => {
    const routeStack = (route.stack || []).map((s) => normalizeMiddlewareName(s.name));
    const inherited = (route.inheritedMiddleware || []).map((n) => normalizeMiddlewareName(n));
    const combined = [...inherited, ...routeStack];
    const handlerIndex = combined.length - 1;
    const authIndex = combined.findIndex((n) => n.includes('authenticate') || n.includes('auth'));
    const rbacIndex = combined.findIndex((n) => n.includes('requirerole') || n.includes('require_role') || n.includes('role'));
    const rateIndex = combined.findIndex((n) => n.includes('rate') || n.includes('limiter'));
    const idempotencyIndex = combined.findIndex((n) => n.includes('idempotency'));

    const checks = {
      execution_order_valid: 'UNKNOWN',
      issues: [],
      proof: { combinedStack: combined, handlerIndex },
    };

    if (authIndex === -1 || handlerIndex === -1) {
      checks.execution_order_valid = 'UNKNOWN';
      if (authIndex === -1) checks.issues.push('auth middleware missing — order unknown');
    } else {
      if (authIndex < handlerIndex) {
        checks.execution_order_valid = 'YES';
      } else {
        checks.execution_order_valid = 'NO';
        checks.issues.push('authentication appears after handler');
      }
    }

    if (rbacIndex !== -1 && authIndex !== -1) {
      if (rbacIndex > authIndex) {
        if (rbacIndex < handlerIndex) {
          // ok
        } else {
          checks.issues.push('rbac appears after handler');
        }
      } else {
        checks.issues.push('rbac appears before auth');
      }
    }

    if (rateIndex !== -1 && authIndex !== -1) {
      if (rateIndex <= authIndex) {
        // ok
      } else {
        checks.issues.push('rate limit appears after auth');
      }
    }

    if (idempotencyIndex !== -1) {
      if (idempotencyIndex < handlerIndex) {
        // ok
      } else {
        checks.issues.push('idempotency appears after handler');
      }
    }

    if (checks.execution_order_valid === 'YES' && checks.issues.length > 0) {
      checks.execution_order_valid = 'NO';
    }

    return { route: { method: route.method, path: route.path }, checks };
  });

  return results;
}

(async function main() {
  try {
    const inventory = stage0Inventory();
    const stage1 = stage1Enforcement(inventory);
    const stage2 = stage2ExecutionOrder(inventory);

    const report = {
      generatedAt: new Date().toISOString(),
      stage0: inventory,
      stage1,
      stage2,
    };

    const outPath = path.join(OUT_DIR, 'audit-master.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('Audit master report written to', outPath);

    // Exit code: 0 if no clear issues found in stage2, else 1 to indicate action needed
    const hasIssues = stage2.some((r) => r.checks.execution_order_valid === 'NO' || (r.checks.issues && r.checks.issues.length > 0));
    process.exit(hasIssues ? 1 : 0);
  } catch (err) {
    console.error('Audit runner failed:', err);
    process.exit(2);
  }
})();
