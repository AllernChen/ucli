# UCLI 0.12.0 Unified Service Profile Multi-Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-model/per-adapter server profiles with one cross-adapter service profile per server organization, with explicit child-model selection persisted for defaults and sessions.

**Architecture:** Add a normalized service-profile/service-model persistence layer and migrate legacy projections transactionally. Keep protocol compatibility at the model boundary, resolve every managed launch from an explicit `(serviceProfileId, modelId, adapterId)` tuple, isolate Codex runtime artifacts per model, and present the same service profile across Codex and Claude while filtering selectable models by declared protocol.

**Tech Stack:** Electron, Node.js ES modules, SQLite, Vue 3, Pinia, Node test runner, PowerShell

**Spec:** `docs/superpowers/specs/2026-08-31-ucli-service-profile-multi-model-design.md`

## Global Constraints

- Work only in the UCLI client repository. Do not modify `ucli-server`.
- Follow red-green-refactor for every behavioral change: write a focused failing test, run it and confirm the intended failure, implement the minimum change, then rerun the focused test.
- Public protocols remain exactly `openai_responses`, `openai_chat`, and `anthropic_messages`.
- Codex requires `openai_responses`; Claude requires `anthropic_messages`. `openai_chat` remains catalog-visible but is not launchable by either managed adapter in 0.12.0.
- Never select `models[0]` and never infer protocol from model ID, display name, vendor, or catalog order.
- Do not persist or log URL fragments, tokens, Authorization/Cookie values, vendor keys, request/response bodies, or full headers.
- Preserve user-owned untracked and unrelated modified files.
- Do not run live smoke or consume a Device Grant URL as part of this plan.
- Keep local profiles and local login state behavior unchanged.
- Run `git diff --check` before every commit.

---

## Task 1: Introduce the unified service-profile catalog domain

**Files:**

- Create: `electron/serverConnection/serviceProfileCatalog.js`
- Create: `test/server-service-profile-catalog.test.mjs`

- [ ] **Step 1: Write failing tests for stable identity and normalized child models**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildServiceProfileCatalog,
  stableServiceProfileId,
} from '../electron/serverConnection/serviceProfileCatalog.js'

test('service profile identity excludes model and adapter', () => {
  const left = stableServiceProfileId({
    serverOrigin: 'HTTP://10.44.100.100/',
    organizationId: 'org-1',
  })
  const right = stableServiceProfileId({
    serverOrigin: 'http://10.44.100.100',
    organizationId: 'org-1',
  })
  assert.equal(left, right)
})

test('catalog retains all declared public protocols without inventing compatibility', () => {
  const catalog = buildServiceProfileCatalog({
    serverOrigin: 'http://10.44.100.100',
    organization: { id: 'org-1', name: 'Product R&D' },
    connectionRevision: 'revision-1',
    models: [
      { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'] },
      { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] },
    ],
  })
  assert.deepEqual(catalog.profile.supportedAdapterIds, ['codex', 'claude'])
  assert.deepEqual(catalog.models.map((model) => model.protocols), [
    ['openai_responses'],
    ['openai_chat'],
    ['anthropic_messages'],
  ])
})
```

- [ ] **Step 2: Run the new test and confirm it fails because the module does not exist**

Run:

```powershell
node --test test/server-service-profile-catalog.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `serviceProfileCatalog.js`.

- [ ] **Step 3: Implement stable IDs, strict validation, and protocol compatibility**

Export this narrow API:

```js
export const SERVICE_ADAPTER_PROTOCOL = Object.freeze({
  codex: 'openai_responses',
  claude: 'anthropic_messages',
})

export function stableServiceProfileId({ serverOrigin, organizationId })
export function serviceModelArtifactId({ serviceProfileId, modelId })
export function buildServiceProfileCatalog({ serverOrigin, organization, models, connectionRevision })
export function compatibleServiceModels(profile, adapterId)
export function requireServiceModel(profile, { adapterId, modelId })
```

Use these stable errors:

```js
const ERROR_CODES = Object.freeze({
  invalidModel: 'INVALID_SERVER_MODEL',
  modelRequired: 'PROFILE_MODEL_REQUIRED',
  modelUnavailable: 'PROFILE_MODEL_UNAVAILABLE',
  protocolUnavailable: 'PROFILE_MODEL_PROTOCOL_UNAVAILABLE',
})
```

