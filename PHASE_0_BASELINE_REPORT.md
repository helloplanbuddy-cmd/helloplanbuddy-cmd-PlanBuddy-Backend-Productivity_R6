# PHASE 0 — BASELINE + SAFETY SNAPSHOT
## PlanBuddy v9 Backend Production Hardening Program
### Generated: 2026-05-30
### Auditor: Principal Distributed Systems Engineer

---

## 1. EXECUTIVE SUMMARY

The PlanBuddy v9 backend has undergone significant prior hardening (Phases 1–4 partially complete). Many issues flagged in the May 12/25 audit reports are **already resolved** in the current codebase. However, **four critical operational-security issues remain** that block production certification.

**Current State**: Conditioned Beta-Ready (with blockers)  
**Overall Readiness**: 6.8/10

---

## 2. ARCHITECTURE MAP

### 2.1 Entrypoints

| Entrypoint | File | Purpose |
|-----------|------|---------|
| HTTP API | `planbuddy_v9/server.js` | Production HTTP server with graceful shutdown |
| Express App | `planbuddy_v9/app.js` | Middleware stack, routing, security headers |
| Workers (all-in-one) | `planbuddy_v9/workers/index.js` | BullMQ worker runner |
| Workers (individual) | `planbuddy_v9/workers/start-*.js` | Per-queue isolated workers |
| Maintenance | `planbuddy_v9/workers/sessionCleanup.worker.js` | Cron-driven cleanup |

### 2.2 Route Topology

```
/                           → health check JSON
/health                     → readiness probe (DB check)
/health/live                → liveness probe
/health/ready               → readiness + degraded states
/health/production          → cached integrity/DQL metrics
/metrics                    → Prometheus (IP-guarded)
/internal                   → internal observability (IP-guarded)
/api/v1/auth/*              → auth routes (rate-limited)
/api/v1/bookings            → booking CRUD
/api/v1/bookings/:id/cancel → cancellation + refund
/api/v1/payment/*           → payment lifecycle
/api/v1/payment/webhook/razorpay → Razorpay webhook (raw body)
/api/v1/admin/*             → admin operations (RBAC)
/api/v1/trips/:id/availability → public availability
```

### 2.3 Middleware Order (Verified Current)

```
1. trust proxy (app.set)
2. proxyValidation.middleware()     ← strips untrusted X-Forwarded-For
3. HTTPS redirect (production only)
4. Security headers (HSTS, CSP, etc.)
5. Request ID injection
6. Trace ID middleware               ← ACTIVE (was reported disabled)
7. CORS validation
8. CSRF protection (X-Requested-With)
9. Raw body parser (webhook path only)
10. express.json / urlencoded
11. globalLimiter (rateLimit.js v4.1) ← ACTIVE (was reported disabled)
12. backpressureMiddleware           ← ACTIVE (was reported disabled)
13. Request timing + Pino logging
14. /api/v1 router dispatch
15. /internal router (IP-guarded)
16. 404 handler
17. errorHandler (last)
```

### 2.4 Worker Topology

```
BullMQ Queues (redisQueue connection):
├── webhook-events        → webhook-processor.worker.js
├── refund-retry          → refund-retry.worker.js
├── email-dispatch        → email-dispatch.worker.js
├── booking-expiry        → repeating (60s)
├── payment-reconciliation → repeating (5m)

DLQ Monitoring:
├── dlq-processor.worker.js (continuous loop, bounded pagination)

Reconciliation:
├── payment-reconciliation-queue.worker.js
```

### 2.5 Database Connection Topology

```
pg.Pool (config/db.js)
├── API server queries
├── Worker queries
├── Transaction helper (transaction/transactionRR)
├── Admin query helper (statement_timeout override)
└── Pool telemetry (total/idle/waiting)

Connection Safety:
├── validateClusterPoolSafety() — PM2 cluster guard
├── statement_timeout — 30s default
├── idle_in_transaction_session_timeout — 60s
└── SSL enforced in production
```

### 2.6 Redis Usage

| Subsystem | Client | Failure Strategy |
|-----------|--------|-----------------|
| General cache | `redis` (lazy connect) | fail-open |
| BullMQ queues | `redisQueue` (eager) | fail-closed (workers pause) |
| Rate limiting | `rateLimitRedis` (dedicated) | MemoryStore fallback |
| Idempotency cache | `redis` | DB fallback |
| Session/auth cache | `redis` | DB re-auth fallback |

---

## 3. SECURITY POSTURE

### 3.1 Verified Protections (ACTIVE)

