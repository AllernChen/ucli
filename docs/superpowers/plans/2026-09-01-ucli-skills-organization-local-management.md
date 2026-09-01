# UCLI Skills Organization, Local, and CLI State Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make organization Skills appear automatically and remain grouped by organization after installation, while adding strict per-CLI desired-state controls and safe bulk management for installed Skills.

**Architecture:** Preserve the existing canonical package and physical installation model, then add durable source identities and per-CLI desired states beside it. A pure projection planner and a main-process coordinator reconcile desired states into verified filesystem projections; a separate organization catalog sync coordinator owns cache TTL and change events. Renderer presentation consumes these explicit models rather than inferring organization or CLI intent from paths.

**Tech Stack:** Electron 43, Node.js 24 ESM, sql.js, Vue 3, Pinia 2, Ant Design Vue 4, electron-vite, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-ucli-skills-organization-local-management-design.md`

## Global Constraints

- This implementation changes only `F:\projects\ucli`; do not modify `ucli-server`.
- Skills page views are exactly `全部`, `组织 Skills`, and `本地 Skills`.
- An installed organization Skill retains its normalized server origin, organization identity, catalog version, and artifact SHA-256 after network loss or explicit disconnect.
- Never infer organization provenance from Skill name, slug, content equality, current organization, or catalog order.
- Organization catalog sync remains strict about URL origin, MIME, size, lifecycle, and SHA-256; do not add legacy fallbacks.
- CLI toggles represent `enabled`, `disabled`, or `inherit` desired state, not merely whether one directory exists.
- Strict per-CLI disable is allowed only when the planner proves isolation. Unsupported inherited-disable combinations return `SKILL_CLI_ISOLATION_UNSUPPORTED` without mutating files or state.
- Disabling is reversible. Removing a projection and removing a managed package are separate commands; the latter is an explicitly confirmed destructive action.
- Batch selection is bounded to one current view, organization, scope, and filtered result set. A batch contains no more than 200 stable item identities.
- Each Skill is an atomic execution boundary. Ordinary item failure does not roll back successful items; persistence uncertainty aborts remaining work.
- Renderer IPC never supplies target paths, server origin, organization data, download URL, artifact hash, or source locator for management operations.
- Errors and events never include URL fragments, tokens, Authorization/Cookie values, response bodies, complete headers, local stacks, or supplier keys.
- Every behavior change follows red-green-refactor, runs its focused gate, and lands as a separate commit.

## File Structure

### New files

- `electron/skills/metadataMigration.js`: idempotent source-identity and desired-state backfill.
- `electron/skills/projectionPlanner.js`: pure desired-state-to-projection plan and revision calculation.
- `electron/skills/stateCoordinator.js`: preview/apply/recovery orchestration for one managed Skill.
- `electron/skills/batchCoordinator.js`: bounded organization/package batch preview and execution.
- `electron/serverConnection/skillsSyncCoordinator.js`: TTL, single-flight, cache status, and safe change notifications.
- `src/components/skills/SkillCliStateMatrix.vue`: direct per-CLI desired/actual state controls.
- `src/components/skills/SkillsBatchActionBar.vue`: selection summary and bulk action entry points.
- `test/skills-metadata-migration.test.mjs`
- `test/skills-projection-planner.test.mjs`
- `test/skills-state-coordinator.test.mjs`
- `test/skills-batch-coordinator.test.mjs`
- `test/server-skills-sync-coordinator.test.mjs`

### Existing files with changed responsibilities

- `electron/persistence/db.js`: persistence primitives only; no UI grouping or filesystem planning.
- `electron/skills/service.js`: owns canonical packages and trusted projection operations; exposes coordinator commands.
- `electron/skills/adapters.js`: publishes tested projection coverage/isolation capabilities.
- `electron/serverConnection/skillsCatalogAdapter.js`: keeps strict catalog/download behavior and supplies durable organization identity on install.
- `electron/serverConnection/ipc.js`, `electron/skills/ipc.js`, `electron/preload.js`, `src/ipc.js`: bounded IPC and safe events.
- `src/stores/serverConnection.js`: organization catalog cache/sync state.
- `src/stores/skills.js`: local catalog, single-state and batch mutation state.
- `src/skillsPresentation.js`: pure origin grouping, unified entries, status cells, and selection rules.
- `src/views/SkillsCenter.vue`: page orchestration only; detailed CLI and batch controls move to focused components.

---

### Task 1: Persist source identities and CLI desired states

**Files:**
- Create: `electron/skills/metadataMigration.js`
- Create: `test/skills-metadata-migration.test.mjs`
- Modify: `electron/persistence/db.js`
- Modify: `test/skills-db.test.mjs`

**Interfaces:**
- Produces: `db.upsertSkillSourceIdentity(identity)`, `db.getSkillSourceIdentity(packageId)`, `db.listSkillSourceIdentities()`, `db.deleteSkillSourceIdentity(packageId)`.
- Produces: `db.upsertSkillCliDesiredState(state)`, `db.listSkillCliDesiredStates(filters)`, `db.deleteSkillCliDesiredStates(packageId)`.
- Produces: `backfillSkillManagementMetadata({ db, now })` as an idempotent synchronous migration.

- [ ] **Step 1: Add failing repository tests for both tables**

Add fixtures and assertions to `test/skills-db.test.mjs`:

```js
const sourceIdentity = {
  packageId: 'skill-1', originKind: 'organization',
  serverOrigin: 'https://server.example.test', organizationId: 'org-1',
  organizationName: 'Engineering', identityStatus: 'resolved',
  catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64),
  createdAt: 100, updatedAt: 100
}

