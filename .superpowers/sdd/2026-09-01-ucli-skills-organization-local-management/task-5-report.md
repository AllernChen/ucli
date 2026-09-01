# Task 5 report — bounded Skills state commands

## Implemented

- Added validated IPC handlers for previewing and applying a single package's CLI desired-state change, plus managed-package removal.
- Rebuilds every state-change request from a package ID, scope, scope key, adapter IDs, desired-state enums, and (for apply) a SHA-256 revision. Renderer-controlled paths and provenance fields are discarded.
- Added preload and renderer wrappers, then Pinia state for `statePreview` and independent `stateSaving` handling. A successful apply or managed-package removal refreshes local Skills state; stale apply errors retain the preview.
- The store preserves only the existing allowlisted recovery action, never a recovery path or other injected details.

## TDD evidence

Before production edits, the focused command failed with eight expected failures: the three IPC handlers and renderer/store actions did not exist. The failures were missing registrations/actions and `TypeError` for the missing methods.

```powershell
node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs
```

## Verification

```powershell
node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-service.test.mjs
# 116 passed / 0 failed / 0 skipped

node --check electron/skills/ipc.js
node --check electron/preload.js
node --check src/ipc.js
node --check src/stores/skills.js

git diff --check
```

All commands exited successfully. Node emitted the repository's existing `MODULE_TYPELESS_PACKAGE_JSON` warning for ESM source files; no new warning or test diagnostic was introduced.

## Files

- `electron/skills/ipc.js`
- `electron/preload.js`
- `src/ipc.js`
- `src/stores/skills.js`
- `test/skills-ipc.test.mjs`
- `test/skills-renderer-ipc.test.mjs`
- `test/skills-store.test.mjs`

## Scope and concerns

- No server code, data schema, UI component, or legacy `setSkillEnabled` caller was changed.
- `inherit` is admitted at the IPC enum boundary as required; the existing trusted planner remains authoritative for whether a requested state is executable.

## Review follow-up: mutation serialization and preview fencing

- Added a promise-queued, package-wide main-process mutation boundary. It serializes CLI state apply, package and installation removal, local and verified-server update, adapter apply, enablement, drift resolution, and CLI recovery. Package-wide locking is intentionally stronger than per-scope locking because canonical package content and managed-package removal span all scopes.
- The queued operation enters the existing state coordinator only after it owns the lock, so its current snapshot and expected-revision check cannot race an earlier same-package mutation. Lock entries are deleted after either success or failure.
- Added store preview identity (`packageId`, `scopeType`, `scopeKey`) and a monotonic request token. A late preview cannot replace a newer request; a project change clears and fences pending previews.

### Follow-up TDD and verification

Before the production change, two service concurrency tests and two deferred-preview tests failed as expected: a same-revision second apply settled before the first mutation finished, removal interleaved with an apply, a late preview overwrote the newer result, and a scope switch did not fence a pending preview.

```powershell
node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-state-coordinator.test.mjs test/skills-service.test.mjs test/skills-contracts.test.mjs
# 139 passed / 0 failed / 0 skipped

node --check electron/skills/service.js
node --check src/stores/skills.js
git diff --check
```

The repository's existing `MODULE_TYPELESS_PACKAGE_JSON` warning remained the only warning.

## Review follow-up: installation, update-check, and apply-preview races

- Reuse-capable local installs, verified-server archive installs, and batch installs now serialize package selection through a scope lock, then acquire and revalidate the selected package lock before any destructive reuse. The package lock is never reacquired from the internal install path.
- Update checks select IDs first, acquire each package lock, reload the package after acquisition, and keep source inspection, update-state writes, and persistence inside that lock. A package removed before acquisition produces only `SKILL_PACKAGE_NOT_FOUND`.
- Store apply captures the active preview token and package/scope identity. A settled apply changes preview or error state only if it still owns that UI state; superseded preview failures are likewise ignored.

### Follow-up TDD and verification

Before the production change, the focused commands failed with the expected six races: local reuse, verified archive reuse, and update checking could settle alongside an in-flight package mutation; a superseded preview failure and both outcomes of a pending apply could overwrite newer UI state.

```powershell
node --test --test-name-pattern="local install that reuses|verified archive that reuses|checkUpdates holds" test/skills-service.test.mjs
node --test --test-name-pattern="superseded CLI state preview|pending CLI state apply" test/skills-store.test.mjs

node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-state-coordinator.test.mjs test/skills-service.test.mjs test/skills-contracts.test.mjs
# 145 passed / 0 failed / 0 skipped

node --check electron/skills/service.js
node --check src/stores/skills.js
git diff --check
```

The repository's existing `MODULE_TYPELESS_PACKAGE_JSON` warning remained the only warning.