Normalize origin with `new URL(serverOrigin).origin`, require a non-empty organization ID, require positive safe-integer `contextSize`, allow only the three public protocols, deduplicate protocols without changing their declared order, and derive `supportedAdapterIds` from child capabilities.

- [ ] **Step 4: Add failing cases for missing model, unavailable model, and incompatible adapter**

```js
assert.throws(
  () => requireServiceModel(profile, { adapterId: 'codex', modelId: null }),
  (error) => error.code === 'PROFILE_MODEL_REQUIRED',
)
assert.throws(
  () => requireServiceModel(profile, { adapterId: 'codex', modelId: 'removed' }),
  (error) => error.code === 'PROFILE_MODEL_UNAVAILABLE',
)
assert.throws(
  () => requireServiceModel(profile, { adapterId: 'claude', modelId: 'responses' }),
  (error) => error.code === 'PROFILE_MODEL_PROTOCOL_UNAVAILABLE',
)
```

- [ ] **Step 5: Run the focused catalog tests**

```powershell
node --test test/server-service-profile-catalog.test.mjs
```

Expected: all catalog tests PASS.

- [ ] **Step 6: Commit the domain module**

```powershell
git diff --check
git add electron/serverConnection/serviceProfileCatalog.js test/server-service-profile-catalog.test.mjs
git commit -m "feat(server): model unified service profile catalog"
```

---

## Task 2: Add normalized persistence and migrate legacy server profiles

**Files:**

- Modify: `electron/persistence/db.js`
- Modify: `test/server-connection-db.test.mjs`
- Modify: `test/ai-cli-profile-db.test.mjs`
- Modify: `test/server-credential-store.test.mjs`

- [ ] **Step 1: Write failing schema tests for one profile with multiple child models**

Add a fixture that opens the database, replaces a catalog, closes it, reopens it, and asserts:

```js
assert.deepEqual(db.listServerServiceProfiles(), [{
  profileId: serviceProfileId,
  serverOrigin: 'http://10.44.100.100',
  organizationId: 'org-1',
  organizationName: 'Product R&D',
  connectionRevision: 'revision-1',
  availabilityStatus: 'available',
}])
assert.deepEqual(
  db.listServerServiceModels(serviceProfileId).map((row) => row.modelId),
  ['chat', 'claude', 'responses'],
)
```

Also assert that an AI CLI binding round-trips `modelId`, while a local-profile binding round-trips `modelId: null`.

- [ ] **Step 2: Run the persistence tests and confirm missing-method failures**

```powershell
node --test test/server-connection-db.test.mjs test/ai-cli-profile-db.test.mjs test/server-credential-store.test.mjs
```

Expected: FAIL because `replaceServerServiceCatalog` and the new list methods are absent.

- [ ] **Step 3: Add the normalized schema and row mappers**

Create these tables in `_ensureSchema()`:

```sql
CREATE TABLE IF NOT EXISTS server_service_profiles (
  profile_id TEXT PRIMARY KEY,
  server_origin TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  availability_status TEXT NOT NULL,
  UNIQUE(server_origin, organization_id)
);

CREATE TABLE IF NOT EXISTS server_service_models (
  service_profile_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_size INTEGER NOT NULL,
  protocols_json TEXT NOT NULL,
  availability_status TEXT NOT NULL,
  catalog_order INTEGER NOT NULL,
  codex_file_sha256 TEXT,
  PRIMARY KEY(service_profile_id, model_id),
  FOREIGN KEY(service_profile_id) REFERENCES server_service_profiles(profile_id) ON DELETE CASCADE
);
```

Use `PRAGMA table_info(ai_cli_profile_bindings)` and add `model_id TEXT` only when absent. Map `protocols_json` through strict JSON array parsing and return `modelId` from the binding mapper.

- [ ] **Step 4: Implement transactional catalog APIs**

Add these methods:

```js
listServerServiceProfiles()
listServerServiceModels(serviceProfileId = null)
replaceServerServiceCatalog({ profile, models })
updateServerServiceModelArtifact({ serviceProfileId, modelId, codexFileSha256 })
clearServerServiceCatalog()
```

`replaceServerServiceCatalog` must run in one transaction, upsert the profile, replace its complete child-model set, retain no removed model rows, and never touch another organization profile.