db.upsertSkillSourceIdentity(sourceIdentity)
assert.deepEqual(db.getSkillSourceIdentity('skill-1'), sourceIdentity)

db.upsertSkillCliDesiredState({
  packageId: 'skill-1', scopeType: 'project', scopeKey: 'F:\\projects\\demo',
  adapterId: 'codex', desiredState: 'enabled', enforcementStatus: 'satisfied',
  reasonCode: null, updatedAt: 100
})
assert.equal(db.listSkillCliDesiredStates({ packageId: 'skill-1' })[0].desiredState, 'enabled')
```

Also assert invalid organization rows, invalid hashes, invalid enums, and non-organization rows with organization fields are rejected with `SKILL_SOURCE_IDENTITY_INVALID`.

- [ ] **Step 2: Run the persistence tests and verify RED**

Run:

```powershell
node --test test/skills-db.test.mjs
```

Expected: FAIL because the tables and repository methods do not exist.

- [ ] **Step 3: Add schemas, validation, row mappers, and repository methods**

Create both tables inside `Db._ensureSchema()` after `skill_installations`. Add focused validators before every upsert:

```js
function normalizeSkillSourceIdentity(value) {
  const organization = value.originKind === 'organization'
  const serverOrigin = organization ? new URL(value.serverOrigin).origin : null
  if (organization && (!value.organizationId || !value.catalogVersionId ||
    !/^[a-f0-9]{64}$/.test(value.artifactSha256 || ''))) {
    throw Object.assign(new Error('Skill source identity is invalid'), {
      code: 'SKILL_SOURCE_IDENTITY_INVALID'
    })
  }
  return { ...value, serverOrigin }
}
```

`deleteSkillPackage(packageId)` must delete related identity and desired-state rows in the same immediate transaction path.

- [ ] **Step 4: Add failing idempotent legacy-backfill tests**

In `test/skills-metadata-migration.test.mjs`, seed legacy packages, installations, a server mapping, current connection/service-profile organization names, then call the migration twice. Assert:

```js
assert.deepEqual(db.getSkillSourceIdentity('server-package'), {
  packageId: 'server-package', originKind: 'organization',
  serverOrigin: 'https://server.example.test', organizationId: 'org-1',
  organizationName: 'Engineering', identityStatus: 'resolved',
  catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64),
  createdAt: 100, updatedAt: 100
})
assert.equal(states.find(item => item.adapterId === 'codex').desiredState, 'enabled')
assert.equal(states.find(item => item.adapterId === 'opencode').desiredState, 'inherit')
assert.equal(db.listSkillSourceIdentities().length, 2)
```

Add a second server package without a stored organization name and assert `organizationName === 'org-missing'` and `identityStatus === 'name_pending'`. Assert same-name local content is never linked to the organization.

- [ ] **Step 5: Implement the semantic migration and verify GREEN**

Use `buildSkillVisibility([installation.targetAdapterId], { scopeType })` to create `inherit` rows for visible consumers. Existing explicit direct installations become `enabled` or `disabled`. Use `INSERT ... ON CONFLICT DO NOTHING` so repeated migration never weakens an existing identity or explicit desired state.

Run:

```powershell
node --test test/skills-db.test.mjs test/skills-metadata-migration.test.mjs
git diff --check
```

Expected: all tests pass and the diff has no whitespace errors.

- [ ] **Step 6: Commit Task 1**

```powershell
git add electron/persistence/db.js electron/skills/metadataMigration.js test/skills-db.test.mjs test/skills-metadata-migration.test.mjs
git commit -m "feat(skills): persist source and CLI intent"
```

---

### Task 2: Preserve provenance through install, update, projection removal, and disconnect

**Files:**
- Modify: `electron/skills/service.js`
- Modify: `electron/serverConnection/skillsCatalogAdapter.js`
- Modify: `electron/persistence/db.js`
- Modify: `test/skills-service.test.mjs`
- Modify: `test/server-skills-catalog.test.mjs`
- Modify: `test/server-connection-db.test.mjs`

**Interfaces:**
- `packageView(pkg)` adds `sourceIdentity` and `cliDesiredStates`.
- `service.removeInstallation(installationId)` retains the canonical package after the final projection.
- New `service.removePackage(packageId)` removes trusted projections, canonical content, identity, desired states, and server mapping.
- Verified server source includes `organizationName` and updates identity version/hash atomically.

- [ ] **Step 1: Write failing service lifecycle tests**

Cover local install identity, verified organization install identity, organization update identity, explicit disconnect, final projection removal, and explicit package removal. Assert the key boundary:

```js
await service.removeInstallation(installed.installations[0].id)
assert.ok(db.getSkillPackage(installed.id))
assert.ok(db.getSkillSourceIdentity(installed.id))
assert.equal(db.listSkillInstallations({ packageId: installed.id }).length, 0)

