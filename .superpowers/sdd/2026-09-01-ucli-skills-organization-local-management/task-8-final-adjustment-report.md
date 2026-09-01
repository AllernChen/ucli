# Task 8 final stale-item adjustment

## Delivered

- Removed `SKILL_PROJECTION_PLAN_STALE` from the batch abort set.
- A per-item digest mismatch remains a non-retryable failed item, but later items are independently re-resolved and may proceed.

## TDD and verification

- RED: changed the deferred A/B/C contract to require B stale failure and C success; it failed because the prior coordinator aborted C.
- GREEN: focused Skills/server/startup suite — 80 passed, 0 failed.
- `npm run build` and `git diff --check` passed.