- [ ] **Step 5: Write a legacy database fixture and a failing migration test**

Build the legacy fixture with `server_model_profiles`, sessions, and bindings representing:

```js
[
  { modelId: 'shared', adapterId: 'codex', profileId: 'legacy-codex' },
  { modelId: 'shared', adapterId: 'claude', profileId: 'legacy-claude' },
  { modelId: 'responses-only', adapterId: 'codex', profileId: 'legacy-responses' },
]
```

Assert after opening the upgraded database:

- one service profile exists for the origin/organization;
- `shared` has both `openai_responses` and `anthropic_messages`;
- sessions retain their model and point to the unified profile;
- uniquely mapped bindings contain both unified `profileId` and `modelId`;
- an ambiguous or malformed binding is cleared;
- reopening the database leaves identical rows.

- [ ] **Step 6: Implement the additive, idempotent legacy migration**

Inside one transaction:

1. Detect `server_model_profiles` through `sqlite_master`.
2. Group valid legacy rows by normalized `(server_origin, organization_id)`.
3. Derive the unified profile ID with `stableServiceProfileId`.
4. Group child rows by `model_id`; map `codex` to `openai_responses` and `claude` to `anthropic_messages`, then union protocols.
5. Update uniquely mapped `sessions.profile_id` and preserve `sessions.model`.
6. Update uniquely mapped bindings with the unified profile and model; delete bindings that cannot be mapped safely.
7. Remove the legacy table only after all writes succeed.

Do not invent a protocol for any unknown adapter, and do not delete historical sessions when their selection is unresolved.

- [ ] **Step 7: Update connection cleanup to clear normalized catalog rows**

Make both `clearServerConnections()` and `clearCurrentServerConnection()` remove normalized service-profile/model rows in the same transaction as existing connection state. Preserve sessions and local profiles.

- [ ] **Step 8: Run the focused persistence suite**

```powershell
node --test test/server-connection-db.test.mjs test/ai-cli-profile-db.test.mjs test/server-credential-store.test.mjs
```

Expected: all focused persistence tests PASS, including reopen and rollback cases.

- [ ] **Step 9: Commit normalized storage**

```powershell
git diff --check
git add electron/persistence/db.js test/server-connection-db.test.mjs test/ai-cli-profile-db.test.mjs test/server-credential-store.test.mjs
git commit -m "feat(storage): migrate server service profiles"
```

---

## Task 3: Project and launch an explicitly selected service model

**Files:**

- Modify: `electron/serverConnection/modelProjection.js`
- Modify: `electron/aiCliProfiles/codexProfileFile.js`
- Modify: `test/server-model-projection.test.mjs`
- Modify: `test/codex-profile-file.test.mjs`
- Modify: `test/server-connection-db.test.mjs`

- [ ] **Step 1: Replace per-model projection expectations with one cross-adapter DTO**

Write a failing test that synchronizes three models and expects:

```js
assert.equal(profiles.length, 1)
assert.deepEqual(profiles[0].supportedAdapterIds, ['codex', 'claude'])
assert.deepEqual(profiles[0].models.map(({ id, protocols }) => ({ id, protocols })), [
  { id: 'responses', protocols: ['openai_responses'] },
  { id: 'chat', protocols: ['openai_chat'] },
  { id: 'claude', protocols: ['anthropic_messages'] },
])
```

Add launch tests proving that `prepareRuntime` rejects a missing model and rejects a protocol-incompatible model.

- [ ] **Step 2: Run projection tests and confirm the old per-adapter shape fails**

```powershell
node --test test/server-model-projection.test.mjs
```

Expected: FAIL because the current projection returns one profile per model/adapter and accepts only `profileId`.

- [ ] **Step 3: Refactor projection synchronization onto the catalog module**

Change the public runtime contract to:

```js
listProfiles()
prepareRuntime({ serviceProfileId, modelId, adapterId, sessionId })
reconcileRuntimeAuthorities({ serviceProfileId, connectionRevision, models })
```

`listProfiles()` returns one safe cross-adapter profile with nested models. `prepareRuntime` must call `requireServiceModel` and must key session authority by all of:

```js
{ serviceProfileId, modelId, adapterId, connectionRevision }
```

Reconciliation revokes a session only when its service profile, selected model, adapter protocol, or connection revision is no longer valid.