| Control | Status | Evidence |
|---------|--------|----------|
| JWT auth + revocation | ✅ Active | `middleware/index.js` — Redis-cached JTI check, password_change_at validation, is_active check |
| RBAC (requireRole) | ✅ Active | Admin endpoints protected |
| Rate limiting | ✅ Active | globalLimiter, authLimiter, webhookLimiter all mounted |
| Webhook HMAC verification | ✅ Active | `razorpayWebhookController.js` — timingSafeEqual, timestamp verification |
| Webhook deduplication | ✅ Active | `ON CONFLICT (provider, provider_event_id) DO NOTHING` |
| Idempotency middleware | ✅ Active | Redis lock + DB fallback, conflict tracking |
| Proxy header validation | ✅ Active | `proxyValidation.js` strips X-Forwarded-For from unknown sources |
| CSRF protection | ✅ Active | `csrfProtection.js` enforces X-Requested-With in production |
| CORS origin whitelist | ✅ Active | `env.CORS_ORIGINS` validated |
| SSL enforcement (DB) | ✅ Active | `config/db.js` rejects non-SSL DATABASE_URL in production |
| Backpressure | ✅ Active | `backpressureMiddleware` mounted globally |

### 3.2 Remaining Critical Issues

#### 🔴 CRITICAL-1: bcryptQueue.js is a COMPLETE STUB
**File**: `planbuddy_v9/services/bcryptQueue.js`
**Impact**: Passwords are stored as `stub_hash_...` with NO cryptographic hashing. Any database breach exposes plaintext-equivalent passwords.
**Exploitability**: Trivial — read DB → immediate credential compromise.
**Fix**: Replace with real `bcrypt` module.

#### 🔴 CRITICAL-2: No .dockerignore in planbuddy_v9/
**File**: Missing `planbuddy_v9/.dockerignore`
**Impact**: `COPY . .` in Dockerfile ships `.env`, `chaos/`, `__tests__/`, tmp files, debug scripts to production images.
**Exploitability**: High — compromised container = immediate access to secrets + attack tools.
**Fix**: Create `.dockerignore` excluding secrets, tests, chaos, tmp files.

#### 🔴 CRITICAL-3: DB credential leak in connection error logs
**File**: `planbuddy_v9/config/db.js` (lines 209–217)
**Impact**: On connection failure, `console.error` prints `DB ENV` block including `DB_PASSWORD` (marked "REDACTED" but pattern leaks presence).
**Fix**: Remove credential logging entirely from error path.

#### 🟠 HIGH-1: Prometheus metric name mismatches
**Files**: `middleware/errorHandler.js`, `controllers/paymentController.js`, `middleware/rateLimit.js`
**Impact**: Multiple modules reference `monitoring.payment_failures_total` and `monitoring.rate_limit_hits_total` but these metrics are defined in `metricsService.js`, not `monitoring.js`. Optional chaining (`?.`) causes silent no-ops. Production monitoring is partially blind.
**Fix**: Unify metric imports or re-export metrics from monitoring.js.

#### 🟠 HIGH-2: Webhook worker closes global DB pool on shutdown
**File**: `planbuddy_v9/workers/webhook-processor.worker.js` (lines 278–282)
**Impact**: If webhook worker runs alongside other workers in the same process (`workers/index.js`), calling `db.end()` terminates the pool for ALL workers.
**Fix**: Remove `db.end()` from individual worker shutdown; let orchestrator handle it.

---

## 4. DATABASE SAFETY

### 4.1 Verified Protections

| Control | Status |
|---------|--------|
| Pool cluster safety guard | ✅ Validates DB_POOL_MAX × PM2_INSTANCES ≤ 80% PG max_connections |
| Transaction retry logic | ✅ Exponential backoff for 40001/40P01 serialization failures |
| Advisory locks | ✅ `withAdvisoryLock()` helper for lease fencing |
| Row-level locking | ✅ `SELECT FOR UPDATE` on all financial mutations |
| Connection timeouts | ✅ connectTimeout 5s, statement_timeout 30s, idle_timeout 30s |
| SSL enforcement | ✅ Production DATABASE_URL must include SSL |

### 4.2 Remaining Risks

- `dbService_fixed.js` uses manual `client.release()` pattern — correct but requires discipline.
- No query timeout for `adminQuery` beyond the 120s default.

---

## 5. QUEUE + WORKER RELIABILITY

### 5.1 Verified Protections

| Control | Status |
|---------|--------|
| Webhook lease fencing | ✅ `lease_version` + `lease_expires_at` with `FOR UPDATE SKIP LOCKED` |
| Webhook execution log | ✅ `webhook_event_execution_log` with `ON CONFLICT (provider_event_id)` |
| DLQ pagination | ✅ Bounded at 100 failed jobs per cycle |
| DLQ distributed lock | ✅ Redis NX lock prevents concurrent scans |
| Retry backoff | ✅ Exponential: 1s→5s→30s→2m→5m |
| Idempotency retry | ✅ DB + Redis dual-layer with conflict abuse detection |
| Queue reliability state | ✅ In-memory telemetry registry |

