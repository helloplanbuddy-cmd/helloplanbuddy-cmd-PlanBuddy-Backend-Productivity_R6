# TODO

## Phase 0 — Test isolation (mandatory)
- [ ] Update `planbuddy_v9/jest.config.js` to hard-scope Jest to backend tests only and expand ignore patterns.
- [ ] Add `planbuddy_v9/.jestignore` (/.vscode, /.codex, node_modules).
- [ ] Run: `npm test --silent` (from inside `planbuddy_v9`) and confirm only backend tests execute.

## Phase 1 — Domain invariants (after test signal is clean)
- [ ] Fix cancellation atomicity + ensure booking capacity restored exactly once.
- [ ] Implement deterministic idempotency strategy (no random fallback).
- [ ] Fix refund exactly-once behavior (handle upsert / conflict correctly).

## Phase 2 — Test corrections
- [ ] Fix any Jest/Chai matcher mismatches (e.g. `toBe` vs `to.be.false`).
- [ ] Make refund/mock ids deterministic.

## Phase 3 — Jest clean exit / open handles
- [ ] Add/confirm global teardown closes DB/Redis/queues/workers.

## Verification (strict gate)
- [ ] All tests passing (0 failed)
- [ ] No duplicate-key errors
- [ ] Jest exits cleanly (no open handle warnings)