- [ ] **Step 4: Add a failing Codex concurrency test**

Prepare two Codex sessions on the same service profile with different Responses models and assert:

```js
assert.notEqual(first.configPath, second.configPath)
assert.notEqual(first.artifactId, second.artifactId)
assert.equal(first.modelId, 'responses-a')
assert.equal(second.modelId, 'responses-b')
```

Also assert that cleaning stale files removes only owned server config files whose artifact IDs are absent from the valid set.

- [ ] **Step 5: Isolate Codex artifacts per service profile and model**

Derive the 32-character lowercase-hex file identity from:

```js
serviceModelArtifactId({ serviceProfileId, modelId })
```

Keep the owned filename form `ucli-server-{artifactId}.config.toml`. Write the explicitly selected model into the TOML and pass the model explicitly at launch. Store `codexFileSha256` on the child model row through `updateServerServiceModelArtifact`, never on the parent profile.

For Claude, keep the loopback `/anthropic` endpoint and pass the selected model explicitly. Do not generate a native file.

- [ ] **Step 6: Run projection and artifact tests**

```powershell
node --test test/server-model-projection.test.mjs test/codex-profile-file.test.mjs test/server-connection-db.test.mjs
```

Expected: PASS for projection, protocol rejection, authority reconciliation, concurrent Codex artifacts, and safe stale-file cleanup.

- [ ] **Step 7: Commit runtime projection changes**

```powershell
git diff --check
git add electron/serverConnection/modelProjection.js electron/aiCliProfiles/codexProfileFile.js test/server-model-projection.test.mjs test/codex-profile-file.test.mjs test/server-connection-db.test.mjs
git commit -m "feat(server): launch selected service profile models"
```

---

## Task 4: Resolve model-aware defaults and expose safe IPC DTOs

**Files:**

- Modify: `electron/aiCliProfiles/profileResolver.js`
- Modify: `electron/aiCliProfiles/profileService.js`
- Modify: `electron/aiCliProfiles/ipc.js`
- Modify: `electron/persistence/db.js`
- Modify: `test/ai-cli-profile-db.test.mjs`
- Modify: `test/ai-cli-profile-service.test.mjs`
- Modify: `test/ai-cli-profile-ipc.test.mjs`
- Modify: `test/claude-profile-service.test.mjs`
- Modify: `test/claude-profile-launch-coordinator.test.mjs`

- [ ] **Step 1: Write failing resolver tests for explicit, project, app, and missing-model selections**

Use this result contract:

```js
{
  profileId,
  model,
  profile,
  selectionSource: 'explicit' | 'project' | 'app' | 'none',
  status: 'ready' | 'model-required' | 'model-unavailable' | 'protocol-unavailable',
  canStart,
}
```

Assert precedence is explicit selection, then project binding, then app binding. A service binding without `modelId` must resolve to `model-required`; a local profile binding must continue to resolve with `model: null`.

- [ ] **Step 2: Run resolver/service tests and confirm profile-only behavior fails**

```powershell
node --test test/ai-cli-profile-service.test.mjs test/claude-profile-service.test.mjs
```

Expected: FAIL because selection currently carries only `profileId`.

- [ ] **Step 3: Implement selection-aware resolution and bindings**

Change service APIs to:

```js
setBinding({ scopeType, scopeKey, adapterId, profileId, model })
resolveSessionProfile({ adapterId, projectKey, explicitProfileId, explicitModel })
resolveLaunchProfile({ sessionId, adapterId, profileId, model })
```

For a service profile, require `model`, require the adapter in `supportedAdapterIds`, and finish with model-level protocol validation. For a local profile, require `model === null`. Persist server bindings as `profile_id + model_id` and local bindings as `profile_id + NULL`.

Include the selected model in Claude launch stamps so changing only the model invalidates the prior stamp.

- [ ] **Step 4: Write failing IPC DTO tests**

Assert a service profile DTO contains only:

```js
{
  id,
  source: 'server',
  readOnly: true,
  serverOrigin,
  organization: { id, name },
  availabilityStatus,
  supportedAdapterIds,
  models: [{ id, displayName, contextSize, protocols, availabilityStatus }],
}
```

Assert it omits connection revision, artifact hashes, tokens, headers, credentials, and native config contents.