await service.removePackage(installed.id)
assert.equal(db.getSkillPackage(installed.id), null)
assert.equal(db.getSkillSourceIdentity(installed.id), null)
```

For a server install, assert `state.packages[0].sourceIdentity.originKind === 'organization'` after `server_skill_versions` is cleared.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test test/skills-service.test.mjs test/server-skills-catalog.test.mjs test/server-connection-db.test.mjs
```

Expected: FAIL because package views lack identities and final projection removal deletes the package.

- [ ] **Step 3: Write source identity and explicit desired states in install transactions**

Add a trusted helper in `service.js`:

```js
function identityForPreparedSource(packageId, prepared, serverSource, timestamp) {
  if (serverSource) return {
    packageId, originKind: 'organization', serverOrigin: serverSource.serverOrigin,
    organizationId: serverSource.organizationId,
    organizationName: serverSource.organizationName,
    identityStatus: 'resolved', catalogVersionId: serverSource.versionId,
    artifactSha256: serverSource.sha256, createdAt: timestamp, updatedAt: timestamp
  }
  const originKind = ['github', 'gitlab'].includes(prepared.source.type)
    ? prepared.source.type : 'local'
  return { packageId, originKind, identityStatus: 'resolved', createdAt: timestamp, updatedAt: timestamp }
}
```

Write identity plus direct `enabled` and covered `inherit` desired states in the same transaction that inserts the package/installations. Reused server packages must upgrade an existing non-organization identity only after verified server archive success.

Call `backfillSkillManagementMetadata({ db, now })` once at the start of `createSkillsService`, before any package view or mutation is available. The migration is synchronous and idempotent, so renderer reads cannot observe half-backfilled metadata.

- [ ] **Step 4: Make organization identity durable and split remove semantics**

Extend `identityOf(connectionManager)` and `sourceForVersion()` with the current organization name. Update identity `catalogVersionId` and `artifactSha256` on verified server update. Change `removeInstallation` to delete only the selected physical projection. Add `removePackage` with the existing SHA-checked canonical cleanup and database cleanup.

Explicit disconnect continues clearing online versions but must not delete source identities or managed packages.

- [ ] **Step 5: Run focused regression and commit**

```powershell
node --test test/skills-db.test.mjs test/skills-metadata-migration.test.mjs test/skills-service.test.mjs test/server-skills-catalog.test.mjs test/server-connection-db.test.mjs
git diff --check
git add electron/skills/service.js electron/serverConnection/skillsCatalogAdapter.js electron/persistence/db.js test/skills-service.test.mjs test/server-skills-catalog.test.mjs test/server-connection-db.test.mjs
git commit -m "feat(skills): retain organization provenance"
```

---

### Task 3: Build the pure strict projection planner

**Files:**
- Create: `electron/skills/projectionPlanner.js`
- Create: `test/skills-projection-planner.test.mjs`
- Modify: `electron/skills/adapters.js`
- Modify: `test/skills-service.test.mjs`

**Interfaces:**
- `listSkillProjectionCapabilities(options)` returns ordered `{ adapterId, directRoot, covers, canExcludeInherited, isolationReasonCode }` entries.
- `projectionStateRevision(snapshot)` returns a deterministic SHA-256 revision over trusted state.
- `planSkillCliStateChange(snapshot, requestedChanges)` returns `{ revision, classification, steps, impacts, reasonCode }`.

- [ ] **Step 1: Write failing capability and planner tests**

Create table-driven cases for direct enable/disable, provider disable with enabled consumer, provider and consumer disable, inherited consumer disable while provider remains enabled, noop, incompatible target, drift, and recovery state.

```js
const plan = planSkillCliStateChange(snapshot({
  installations: [direct('codex')],
  desiredStates: [desired('codex', 'enabled'), desired('opencode', 'enabled')]
}), [{ adapterId: 'codex', desiredState: 'disabled' }])

assert.equal(plan.classification, 'migration_required')
assert.deepEqual(plan.steps.map(step => [step.type, step.adapterId]), [
  ['ensure_direct', 'opencode'],
  ['disable_direct', 'codex'],
  ['set_desired', 'codex']
])
```