### 5.2 Remaining Risks

- Webhook processor `db.end()` on SIGTERM breaks co-located workers.
- `process.on('exit', ...)` with `clearInterval` is async-antipattern (exit event is synchronous-only).
- Worker heartbeat in webhook processor uses `setInterval` without error handling for heartbeat itself.

---

## 6. OBSERVABILITY

### 6.1 Verified Protections

| Control | Status |
|---------|--------|
| Structured Pino logging | ✅ AsyncLocalStorage trace context |
| Request correlation IDs | ✅ `X-Request-Id` header + propagation |
| Prometheus metrics | ✅ metricsService.js with 15+ metrics |
| Health probes | ✅ /health/live (liveness), /health/ready (readiness + degraded) |
| Production health cron | ✅ Cached DB queries every 5 min for integrity/DLQ metrics |
| Pool telemetry | ✅ Exposed via db.poolStats() |

### 6.2 Remaining Risks

- Metric name mismatches cause silent data loss (see HIGH-1).
- `monitoring.js` and `metricsService.js` dual-registry pattern is fragile.
- No event loop lag metric exported to Prometheus.

---

## 7. DEPLOYMENT + INFRASTRUCTURE

### 7.1 Verified Protections

| Control | Status |
|---------|--------|
| Graceful shutdown | ✅ server.js: drain requests → drain queues → close Redis → close DB |
| SIGTERM/SIGINT handlers | ✅ Registered in server.js and workers |
| Multi-stage Dockerfile | ✅ node:20-alpine, non-root user |
| Docker healthcheck | ✅ `scripts/healthcheck.js` |
| PM2 ecosystem config | ✅ Separate api/workers/maintenance processes |

### 7.2 Remaining Risks

- **No `.dockerignore`** — ships secrets and attack tools to production.
- **Grafana compose** uses `${GRAFANA_ADMIN_PASSWORD}` — safe if env var is set, but no validation.
- **Worker shutdown** in webhook-processor calls `db.end()` — breaks process-shared pool.

---

## 8. UNSAFE ASSUMPTIONS IDENTIFIED

1. **Assumption**: `bcryptQueue.js` performs real hashing.  
   **Reality**: Complete stub. Passwords are trivially recoverable.

2. **Assumption**: `monitoring.js` exports all metrics referenced by middleware.  
   **Reality**: Only `request_total` and `request_duration_ms` exist there. Other metrics live in `metricsService.js` and are unreachable from middleware that imports `monitoring.js`.

3. **Assumption**: Docker image only ships production code.  
   **Reality**: No `.dockerignore` means `.env`, chaos tools, tests, and debug scripts ship.

4. **Assumption**: Individual workers can safely close the DB pool.  
   **Reality**: `db` is a singleton; `db.end()` in one worker kills all DB access in the process.

5. **Assumption**: `db.js` error logging is safe.  
   **Reality**: Logs `DB_PASSWORD` presence and other connection details on failure.

---

## 9. SINGLE POINTS OF FAILURE

| SPOF | Impact | Mitigation Status |
|------|--------|-------------------|
| PostgreSQL | Total outage | ✅ Pool retries, graceful degradation |
| Redis (cache) | Slower responses | ✅ Fail-open |
| Redis (queue) | Background jobs pause | ✅ Workers auto-reconnect |
| Razorpay API | Payment/refund stall | ✅ Circuit breaker |
| Single worker process | All background jobs die | ⚠️ PM2 config supports separation, but default runs all-in-one |
| bcrypt stub | Credential compromise | ❌ NO MITIGATION |

---

## 10. ROLLBACK PLAN

Before any changes:
1. `git stash` or branch: `git checkout -b production-hardening-$(date +%Y%m%d)`
2. All fixes are incremental; no schema migrations required for Phase 1 blockers.
3. Rollback per fix: revert single file changes.
4. No API contract changes anticipated.

---

## 11. PHASE 0 CERTIFICATION

| Criterion | Status |
|-----------|--------|
| Architecture mapped | ✅ Complete |
| Entrypoints identified | ✅ Complete |
| Worker topology mapped | ✅ Complete |
| Queue flow mapped | ✅ Complete |
| Auth flow mapped | ✅ Complete |
| Unsafe assumptions listed | ✅ Complete |
| SPOFs identified | ✅ Complete |
| Rollback plan defined | ✅ Complete |

**Phase 0 Gate**: ✅ PASSED — Proceed to Phase 1 (Security Hardening).

**Blockers for Production**:
1. Replace bcrypt stub with real bcrypt.
2. Create `.dockerignore`.
3. Fix metric name mismatches.
4. Remove DB credential leak from logs.
5. Fix worker shutdown DB pool closure.

---
*End of Phase 0 Baseline Report*