- [ ] **Step 5: Update IPC validation and safe serialization**

Accept `model` only as a non-empty string or `null`. Reject unknown fields before calling the service. Extend `safeProfile` with the approved server fields and nested safe model fields. Preserve existing local-profile serialization.

- [ ] **Step 6: Run profile, IPC, and Claude coordination tests**

```powershell
node --test test/ai-cli-profile-db.test.mjs test/ai-cli-profile-service.test.mjs test/ai-cli-profile-ipc.test.mjs test/claude-profile-service.test.mjs test/claude-profile-launch-coordinator.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit model-aware resolution**

```powershell
git diff --check
git add electron/aiCliProfiles/profileResolver.js electron/aiCliProfiles/profileService.js electron/aiCliProfiles/ipc.js electron/persistence/db.js test/ai-cli-profile-db.test.mjs test/ai-cli-profile-service.test.mjs test/ai-cli-profile-ipc.test.mjs test/claude-profile-service.test.mjs test/claude-profile-launch-coordinator.test.mjs
git commit -m "feat(profiles): resolve service profile model bindings"
```

---

## Task 5: Persist session selections and enforce them in orchestration

**Files:**

- Modify: `electron/orchestrator.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/stores/sessions.js`
- Modify: `test/ai-cli-profile-session-template.test.mjs`
- Modify: `test/server-connection-ipc.test.mjs`
- Modify: `test/claude-profile-launch.test.mjs`
- Modify: `test/server-model-projection.test.mjs`

- [ ] **Step 1: Write failing session IPC tests for atomic profile/model updates**

Exercise the renderer API as:

```js
await window.electronAPI.aiCliProfiles.setSessionProfile(sessionId, {
  profileId: serviceProfileId,
  model: 'responses-a',
})
```

Assert the database session row changes both `profile_id` and `model` in one operation. Reject a missing model for a service profile, an extraneous model for a local profile, and a model incompatible with the session adapter.

- [ ] **Step 2: Run session and IPC tests and confirm the old scalar API fails**

```powershell
node --test test/ai-cli-profile-session-template.test.mjs test/server-connection-ipc.test.mjs
```

Expected: FAIL because the current API accepts only a profile ID.

- [ ] **Step 3: Change the bridge and orchestrator to a selection object**

Expose and handle:

```js
setSessionProfile(sessionId, { profileId, model })
```

Validate the tuple in the main process, resolve the session adapter, persist both values, and return the safe resolved selection. Do not split the writes across two independent database calls.

- [ ] **Step 4: Add failing managed-launch tests**

Assert Codex and Claude launch preparation passes all four required values:

```js
{
  serviceProfileId: session.profileId,
  modelId: session.model,
  adapterId: session.adapterId,
  sessionId: session.id,
}
```

Assert missing, removed, unavailable, and incompatible models block launch before starting a child process. Assert summary reissue uses the same saved tuple.

- [ ] **Step 5: Update orchestration and remove service-model fallback**

Update Codex preparation, Claude preparation, Claude stamp/arm, summary reissue, and session-profile setters to carry the explicit model. Include model in runtime revisions and launch stamps.

In `src/stores/sessions.js`, do not evaluate `adapter.models[0]` for a service-profile session. Preserve any ordinary local-adapter default behavior only on the local-profile path.

- [ ] **Step 6: Run session/runtime integration tests**

```powershell
node --test test/ai-cli-profile-session-template.test.mjs test/server-connection-ipc.test.mjs test/claude-profile-launch.test.mjs test/server-model-projection.test.mjs
```

Expected: all tests PASS and no launch path guesses a service model.

- [ ] **Step 7: Commit session selection integration**

```powershell
git diff --check
git add electron/orchestrator.js electron/preload.js src/ipc.js src/stores/sessions.js test/ai-cli-profile-session-template.test.mjs test/server-connection-ipc.test.mjs test/claude-profile-launch.test.mjs test/server-model-projection.test.mjs
git commit -m "feat(sessions): persist service profile model selections"
```

---

## Task 6: Separate connection, model-catalog, and Skills errors

**Files:**

- Modify: `src/stores/serverConnection.js`
- Modify: `src/components/settings/ServerConnectionPanel.vue`
- Modify: `src/views/SkillsCenter.vue`
- Modify: `test/server-connection-store.test.mjs`
- Modify: `test/server-settings-template.test.mjs`

- [ ] **Step 1: Write a failing store test for successful connect plus failed catalog sync**

Mock confirm/retry so core connection succeeds, model sync rejects, and Skills sync resolves. Assert:

```js
assert.equal(store.status, 'connected')
assert.equal(store.connectionError, null)
assert.match(store.modelCatalogError, /服务端操作失败/)
assert.equal(store.skillsCatalogError, null)
```

Add the inverse Skills failure case and assert one action never clears another domain's error.

- [ ] **Step 2: Run the store test and confirm the shared error state fails**

```powershell
node --test test/server-connection-store.test.mjs
```

Expected: FAIL because the store currently exposes one shared `error` and rejects the combined operation.

- [ ] **Step 3: Partition store state and make connection success authoritative**

Replace shared error state with:

```js
connectionError: null,
modelCatalogError: null,
skillsCatalogError: null,
```

Keep fixed, sanitized public fallbacks. After confirm/retry returns a successful connection, commit connected state first, then run:

```js
await Promise.allSettled([syncModels(), syncSkills()])
```

Do not call `syncConnection()` inside this post-connect pair. Return connection success even if either catalog fails. Each action clears and sets only its own error field.

- [ ] **Step 4: Update settings and Skills error presentation**

`ServerConnectionPanel.vue` displays `connectionError` beside connection actions and separately reports model/Skills sync outcomes. `src/views/SkillsCenter.vue` displays only `skillsCatalogError`. A model catalog failure must not render a red connection failure banner over an already connected status.

- [ ] **Step 5: Run store and template tests**

```powershell
node --test test/server-connection-store.test.mjs test/server-settings-template.test.mjs
```

Expected: PASS for success/error partition and sanitized presentation.

- [ ] **Step 6: Commit the error-boundary fix**

```powershell
git diff --check
git add src/stores/serverConnection.js src/components/settings/ServerConnectionPanel.vue src/views/SkillsCenter.vue test/server-connection-store.test.mjs test/server-settings-template.test.mjs
git commit -m "fix(server): separate connection catalog errors"
```

---

## Task 7: Present one service profile and select model-aware defaults

**Files:**

- Create: `src/serviceProfileSelection.js`
- Create: `src/components/profiles/ServerServiceProfileCard.vue`
- Create: `test/service-profile-selection.test.mjs`
- Modify: `src/views/ProfileCenter.vue`
- Modify: `src/stores/aiCliProfiles.js`
- Modify: `src/profilePresentation.js`
- Modify: `test/ai-cli-profile-template.test.mjs`
- Modify: `test/ai-cli-profile-presentation.test.mjs`

- [ ] **Step 1: Write failing pure-selection tests**

Define and test:

```js
compatibleModelsForAdapter(profile, adapterId)
validateServiceProfileSelection({ profile, adapterId, modelId })
describeModelProtocols(protocols)
```

Assert Codex sees only Responses models, Claude sees only Anthropic models, Chat-only models remain displayable but are absent from both selectable lists, and no helper returns a first-item default.

- [ ] **Step 2: Run the helper test and confirm the module is absent**

```powershell
node --test test/service-profile-selection.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic filtering and validation**