For Codex enabled plus OpenCode disabled, assert `classification === 'blocked'` and `reasonCode === 'SKILL_CLI_ISOLATION_UNSUPPORTED'` because no tested exclude capability exists.

- [ ] **Step 2: Run planner tests and verify RED**

```powershell
node --test test/skills-projection-planner.test.mjs
```

- [ ] **Step 3: Export explicit adapter capabilities**

Keep existing coverage values, but expose them without renderer inference:

```js
export function listSkillProjectionCapabilities(options = {}) {
  return Object.keys(SKILL_ADAPTERS).map((adapterId) => ({
    adapterId,
    directRoot: resolveSkillRoot({ adapterId, ...options }),
    covers: effectiveProjectionCoverage(adapterId, options),
    canExcludeInherited: false,
    isolationReasonCode: 'SKILL_CLI_ISOLATION_UNSUPPORTED'
  }))
}
```

Do not mark a CLI excludable until a supported native mechanism has its own integration test.

- [ ] **Step 4: Implement deterministic revision and planning**

Revision input contains sorted package ID, content hash, installation IDs/status/hash, desired states, scope, and capabilities. It excludes timestamps and paths not needed for semantics. Return only abstract steps; the planner never reads or writes files.

- [ ] **Step 5: Verify and commit**

```powershell
node --test test/skills-projection-planner.test.mjs test/skills-service.test.mjs
git diff --check
git add electron/skills/projectionPlanner.js electron/skills/adapters.js test/skills-projection-planner.test.mjs test/skills-service.test.mjs
git commit -m "feat(skills): plan strict CLI state changes"
```

---

### Task 4: Reconcile one Skill safely with rollback and recovery

**Files:**
- Create: `electron/skills/stateCoordinator.js`
- Create: `test/skills-state-coordinator.test.mjs`
- Modify: `electron/skills/service.js`
- Modify: `electron/skills/contracts.js`
- Modify: `test/skills-service.test.mjs`
- Modify: `test/skills-contracts.test.mjs`

**Interfaces:**
- `createSkillStateCoordinator(operations)` returns `preview(request)` and `apply({ ...request, expectedRevision })`.
- `service.previewCliStateChange(request)` and `service.applyCliStateChange(request)` expose the coordinator.
- Request shape: `{ packageId, scopeType, scopeKey, changes: [{ adapterId, desiredState }] }`.

- [ ] **Step 1: Write failing coordinator tests with fake operations**

Assert call order and rollback:

```js
assert.deepEqual(calls, [
  ['ensureDirect', 'opencode'],
  ['verifyDirect', 'opencode', 'package-sha'],
  ['disableDirect', 'codex'],
  ['commitDesired', 'codex', 'disabled'],
  ['rescan', 'package-1']
])
```

Inject failure at verification, disable, database transaction, and flush. Before commit, assert the new projection is removed and the old one remains. After an uncertain committed cleanup, assert `enforcementStatus === 'recovery_required'` and subsequent destructive apply rejects with `SKILL_PROJECTION_RECOVERY_REQUIRED`.

- [ ] **Step 2: Run coordinator tests and verify RED**

```powershell
node --test test/skills-state-coordinator.test.mjs
```

- [ ] **Step 3: Implement preview/revision enforcement and abstract execution**

`preview()` always uses the current trusted snapshot. `apply()` regenerates the plan and rejects mismatched revisions:

```js
if (plan.revision !== expectedRevision) {
  throw skillError('Skill projection plan is stale', 'SKILL_PROJECTION_PLAN_STALE')
}
if (plan.classification === 'blocked') {
  throw skillError('CLI isolation is unsupported', plan.reasonCode)
}
```

Track each newly created projection with its inspected SHA-256 so rollback never deletes user-modified content.

- [ ] **Step 4: Integrate trusted operations into `createSkillsService`**

Reuse existing canonical integrity checks, `applyToAdapter`, `setEnabled`, `inspectSkillDirectory`, `copySkillDirectoryAtomic`, `removeManagedSkillDirectory`, database transaction, and flush behavior. Add non-public operation options so the coordinator can defer the final desired-state commit and flush until all filesystem steps are verified.

Return `{ package, plan, affectedInstallationIds, affectedSessions }`; do not automatically restart sessions.

- [ ] **Step 5: Add real filesystem integration cases**

In `test/skills-service.test.mjs`, prove:

- disabling Codex while keeping OpenCode creates `.opencode/skills/<name>` before removing `.agents/skills/<name>`;
- disabling OpenCode while Codex remains enabled is blocked without file/DB changes;
- shared Codex/DSH migration retains the requested CLI;
- stale preview, drift and persistence failure preserve a usable projection.

