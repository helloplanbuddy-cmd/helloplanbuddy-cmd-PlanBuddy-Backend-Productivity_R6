# TODO - Phase 1 Critical Reliability/Security Audit & Fix

- [ ] Issue 1 (CRITICAL): Webhook replay authenticity
  - [ ] Trace all callers of `reprocessEvent()` and the runtime/recovery entrypoints
  - [ ] Verify legacy rows/migration state for `payload_bytes` and `signature` columns
  - [ ] Implement fail-closed behavior: missing payload_bytes or signature must NOT process
  - [ ] Add audit log + metrics on rejection
  - [ ] Add recovery/migration for legacy rows (or operational runbook) with proof
  - [ ] Add unit + integration + failure tests: missing payload_bytes, missing signature, tampered payload

- [ ] Issue 2 (CRITICAL): Outbox end-to-end wiring
  - [ ] Trace controller → service → outbox insert → relay → queue/worker → business mutation
  - [ ] Verify exactly-once semantics for relay and downstream mutation
  - [ ] Verify retry policy, lease recovery, DLQ routing, restart recovery
  - [ ] Identify any missing wiring (startup registration/worker start/shutdown draining)
  - [ ] Implement missing production-grade components/migrations
  - [ ] Add integration tests covering crash between outbox delivery and DB commit, restart recovery, DLQ routing

- [ ] Run evidence-based verification steps
  - [ ] Update `FINAL_VERDICT_AUDIT.md` or Phase 1 audit output with PASS/FAIL evidence
  - [ ] Ensure tests demonstrate required behaviors

