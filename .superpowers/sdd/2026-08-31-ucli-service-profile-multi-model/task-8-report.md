# Task 8 — Service profile model selection

## Delivered

- New-session creation, initial import, secondary import, and existing-session configuration now present separate service-profile and compatible-model controls.
- Server-profile changes submit the exact atomic tuple `{ profileId, model }`; local profile changes submit `{ profileId, model: null }`.
- Invalid server tuples fail closed in the renderer before create/import/profile-update calls.  The shared `serviceProfileSelection.js` helper determines compatibility: Codex requires `openai_responses`, Claude requires `anthropic_messages`; `openai_chat` remains catalog-visible but cannot be managed-selected.
- No server model is inferred by catalog order, vendor, profile identity, or protocol.  Project/app bindings continue to be delegated to the existing backend resolver; explicit server selections require an explicit model.
- Imported historical models remain visible as historical/removed entries and are not replaced.  Existing sessions with an absent selected server profile/model display disabled historical entries.
- Profile-only and model-only changes use the existing active-session restart confirmation.

## Direct load-bearing DTO addition

`electron/orchestrator.js` now includes the safe `profileSourceKind` field in the session list and profile-runtime DTOs.  The renderer needs this existing session metadata only to distinguish an absent **server** profile from an absent local profile and render the former as historical.  It does not alter launch selection, credentials, protocols, or server behavior.  `src/stores/sessions.js` preserves the DTO field.

## RED / GREEN evidence

Initial RED (before implementation):

```text
node --test test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs
FAIL: missing deriveServiceProfileSessionState export
FAIL: SessionConfigModal missing separate service/model controls
FAIL: NewSessionDialog missing explicit service tuple handling
```

Dynamic DTO RED (temporarily omitted only the two new `profileSourceKind` DTO fields):

```text
node --test --test-name-pattern "selected service profile exposes" test/ai-cli-profile-session-template.test.mjs
FAIL: actual undefined, expected 'server'
```

After restoration, that dynamic test passed.  The final focused/template run passed `41/41`:

```text
node --test test/ai-cli-profile-workbench-template.test.mjs test/claude-profile-session-template.test.mjs test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs test/service-profile-selection.test.mjs
pass 41, fail 0
```

## Caller inventory

Audit commands:

```text
rg -n "setProfile\\(" src
rg -n "setSessionProfile\\(" src electron
rg -n "sessions\\.createSession\\(|sessions\\.importSession\\(" src/components/NewSessionDialog.vue src/views/SessionDetail.vue
rg -n "models\\[0\\]" src electron
```

- `src/components/SessionConfigModal.vue`: both update/restart-confirmation paths call `sessions.setProfile(current.id, selection)`, where `selection` is the atomic object.
- `src/components/NewSessionDialog.vue`: new and initial-import configurations add an explicit server tuple, or a local tuple with `model: null`; historical imports retain the discovered saved model only when the user did not make an explicit selection.
- `src/views/SessionDetail.vue`: the secondary import has the same explicit tuple and historical-model behavior.
- `src/stores/sessions.js`: forwards only its `selection` object to strict IPC validation.
- The audit found no scalar UI `setProfile` caller and no `models[0]` selection fallback in `src` or `electron`.

## Verification

```text
node --test test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs test/service-profile-selection.test.mjs
pass 36, fail 0

node --test test/ai-cli-profile-service.test.mjs test/ai-cli-profile-ipc.test.mjs test/claude-profile-launch.test.mjs
pass 29, fail 0

npm run build
pass

npm test
tests 1923; pass 1911; fail 0; skipped 12

git diff --check
pass
```

Two earlier full-suite attempts exposed deterministic, pre-existing static template wording contracts (`保持历史连接`, then `具体档案`) after text was renamed.  Both were corrected by preserving the required text while retaining the new service/historical wording.  They were not Windows installer flakes; the final full run passed the installer tests and the suite.

## Self-review / concerns

- No live smoke was run, no `ucli-server` code was changed, no secrets are added to renderer DTOs, and no protocol was broadened.
- `profileSourceKind` is intentionally the smallest production boundary expansion needed for historical server-profile presentation and is covered by a real orchestrator/IPC dynamic test.
- The selector intentionally does not preselect any server model.  A missing, removed, unavailable, or incompatible model remains unlaunchable until a valid explicit model is selected.

## Review remediation — explicit selection preservation

Follow-up review found four issues and all are fixed in the companion commit.

- The renderer store no longer uses an adapter `models[0]` fallback while creating an optimistic summary.  It starts with `config.model` or `null`, then accepts the allowlisted `model` field from `profile-runtime` and from a rehydrated/list summary update.  A dynamic Pinia test proves an inherited server binding with `responses-bound` (not the first catalog item) remains exact through creation, list upsert, and runtime publication.
- `sessions.profile_source_kind` is now an additive schema field.  Database mapping accepts and persists only `server` or `null`; no profile ID, model, vendor, or protocol is inspected to infer it.  The orchestrator writes it atomically with `profile_id` and `model` on create/set-profile, and restores an unavailable server tuple from persisted `profileId`, `model`, and the allowlisted marker.
- A real orchestrator lifecycle test selects a service tuple, disconnects/removes the catalog, shuts down, reopens, and verifies `session:list` still exposes the historical `{ profileId, model, profileSourceKind: 'server', canStart: false }`.  It also verifies the emitted `profile-runtime` marker before restart.  Service → local → system transition coverage verifies the database marker is cleared for local/system selections.
- Session configuration now enables a service profile only when its profile and at least one compatible child model are `ready`, matching new/import behavior.  Cancelling the restart confirmation restores the persisted profile/model draft via a tested pure helper; the modal invokes that helper on cancellation.

### Follow-up RED / GREEN evidence

```text
node --test test/session-profile-binding.test.mjs
RED: optimistic inherited summary selected `wrong-first` instead of null
RED: refreshed existing list summary kept null instead of `responses-selected`
RED: session source marker round-trip returned undefined instead of server

node --test --test-name-pattern "selected service tuple remains" test/ai-cli-profile-session-template.test.mjs
RED: database source marker was null instead of server before disconnect/reopen
```

The initial helper tests for ready service selection and draft reset also failed because their production exports did not exist.  After the minimal changes:

```text
node --test test/session-profile-binding.test.mjs
pass 8, fail 0

node --test test/session-profile-binding.test.mjs test/ai-cli-profile-session-template.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs test/service-profile-selection.test.mjs test/ai-cli-profile-db.test.mjs test/server-connection-db.test.mjs
pass 63, fail 0

node --test test/ai-cli-profile-db.test.mjs test/ai-cli-profile-service.test.mjs test/ai-cli-profile-ipc.test.mjs test/ai-cli-profile-session-template.test.mjs test/claude-profile-service.test.mjs test/claude-profile-launch-coordinator.test.mjs test/claude-profile-launch.test.mjs test/server-connection-store.test.mjs test/server-settings-template.test.mjs test/service-profile-selection.test.mjs test/ai-cli-profile-template.test.mjs test/ai-cli-profile-presentation.test.mjs test/session-config-presentation.test.mjs test/session-config-template.test.mjs test/session-profile-binding.test.mjs
pass 133, fail 0

npm run build
pass

npm test
tests 1930; pass 1918; fail 0; skipped 12

git diff --check
pass
```

The final tuple/import audit again found only the two atomic-object `SessionConfigModal` callers.  Initial `NewSessionDialog` import and secondary `SessionDetail` import both retain their explicit-model validation and only preserve a discovered historical model when no explicit tuple model was selected.  No production `models[0]` or scalar profile mutation caller remains.