- [ ] **Step 6: Verify and commit**

```powershell
node --test test/skills-projection-planner.test.mjs test/skills-state-coordinator.test.mjs test/skills-service.test.mjs test/skills-contracts.test.mjs
git diff --check
git add electron/skills/stateCoordinator.js electron/skills/service.js electron/skills/contracts.js test/skills-state-coordinator.test.mjs test/skills-service.test.mjs test/skills-contracts.test.mjs
git commit -m "feat(skills): reconcile per-CLI desired state"
```

---

### Task 5: Expose bounded single-Skill state and package-removal IPC

**Files:**
- Modify: `electron/skills/ipc.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/skills.js`
- Modify: `test/skills-ipc.test.mjs`
- Modify: `test/skills-renderer-ipc.test.mjs`
- Modify: `test/skills-store.test.mjs`

**Interfaces:**
- IPC: `skills:preview-cli-state-change`, `skills:apply-cli-state-change`, `skills:remove-package`.
- Renderer: `skills.previewCliStateChange(request)`, `skills.applyCliStateChange(request)`, `skills.removePackage(packageId)`.

- [ ] **Step 1: Write failing IPC validation tests**

Accept only a stable package ID, known scope, stored scope key, at most five unique adapter changes, `enabled|disabled|inherit`, and a 64-character hexadecimal revision on apply. Assert attacker-supplied `targetPath`, `serverOrigin`, `organizationId`, and `artifactSha256` are dropped rather than forwarded.

```js
await handlers.get('skills:apply-cli-state-change')({}, {
  packageId: 'package-1', scopeType: 'project', scopeKey: 'F:\\demo',
  changes: [{ adapterId: 'codex', desiredState: 'disabled' }],
  expectedRevision: 'a'.repeat(64), targetPath: 'F:\\attacker'
})
assert.equal(Object.hasOwn(calls[0], 'targetPath'), false)
```

- [ ] **Step 2: Write failing bridge and store tests**

Assert the store keeps `statePreview`, uses a separate `stateSaving` flag, refreshes local state after success, preserves the preview after a stale-plan failure, and exposes the safe recovery action only.

- [ ] **Step 3: Run tests and verify RED**

```powershell
node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs
```

- [ ] **Step 4: Implement the smallest validated bridge**

Register the three handlers, add preload methods, add renderer wrappers, and implement Pinia actions. Keep legacy `setSkillEnabled` only for drift/recovery compatibility until Task 7 removes normal UI callers.

- [ ] **Step 5: Verify and commit**

```powershell
node --test test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/skills-service.test.mjs
git diff --check
git add electron/skills/ipc.js electron/preload.js src/ipc.js src/stores/skills.js test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs
git commit -m "feat(skills): expose desired-state commands"
```

---

### Task 6: Make organization catalog synchronization automatic and observable

