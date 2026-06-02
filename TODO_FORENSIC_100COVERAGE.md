# TODO: Forensic execution plan for 100% codebase coverage backend audit

> Note: This repo appears to already contain many “production hardening” tests and audit scripts. This TODO defines a *repeatable execution plan* to reach full coverage (read + trace + verify) and generate an evidence-backed root-cause matrix.

## Step 1 — Inventory & build an audit manifest
- [ ] Enumerate every runtime entrypoint: `server.js`, `app.js`, `routes/*`, `controllers/*`, `middleware/*`, `guards/*`, `services/*`, `workers/*`, `config/*`, `utils/*`, `scripts/*`.
- [ ] Enumerate queue producers/consumers: `config/queues.js` and every `workers/*.worker.js` + `workers/index.js`.
- [ ] Enumerate DB/migrations: `migrations/*.sql` (and any extra migrations outside that folder).

## Step 2 — Instrumentation for evidence (line-level)
- [ ] Ensure Jest runs with coverage collection enabled for JS.
- [ ] Add/confirm coverage thresholds targeting: controllers, middleware, services, workers, config.
- [ ] Add evidence capture conventions: file path + function name + line numbers.

## Step 3 — Execute “read-every-file + map architecture”
- [ ] For each file in manifest, record: exports, called by, and call chain.
- [ ] Build architecture maps:
  - [ ] request lifecycle map
  - [ ] auth + role boundaries map
  - [ ] booking lifecycle map
  - [ ] payment lifecycle map
  - [ ] webhook lifecycle map
  - [ ] queue lifecycle map
  - [ ] DB transaction lifecycle map

## Step 4 — Request/route verification
- [ ] Enumerate all routes in `routes/index.js` and any sub-routers.
- [ ] For each route: verify middleware ordering (auth → validation → idempotency → controller).
- [ ] For each error path: verify errorHandler normalization and status mapping.

## Step 5 — Security boundaries verification
- [ ] Auth: JWT/JTI issuance, verification, refresh rotation, revocation, lockout.
- [ ] Authorization: `requireRole`, RBAC paths, admin boundaries.
- [ ] Webhook authenticity: signature/timestamp validation + replay protection.
- [ ] Rate limiting: confirm skip/bypass logic, fail-closed behaviors.
- [ ] Idempotency: strict enforcement for mutating endpoints; conflict limiter; webhook dedup.

## Step 6 — Financial safety verification (root-cause focused)
- [ ] Verify exactly-once refund / idempotent state machine transitions.
- [ ] Verify reconciliation worker correctness (no double mutations).
- [ ] Verify webhook replay service / saga pattern (ordering and reprocessing guarantees).
- [ ] Verify financial write guards and “architecture freeze” enforcement.

## Step 7 — Queue reliability verification
- [ ] For every queue: producer, consumer(s), retries/backoff, DLQ behavior, fencing/leases.
- [ ] For repeating jobs: verify schedule registration and safe shutdown behavior.

## Step 8 — Infrastructure verification
- [ ] Startup: dependency checks, readiness, cron start.
- [ ] Shutdown: drains connections + queue + redis + db, timeouts, crash recovery.
- [ ] Docker/compose: confirm envs and healthcheck scripts.

## Step 9 — DB schema graph verification
- [ ] Parse every migration and derive schema dependency graph.
- [ ] Validate constraints: PK/FK/UNIQUE/CHECK + referenced ordering.
- [ ] Validate ledger/integrity tables and transition logs.

## Step 10 — Evidence-based root-cause matrix generation
- [ ] Produce a per-file issue ledger with UNKNOWN for anything not directly verified.
- [ ] Each finding must include: file path, function, line numbers, evidence snippets.
- [ ] Each fix must include a verification method.

## Step 11 — Achieve 100% code coverage
- [ ] Add/extend tests until coverage is 100%.
- [ ] Run coverage + identify uncovered lines.
- [ ] Repeat until thresholds are satisfied.

## Step 12 — Final production decision artifacts
- [ ] Generate final reports:
  - [ ] architecture map
  - [ ] flow maps
  - [ ] queue inventory
  - [ ] schema graph
  - [ ] security/reliability/financial safety findings
  - [ ] production readiness score
  - [ ] go/no-go decision

