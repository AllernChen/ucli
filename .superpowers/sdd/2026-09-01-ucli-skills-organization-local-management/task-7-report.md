# Task 7 report: organization/local Skills presentation

## Delivered

- Added origin-aware management catalog and grouping. Organization placement accepts only a complete persisted `sourceIdentity`, normalizes the stored server origin, and joins online catalog data only by that identity's version ID.
- Kept installed organization Skills grouped by their original organization while offline; invalid legacy organization identities fall into the explicit unresolved group instead of being inferred from names or the active connection.
- Added `全部`、`组织 Skills` and `本地 Skills` views with separate `同步组织目录` and `重新扫描本地` controls.
- Added a direct CLI desired/actual-state matrix. Each switch previews the main-process plan before confirmation; blocked isolation states are disabled and show their stable reason. The ordinary physical-installation toggle was removed.

## Verification

- RED: `node --test test/skills-presentation.test.mjs` — four new presentation contracts failed because the management functions and matrix component were absent.
- GREEN: `node --test test/skills-presentation.test.mjs test/skills-store.test.mjs` — 71 passed, 0 failed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Concerns

- No server or CLI runtime was started. This UI slice uses the established preview/apply IPC and existing strict projection planner; end-to-end filesystem projection behavior remains covered by its earlier task suites.
