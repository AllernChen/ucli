# Task 8 review-fix report

## Delivered

- Each batch item now retains a digest from the verified initial batch snapshot. Immediately before its mutation, the coordinator resolves that item again; a changed digest records `SKILL_PROJECTION_PLAN_STALE` and aborts remaining work.
- Batch shutdown now closes new work, drains active operations, and prevents later items from starting. Orchestrator shutdown closes batch admission, shuts down the server catalog (including its active transfers/subscription cleanup), then awaits the batch drain before clearing either reference.
- A `false` return from package or projection removal is represented as a stable skipped/not-found result rather than a success.
- The Skills store retains skipped, failed, recovery-required, and remaining selections. Retryable failures are tracked separately so `retryFailedBatch()` retries only items marked retryable.

## TDD and verification

- RED: added stale-snapshot, deferred shutdown, false-removal, retained-skipped, and orchestrator shutdown-order contracts; all failed against the prior implementation.
- GREEN: `node --test test/skills-batch-coordinator.test.mjs test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/server-skills-catalog.test.mjs test/server-skill-download.test.mjs test/summary-startup.test.mjs` — 80 passed, 0 failed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Concern

- Direct Node test commands retain the repository's existing module-type reparsing warnings; no test failed and no production server or CLI process was started.
