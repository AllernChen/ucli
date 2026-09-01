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

## Review-fix follow-up

- The CLI matrix now renders every persisted user/project scope tuple instead of selecting an arbitrary first installation. `inherit` remains distinct and offers an explicit independent-enable action; the regular switch can request disable.
- Desired state, actual state, and enforcement state are shown separately. Drift, missing/invalid/conflict, recovery/error, and persisted desired/actual mismatches fail closed and disable ordinary state mutation.
- Organization-version cards are filtered to the exact normalized origin and organization group, including same-name Skills from distinct organizations.
- The organization header now exposes syncing, stale, error, and last-successful-sync states independently. New controls have accessible labels.
- Review RED: the focused presentation test failed for scope tuples, abnormal/mismatch state, multi-organization grouping, and sync/matrix rendering before these changes.
- Review GREEN: `node --test test/skills-presentation.test.mjs test/skills-store.test.mjs` — 76 passed, 0 failed; `npm run build` and `git diff --check` passed.

## Guarded recovery follow-up

- Added a package-ID-only `resolveCliStateRecovery` path through main-process IPC, preload, renderer IPC, and the Skills store. The IPC boundary rejects renderer-controlled paths, scopes, and other recovery inputs; recovery-required errors now expose a stable sanitized message.
- Recovery-required matrix cells expose an accessible `恢复投放` action only in repair mode. It confirms the guarded recovery, disables duplicate state operations while pending, then refreshes the catalog after success.
- Added IPC, renderer bridge, store, and presentation contracts for the recovery path.

## Guarded recovery verification

- RED: the new IPC, renderer bridge, store, and presentation recovery contracts failed before the recovery surface was added.
- GREEN: `node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-presentation.test.mjs` — 93 passed, 0 failed.
- `npm run build` and `git diff --check` are run for this follow-up before commit.

## Recovery refresh follow-up

- A completed recovery now clears its obsolete CLI-state preview before the follow-up state refresh. If that refresh fails, the store returns the successful recovery result with a bounded `{ code, message }` `refreshError`; it leaves the load error visible without reclassifying the recovery as failed.
- RED: the store rejected a successful recovery when `getSkillsState` failed after the mutation.
- GREEN: `node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-presentation.test.mjs` — 94 passed, 0 failed. `npm run build` and `git diff --check` are run before commit.