**Files:**
- Create: `electron/serverConnection/skillsSyncCoordinator.js`
- Create: `test/server-skills-sync-coordinator.test.mjs`
- Modify: `electron/orchestrator.js`
- Modify: `electron/serverConnection/ipc.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/serverConnection.js`
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/server-connection-ipc.test.mjs`
- Modify: `test/server-connection-store.test.mjs`

**Interfaces:**
- `createOrganizationSkillsSyncCoordinator({ connectionManager, catalog, now, ttlMs, onChanged })`.
- Methods: `getState()`, `ensureFresh({ force = false })`, `handleConnectionState(state)`, `shutdown()`.
- IPC: `server-connection:get-skills-sync-state`, `server-connection:ensure-skills-fresh`.
- Event: `server-connection:skills-catalog-changed` with safe identity/revision/time/status only.

- [ ] **Step 1: Write failing coordinator tests**

Use a fake clock and deferred sync to cover cache-first state, five-minute TTL, forced sync, single-flight, connection revision change, transient error retaining cache, stale completion, safe event payload, and shutdown cancellation.

```js
await coordinator.ensureFresh()
now += 4 * 60_000
await coordinator.ensureFresh()
assert.equal(syncCalls, 1)
now += 61_000
await coordinator.ensureFresh()
assert.equal(syncCalls, 2)
```

- [ ] **Step 2: Run coordinator tests and verify RED**

```powershell
node --test test/server-skills-sync-coordinator.test.mjs
```

- [ ] **Step 3: Implement coordinator and replace fire-and-forget sync calls**

Move startup and connection-subscription calls in `orchestrator.js` through `handleConnectionState`/`ensureFresh`. `skillsCatalogAdapter` remains the only network/parser/downloader authority. Emit:

```js
{
  connectionId,
  connectionRevision,
  catalogRevision,
  lastSyncedAt,
  status: 'ready'
}
```

Never emit catalog items or URLs in the event.

- [ ] **Step 4: Add failing IPC/store race tests**

Assert initialization subscribes before snapshots, loads cached Skills immediately, starts `ensureFresh` without awaiting it, reloads list after a matching event, ignores an old organization/revision event, keeps cache on error, and maintains `skillsSyncState` independently of global `busy` and model errors. A transient `unreachable` state with the same persisted connection ID/revision must retain the catalog identity and cached list; only explicit `disconnected` clears renderer catalog items.

- [ ] **Step 5: Implement renderer lifecycle and page focus refresh**

Add `onSkillsCatalogChanged` to preload/renderer IPC. The store owns the unsubscribe handle. Change renderer `catalogIdentity` so `unreachable` retains the existing persisted connection identity without permitting a network sync. `SkillsCenter.vue` calls `serverConnection.ensureSkillsFresh()` on mount and on `window.focus`, removing the listener on unmount. Manual sync calls `ensureSkillsFresh({ force: true })`.

- [ ] **Step 6: Verify and commit**

```powershell
node --test test/server-skills-sync-coordinator.test.mjs test/server-connection-ipc.test.mjs test/server-connection-store.test.mjs test/server-skills-catalog.test.mjs
git diff --check
git add electron/serverConnection/skillsSyncCoordinator.js electron/orchestrator.js electron/serverConnection/ipc.js electron/preload.js src/ipc.js src/stores/serverConnection.js src/views/SkillsCenter.vue test/server-skills-sync-coordinator.test.mjs test/server-connection-ipc.test.mjs test/server-connection-store.test.mjs
git commit -m "feat(skills): auto-sync organization catalog"
```

---

### Task 7: Present organization/local views and direct CLI state controls

**Files:**
- Create: `src/components/skills/SkillCliStateMatrix.vue`
- Modify: `src/skillsPresentation.js`
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- `buildSkillsManagementCatalog({ packages, discovered, organizationVersions, includeBuiltIn })`.
- `groupSkillCatalogByOrigin(entries, { view, status })`.
- `buildSkillCliStateCells(entry, adapters)` returns desired state, actual state, enforcement, reason, and actionability.
- `SkillCliStateMatrix` emits `preview-change` with `{ packageId, scopeType, scopeKey, adapterId, desiredState }`.

- [ ] **Step 1: Write failing pure presentation tests**

Cover installed organization grouping, uninstalled/installed version merge, multiple server/organization keys, offline installed organization identity, local/Git/plugin/discovered/builtin groups, unresolved legacy identity, view filtering, and CLI state cells.

```js
assert.deepEqual(groups.map(group => group.key), [
  'organization:https://server.example.test:org-1',
  'github:acme/skills',
  'local:managed'
])
assert.equal(groups[0].entries[0].installed, true)
assert.notEqual(groups[0].key, 'local:unresolved')
```

- [ ] **Step 2: Run presentation tests and verify RED**

```powershell
node --test test/skills-presentation.test.mjs
```

- [ ] **Step 3: Implement origin-aware unified presentation functions**

Use `sourceIdentity` as the only organization classification source. Match an online organization version to an installed package only by normalized origin, organization ID, and catalog version/slug mapping already persisted. Retain existing repository normalization and status filtering for local groups.

- [ ] **Step 4: Add failing component/template assertions**

Assert literal tabs `全部`, `组织 Skills`, `本地 Skills`, separate `同步组织目录` and `重新扫描本地`, last sync/stale state, organization badges, and direct matrix actions. Assert normal CLI disable no longer calls `setSkillEnabled(installationId, false)` directly.

- [ ] **Step 5: Implement the focused matrix component and page layout**

`SkillsCenter.vue` owns active view/filter/detail state. `SkillCliStateMatrix.vue` renders all adapters and opens preview/apply confirmation:

```vue
<a-switch
  :checked="cell.desiredState !== 'disabled'"
  :disabled="cell.enforcementStatus === 'blocked' || saving"
  @change="$emit('preview-change', { ...identity, adapterId: cell.adapterId, desiredState: $event ? 'enabled' : 'disabled' })"