Use `SERVICE_ADAPTER_PROTOCOL` semantics without importing Electron-only modules into the renderer. Return models in catalog order for display, but require an exact `modelId` for selection. Return stable UI states:

```js
{ valid: false, reason: 'model-required' }
{ valid: false, reason: 'model-unavailable' }
{ valid: false, reason: 'protocol-unavailable' }
{ valid: true, model }
```

- [ ] **Step 4: Write failing profile-center template assertions**

Assert the page renders:

- one independent “服务档案” section;
- one card per service profile, not per adapter/model;
- nested model rows with protocol, context size, and availability;
- an adapter-aware default dialog containing separate profile and model controls;
- `modelCatalogError` with a retry action;
- local profile sections unchanged.

- [ ] **Step 5: Build the service-profile card and default-selection flow**

`ServerServiceProfileCard.vue` receives a safe service profile DTO and emits selection intents only. `ProfileCenter.vue` owns adapter context and binding submission. Save defaults as:

```js
await aiCliProfiles.setBinding({
  scopeType,
  scopeKey,
  adapterId,
  profileId: selectedProfileId,
  model: selectedModelId,
})
```

Disable save until the exact model is valid. Do not preselect the first compatible model. Keep service profiles read-only and keep local profile CRUD unchanged.

- [ ] **Step 6: Run presentation tests**

