# TODO_OUTBOX_RELAY (transactional outbox relay)

## Step 1: Validate existing outbox infrastructure
- [x] Locate outbox support in root `atomic-engine.js` (claim/commit/reclaim)
- [x] Locate outbox config knobs in root `queues.js`

## Step 2: Implement relay worker
- [x] Create `workers/outbox-relay.worker.js`

## Step 3: Wire relay worker into runtime
- [x] Require relay worker from `planbuddy_v9/workers/index.js`

## Step 4: Fix remaining issues / verify build
- [ ] Resolve ESLint / lint errors (if any)
- [ ] Run `npm test` or integration suite (planbuddy_v9)
- [ ] Smoke test by starting workers and watching for `[outbox-relay]` logs