/>
```

Migration previews list impacted CLIs. Blocked cells show the stable reason and no false confirmation. Keep legacy location-level controls only under repair/advanced detail.

- [ ] **Step 6: Verify and commit**

```powershell
node --test test/skills-presentation.test.mjs test/skills-store.test.mjs
npm run build
git diff --check
git add src/components/skills/SkillCliStateMatrix.vue src/skillsPresentation.js src/views/SkillsCenter.vue test/skills-presentation.test.mjs
git commit -m "feat(skills): separate organization and local views"
```

---

### Task 8: Add trusted bounded batch preview and execution

**Files:**
- Create: `electron/skills/batchCoordinator.js`
- Create: `test/skills-batch-coordinator.test.mjs`
- Modify: `electron/orchestrator.js`
- Modify: `electron/skills/ipc.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/skills.js`
- Modify: `test/skills-ipc.test.mjs`
- Modify: `test/skills-renderer-ipc.test.mjs`
- Modify: `test/skills-store.test.mjs`

**Interfaces:**
- `createSkillsBatchCoordinator({ skillsService, organizationCatalog })` returns `preview(request)` and `apply({ ...request, expectedRevision })`.
- Item: `{ kind: 'package' | 'organization_version', id }`.
- Actions: `install_organization`, `update_organization`, `update_packages`, `set_cli_state`, `remove_projections`, `remove_packages`.
- IPC: `skills:preview-batch-action`, `skills:apply-batch-action`.

- [ ] **Step 1: Write failing batch coordinator tests**

Cover item-kind/action compatibility, one organization/scope context, catalog lifecycle, stable ordering, planner category reuse, normal partial failure, `PERSISTENCE_PENDING` abort, recovery-required abort, and the exact safe result DTO.

```js
assert.deepEqual(result, {
  succeeded: [{ item: { kind: 'package', id: 'a' }, packageId: 'a', action: 'set_cli_state', affectedAdapterIds: ['codex'] }],
  failed: [{ item: { kind: 'package', id: 'b' }, code: 'SKILL_DRIFTED', retryable: false }],
  skipped: [], recoveryRequired: [], aborted: null
})
```

- [ ] **Step 2: Run batch coordinator tests and verify RED**

```powershell
node --test test/skills-batch-coordinator.test.mjs
```

- [ ] **Step 3: Implement preview and sequential execution**

Resolve every item from trusted database/catalog state. Preview organization install/update without downloading. Apply organization items through existing verified `organizationCatalog.install/update`; apply package items through service commands. Revalidate the complete batch revision before the first mutation and each item snapshot before its mutation.

Sanitize ordinary errors to `{ code, retryable }`. Stop remaining items only for `SKILL_PERSISTENCE_PENDING`, `SKILL_PROJECTION_RECOVERY_REQUIRED`, or coordinator shutdown.

- [ ] **Step 4: Add failing IPC, bridge, and store tests**

Validate 1–200 unique items, known action, compatible item kind, one bounded target/scope payload, and a 64-character expected revision. Assert server origin, paths, hashes and organization fields never forward. Store must retain failed/skipped/remaining selections and support `retryFailedBatch()`.

- [ ] **Step 5: Wire coordinator in orchestrator and implement bridges**

Create the coordinator only after both `skillsService` and `serverSkillsCatalog` exist; pass it to `registerSkillsIpc`. Add preload, renderer IPC and Pinia methods with a separate `batchSaving`/`batchResult` state.

- [ ] **Step 6: Verify and commit**

```powershell
node --test test/skills-batch-coordinator.test.mjs test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs test/server-skills-catalog.test.mjs
git diff --check
git add electron/skills/batchCoordinator.js electron/orchestrator.js electron/skills/ipc.js electron/preload.js src/ipc.js src/stores/skills.js test/skills-batch-coordinator.test.mjs test/skills-ipc.test.mjs test/skills-renderer-ipc.test.mjs test/skills-store.test.mjs
git commit -m "feat(skills): add bounded bulk management"
```

---

### Task 9: Add filtered selection and batch-management UI

**Files:**
- Create: `src/components/skills/SkillsBatchActionBar.vue`
- Modify: `src/skillsPresentation.js`
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/skills-presentation.test.mjs`

**Interfaces:**
- `resolveSkillManagementSelection({ visibleEntries, selectedItems, view, organizationKey, scopeKey })`.
- `buildSkillsBatchRequest({ action, selection, adapterId, desiredState, targets })`.
- `SkillsBatchActionBar` emits preview/apply/clear/retry events and never constructs paths or provenance.

- [ ] **Step 1: Write failing selection and request-builder tests**

Cover individual selection, filtered select-all, hidden exclusions, organization/view/scope reset, unavailable item exclusion, organization version item identity, package identity, deterministic order, and action compatibility.

```js
const selection = resolveSkillManagementSelection({
  visibleEntries: [packageEntry('a'), packageEntry('b')],
  selectedItems: [], view: 'local', organizationKey: null, scopeKey: '*'
})
assert.deepEqual(selection.selectAllItems, [
  { kind: 'package', id: 'a' }, { kind: 'package', id: 'b' }
])
```

- [ ] **Step 2: Run presentation tests and verify RED**

```powershell
node --test test/skills-presentation.test.mjs
```

- [ ] **Step 3: Implement selection helpers and batch action bar**

The action bar displays selected count and actions allowed for the current homogeneous context. Separate `移除投影` from danger-zone `移除受管包`. The preview modal groups `direct`, `migration_required`, `blocked`, `conflict`, and `noop` items.

- [ ] **Step 4: Integrate batch UI and result retention**