```powershell
node --test test/service-profile-selection.test.mjs test/ai-cli-profile-template.test.mjs test/ai-cli-profile-presentation.test.mjs
```

Expected: all profile selection and rendering tests PASS.

- [ ] **Step 7: Commit the unified profile UI**

```powershell
git diff --check
git add src/serviceProfileSelection.js src/components/profiles/ServerServiceProfileCard.vue src/views/ProfileCenter.vue src/stores/aiCliProfiles.js src/profilePresentation.js test/service-profile-selection.test.mjs test/ai-cli-profile-template.test.mjs test/ai-cli-profile-presentation.test.mjs
git commit -m "feat(profiles): present unified service profiles"
```

---

## Task 8: Require explicit model selection for new, imported, and existing sessions

**Files:**

- Modify: `src/components/NewSessionDialog.vue`
- Modify: `src/components/SessionConfigModal.vue`
- Modify: `src/views/SessionDetail.vue`
- Modify: `src/sessionConfigPresentation.js`
- Modify: `src/stores/sessions.js`
- Modify: `test/ai-cli-profile-session-template.test.mjs`
- Modify: `test/session-config-presentation.test.mjs`
- Modify: `test/session-config-template.test.mjs`

- [ ] **Step 1: Write failing presentation tests for model-required and historical states**

Cover these cases:

```js
{ profileId: serviceProfileId, model: null, canStart: false, reason: 'model-required' }
{ profileId: serviceProfileId, model: 'removed', canStart: false, reason: 'model-unavailable' }
{ profileId: serviceProfileId, model: 'responses', canStart: true, reason: null }
```

For imported history, assert the saved model remains visible even when absent from the current catalog, and “保留历史选择” does not silently replace it.

- [ ] **Step 2: Run session presentation tests and confirm missing explicit selection behavior**

```powershell
node --test test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs
```

Expected: FAIL because the current dialogs treat profile choice as sufficient and new-session creation can fall back to an adapter model.

- [ ] **Step 3: Add separate service-profile and model controls to new/import flows**

When the chosen profile source is `server`:

1. Render a service-profile selector.
2. Render only models compatible with the active adapter.
3. Use a valid project/app `(profileId, modelId)` binding when present.
4. Otherwise leave model unselected and block submit.
5. Preserve an imported historical model until the user explicitly changes it.

When the chosen profile is local, keep existing model behavior and submit `model: null` for the profile binding tuple.

- [ ] **Step 4: Update existing-session switching and restart semantics**

`src/components/SessionConfigModal.vue` submits:

```js
await setSessionProfile(session.id, {
  profileId: selectedProfileId,
  model: selectedModelId,
})
```

Treat a profile-only change and a model-only change as runtime-affecting. If the session is active, require the existing restart confirmation path. A removed historical model remains displayed, but start/restart is disabled until the user chooses an available compatible model.

- [ ] **Step 5: Update both SessionDetail import paths**

Audit the initial import and re-import/secondary import path in `SessionDetail.vue`. Both must pass the explicit saved model, apply the same validation, and avoid catalog-order fallback.

- [ ] **Step 6: Run session UI and store tests**

```powershell
node --test test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs test/service-profile-selection.test.mjs
```

Expected: PASS for new, imported, existing, removed-model, and model-only switch cases.

- [ ] **Step 7: Commit session UI selection**

```powershell
git diff --check
git add src/components/NewSessionDialog.vue src/components/SessionConfigModal.vue src/views/SessionDetail.vue src/sessionConfigPresentation.js src/stores/sessions.js test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs
git commit -m "feat(sessions): select service profile models"
```

---

## Task 9: Update protocol/release documentation and run all local gates

**Files:**

- Modify: `docs/release-acceptance.md`
- Modify: `docs/ucli-client-protocol.md`
- Modify: `docs/ucli-client-registration-upgrade.md`

- [ ] **Step 1: Update the protocol document**

Document the client-domain projection precisely:

- one service profile per normalized server origin and organization;
- nested model catalog with explicit public protocols;
- adapter compatibility (`codex → openai_responses`, `claude → anthropic_messages`);
- explicit `(serviceProfileId, modelId)` session/default selection;
- no model/protocol inference;
- fixed Gateway endpoints and no-store/request-ID diagnostics remain unchanged.

- [ ] **Step 2: Update the registration upgrade document**

Add the normalized database migration, fail-closed ambiguous binding behavior, historical session preservation, per-model Codex artifact isolation, error partitioning, and rollback boundaries. State that no service authorization or server change is required for this client-only migration.

- [ ] **Step 3: Update release acceptance without inventing live evidence**

Record the local implementation acceptance gates and the architecture change. Preserve the existing live-smoke record exactly; do not claim that this post-smoke UI/domain refactor has consumed a new authorization or completed another live smoke.

- [ ] **Step 4: Run the fixed server contract gate**

```powershell
node --test --test-concurrency=1 `
  test/server-contract-fixtures.test.mjs `
  test/server-device-grant-client.test.mjs `
  test/server-connection-manager.test.mjs `
  test/server-skills-catalog.test.mjs `
  test/server-model-projection.test.mjs
```

Expected: all fixed contract tests PASS with `0 failed / 0 skipped`.

- [ ] **Step 5: Run focused implementation gates**

```powershell
node --test --test-concurrency=1 `
  test/server-service-profile-catalog.test.mjs `
  test/server-connection-db.test.mjs `
  test/ai-cli-profile-db.test.mjs `
  test/ai-cli-profile-service.test.mjs `
  test/ai-cli-profile-ipc.test.mjs `
  test/ai-cli-profile-session-template.test.mjs `
  test/claude-profile-service.test.mjs `
  test/claude-profile-launch-coordinator.test.mjs `
  test/claude-profile-launch.test.mjs `
  test/server-connection-store.test.mjs `
  test/server-settings-template.test.mjs `
  test/service-profile-selection.test.mjs `
  test/ai-cli-profile-template.test.mjs `
  test/ai-cli-profile-presentation.test.mjs `
  test/session-config-presentation.test.mjs `
  test/session-config-template.test.mjs
```

Expected: all focused implementation tests PASS with `0 failed`.

- [ ] **Step 6: Run the complete client suite and release gates**

```powershell
npm test
git diff --check
node --test --test-concurrency=1 test/release-verification.test.mjs test/server-contract-fixtures.test.mjs
npm run verify:release
```

Expected: every command exits `0`; no unexpected skip is introduced outside an explicitly documented live-smoke skip.

- [ ] **Step 7: Inspect the final diff for security and inference regressions**

```powershell
rg -n "models\[0\]|Authorization|Cookie|#link=|gemini|defaultProtocol" electron src docs test
git diff --stat
git status --short
```

Review every match. There must be no new service-model fallback, secret material, native Gemini exposure, or protocol default. Test fixtures may contain sanitized header names only when they assert redaction behavior.

- [ ] **Step 8: Commit documentation and release evidence**

```powershell
git add docs/release-acceptance.md docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md
git commit -m "docs(release): document unified service profiles"
```

- [ ] **Step 9: Re-run final verification on committed HEAD**

```powershell
git status --short
git log -9 --oneline
node --test --test-concurrency=1 test/release-verification.test.mjs test/server-contract-fixtures.test.mjs
npm run verify:release
```

Expected: worktree is clean and both final gates exit `0`.

---

## Completion Checklist

- [ ] Exactly one service profile is persisted and displayed per normalized server origin and organization.
- [ ] Child models retain only server-declared public protocols and positive safe-integer context sizes.
- [ ] Codex and Claude share the service-profile ID but filter selectable models by their required protocol.
- [ ] `openai_chat` remains visible and is not launchable by either managed adapter.
- [ ] App/project defaults and sessions persist both profile and model for service selections.
- [ ] Missing, removed, unavailable, and incompatible models fail closed without replacement.
- [ ] Concurrent Codex models use isolated, owned native configuration artifacts.
- [ ] Connection success is independent from model and Skills catalog synchronization errors.
- [ ] Legacy data migration is transactional, idempotent, and preserves session history.
- [ ] No secrets or live authorization material appear in source, tests, documentation, logs, or commits.
- [ ] Fixed contract, focused implementation, full suite, documentation, and release gates all pass.