Keep failed, skipped and `aborted.remainingItems` selected after completion; clear successful items. Provide “仅重试失败项”. Clear out-of-context selection when active view, organization group or project scope changes. Prompt affected session restart once after all successful items.

- [ ] **Step 5: Add template assertions and verify production build**

Assert multi-select checkboxes, visible-result select-all, batch preview categories, retry-failed control, separate destructive confirmation, partial-result counts, keyboard focus labels, and disabled/loading states.

Run:

```powershell
node --test test/skills-presentation.test.mjs test/skills-store.test.mjs
npm run build
git diff --check
```

- [ ] **Step 6: Commit Task 9**

```powershell
git add src/components/skills/SkillsBatchActionBar.vue src/skillsPresentation.js src/views/SkillsCenter.vue test/skills-presentation.test.mjs
git commit -m "feat(skills): add filtered bulk actions"
```

---

### Task 10: Update delivery documentation and run every gate

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/release-acceptance.md`
- Modify: `docs/ucli-client-protocol.md`
- Modify: `docs/ucli-client-registration-upgrade.md`
- Modify: `test/release-verification.test.mjs`

**Interfaces:**
- Documents organization cache/sync semantics, durable provenance, strict CLI disable limitations, batch outcomes, and recovery behavior without secrets.

- [ ] **Step 1: Update documentation from verified behavior**

Record:

- organization catalog cache-first plus five-minute background refresh;
- explicit disconnect versus temporary network failure;
- organization provenance retention after install;
- `enabled|disabled|inherit` semantics;
- unsupported inherited isolation is blocked;
- batch item/result contracts and persistence abort behavior;
- separation of disable, projection removal, and managed-package removal.

Do not include real organization IDs, server URLs, local user paths, tokens, headers, response bodies, or test credentials.

Add a release-verification assertion that reads the three delivery documents and requires the stable concepts `组织 Skills`, `本地 Skills`, `inherit`, `SKILL_CLI_ISOLATION_UNSUPPORTED`, and `批量`. This makes missing delivery documentation fail the release gate.

- [ ] **Step 2: Run the focused Skills and server gates serially**

```powershell
node --test --test-concurrency=1 `
  test/skills-db.test.mjs `
  test/skills-metadata-migration.test.mjs `
  test/skills-projection-planner.test.mjs `
  test/skills-state-coordinator.test.mjs `
  test/skills-service.test.mjs `
  test/skills-contracts.test.mjs `
  test/skills-ipc.test.mjs `
  test/skills-renderer-ipc.test.mjs `
  test/skills-store.test.mjs `
  test/skills-presentation.test.mjs `
  test/skills-batch-coordinator.test.mjs `
  test/server-skills-sync-coordinator.test.mjs `
  test/server-skills-catalog.test.mjs `
  test/server-connection-ipc.test.mjs `
  test/server-connection-store.test.mjs
```

Expected: zero failures and zero unexpected skips.

- [ ] **Step 3: Run the fixed server contract and release documentation gates**

```powershell
node --test --test-concurrency=1 `
  test/server-contract-fixtures.test.mjs `
  test/server-device-grant-client.test.mjs `
  test/server-connection-manager.test.mjs `
  test/server-skills-catalog.test.mjs `
  test/release-verification.test.mjs
```

Expected: all fixed contract tests pass; no live smoke is requested by this plan.

- [ ] **Step 4: Run full verification**

```powershell
npm test
npm run build
npm run verify:release
git diff --check
git status --short
```

Expected: full test suite, production build, and release verification pass. Only intended documentation changes remain uncommitted before the final commit.

- [ ] **Step 5: Perform Windows DEV acceptance without external mutations**

Start `npm run dev` and verify with an existing connected test account and existing local fixtures:

1. Organization catalog cache appears before network refresh completes.
2. A matching sync event refreshes the page without clicking the button.
3. Installed organization Skill remains in its organization group.
4. Local Skills remain in local/Git/plugin/discovered/builtin groups.
5. Direct CLI disable works; unsupported inherited-only disable is blocked with an explanation.
6. Provider-disable migration preserves the selected consumer.
7. Filtered select-all excludes hidden items.
8. Batch partial failure retains only failed/skipped items.
9. Disable never deletes the canonical package; destructive removal has a separate confirmation.
10. Console has no new uncaught errors or repeated warning loop.

Do not create a new service authorization, consume a one-time link, install an untrusted organization ZIP, or run a real remote update solely for this UI acceptance.

- [ ] **Step 6: Commit documentation and final evidence**

```powershell
git add CHANGELOG.md docs/release-acceptance.md docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md test/release-verification.test.mjs
git commit -m "docs(release): record Skills management upgrade"
git status --short
```

Expected: worktree clean. Report every task commit, focused gate, full test count, build, release verification, DEV acceptance, and any capability combination intentionally blocked by strict isolation.
