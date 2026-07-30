# UCLI Global Communication Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Use `test-driven-development` for each task and `verification-before-completion` before claiming completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one global, user-controlled communication Gateway to UCLI. The first channel is Feishu. It relays selected UCLI session state, user decisions, plan reviews, task completion, and explicitly requested full results; it routes authorized Feishu replies back to the exact UCLI session without forwarding the full AI CLI stream.

**Architecture:** The Electron main process owns a platform-neutral `GatewayRuntime`. Existing CLI adapters publish explicit lifecycle and decision events through a small capability contract. The runtime maintains one in-memory task queue per selected session, one persistent Feishu root/thread per session, state-driven message routes, and first-writer-wins decisions. A `CommunicationChannel` interface isolates Feishu SDK details. Durable storage contains only configuration, encrypted secrets, relay selection, routes, and audit metadata; task text, message bodies, action tokens, and full snapshots stay in memory.

**Tech Stack:** Electron 32, Node.js ESM, Vue 3, Pinia, Ant Design Vue, sql.js, Electron `safeStorage`, official `@larksuiteoapi/node-sdk` Channel API over WebSocket, Node test runner.

## Global Constraints

- There is one global Gateway desired state. The workbench header exposes only its quick switch and current status.
- Detailed configuration lives in Settings. A summary card opens a drawer containing endpoint, session relay, and runtime details.
- Enabling Gateway persists across restarts. Disabling it also persists. Startup attempts to connect only when desired state is enabled and a valid applied configuration exists.
- Gateway off pauses communication only. It never stops, deletes, interrupts, starts, or resumes an AI CLI session.
- The first release has one active communication channel and one endpoint. The core must not depend on Feishu types.
- Feishu configuration supports one target: either one user Open ID (`ou_...`) or one group chat ID (`oc_...`), plus an allowlist of operator Open IDs.
- Configuration uses `draft -> test -> save/apply`. Apply is transactional: connect the candidate first; persist and swap only after the candidate connects. If it fails, the old running channel and old applied configuration remain active.
- A secret-only change keeps existing session roots. Changing App ID, target type, or target ID changes the channel fingerprint, closes old routes, and creates new roots.
- App Secret is write-only. Plaintext and ciphertext never enter renderer state after the IPC call, logs, diagnostics, ordinary settings JSON, or tests/fixtures.
- AI CLI settings contain references only: `{ sessionId, relayEnabled }`. Do not duplicate cwd, model, provider, tier, native credentials, or launch configuration.
- Relay is opt-in per existing UCLI session and defaults to off. Selection and root routes persist across UCLI restarts.
- An offline selected session is shown as waiting. Its root is created only after its adapter emits `ready`.
- Each selected ready session has one persistent root message/thread. The durable route is `channelFingerprint + rootMessageId <-> UCLI sessionId`.
- Root reuse is mandatory on session resume, Gateway reconnect, and UCLI restart. If Feishu reports the target was recalled/revoked, create a replacement root and atomically replace the route.
- Removing a session, disabling relay, or changing communication identity invalidates its remote routes and action tokens. Stopping a session updates its root but retains the root route while relay remains enabled.
- Do not forward terminal bytes, streaming AI output, reasoning, tool calls/results, file diffs, token usage, or incremental statistics.
- Allowed outward semantics are session root state, decision requests, plan review, per-turn completion/failure/interruption, queue receipts, and user-requested full plan/result details.
- Normal task messages are FIFO per session with a maximum of five queued items. Decision responses bypass the queue.
- The queue is memory-only. On session stop or relay cancellation, clear it and report the number of cancelled items. On remote interrupt, pause it and offer `continue` or `clear`.
- The only V1 remote control action is interrupting the current task. It cannot stop/delete a session or change Gateway/session relay switches.
- Feishu input supports plain text and Gateway card actions only. Ignore image, file, audio, video, sticker, post attachments, and merged forwards with an explanatory reply when the route is otherwise valid.
- Group messages are accepted only when they reply in a known Gateway root/thread. They do not require `@bot` once the reply/thread route is known. Other group messages are ignored.
- Private unquoted text may route only when exactly one selected session is ready and running. Never guess by recent activity, display name, model, list order, or fuzzy matching.
- Each Feishu-originated task receives a `relayTaskId`; desktop-originated tasks do not. Both still update the root and emit completion state.
- Decision validity is owned by the underlying CLI/session state. Gateway adds no decision timeout and no fixed message expiry.
- Remove only the current five-minute permission auto-deny. Preserve blacklist, deny, high-risk, allow/default, `always-agree`, and `ask-everything` behavior exactly.
- Concurrent desktop and Feishu decision responses use first valid response wins. The losing surface changes to “already handled”.
- Gateway never writes guessed `y/n`, menu numbers, or option labels directly. It calls `respondDecision(decisionId, response)`; the adapter verifies the decision is still current and translates it to provider-native input.
- Plan and result summaries are deterministic and require no LLM.
- Pending decisions, full plan snapshots, full result snapshots, task text, inbound replies, message bodies, and card action tokens stay in memory.
- Persist only endpoint metadata, encrypted secret, desired enabled state, relay selections, root/message routes, decision audit metadata, and connection status/error metadata.
- Reconnect sync sends current roots, still-pending decisions/plan reviews, and the latest completion per selected session. It does not replay historical streams. An intentional Gateway-off period is not backfilled.

---

## Domain Model and State Machines

### Adapter capability contract

```js
export const GATEWAY_EVENT = Object.freeze({
  TURN_STARTED: 'turn_started',
  DECISION_REQUIRED: 'decision_required',
  TURN_COMPLETED: 'turn_completed',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_FAILED: 'turn_failed',
  SESSION_STOPPED: 'session_stopped'
})

// BaseAdapter public methods
get gatewayCapabilities() {
  return { decisions: false, planSnapshot: false, resultSnapshot: false }
}

getDecisionContext() { return null }
respondDecision(_decisionId, _response) { return false }
getLatestPlanSnapshot(_decisionId) { return null }
getLatestResultSnapshot(_turnId) { return null }
```

```js
// Every explicit lifecycle event has this common envelope.
{
  type: 'decision_required',
  sessionId: 'ucli-session-id',
  turnId: 'provider-stable-turn-id',
  occurredAt: 1785370000000,
  decision: {
    decisionId: 'provider-or-engine-stable-id',
    kind: 'permission', // question | plan_review | terminal_prompt
    title: '执行命令',
    summary: 'Bash: npm test',
    options: [
      { id: 'allow_once', label: '允许一次' },
      { id: 'deny', label: '拒绝' }
    ],
    responseMode: 'single' // multi | free_text | plan_review
  }
}
```

`expiresAt` is intentionally absent. A decision is pending until the adapter/engine accepts one response, the CLI cancels it, or the session stops.

### Session root state

```text
attached/idle
  -> running
  -> waiting_decision
  -> running
  -> task_completed

Any active state -> interrupted | failed | stopped
Any state while desiredEnabled=false -> gateway_paused (communication view only)
```

Plan review is `waiting_decision`, not completion. A denied permission is a resolved decision, not proof that the turn completed.

### Communication channel contract

```js
export class CommunicationChannel {
  async connect(_config) {}
  async disconnect() {}
  async sendSessionRoot(_view) {}
  async updateSessionRoot(_route, _view) {}
  async sendDecision(_route, _view) {}
  async sendCompletion(_route, _view) {}
  async sendPlanReview(_route, _view) {}
  onUserMessage(_listener) { return () => {} }
  onAction(_listener) { return () => {} }
}
```

The core passes normalized view models and receives normalized inbound events. Feishu message IDs, cards, reactions, Open IDs, and thread fields remain inside `electron/gateway/channels/`.

### Persistent schema

```sql
CREATE TABLE IF NOT EXISTS gateway_secrets (
  key        TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_session_routes (
  session_id          TEXT PRIMARY KEY,
  relay_enabled       INTEGER NOT NULL DEFAULT 0,
  channel_fingerprint TEXT,
  target_id           TEXT,
  root_message_id     TEXT,
  root_thread_id      TEXT,
  route_status        TEXT NOT NULL DEFAULT 'waiting',
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_message_routes (
  message_id          TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  relay_task_id       TEXT,
  decision_id         TEXT,
  route_kind          TEXT NOT NULL,
  channel_fingerprint TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_decision_audit (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  decision_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  source       TEXT NOT NULL,
  resolved_at  INTEGER NOT NULL
);
```

Applied non-secret configuration and desired enabled state use existing `settings` keys `gateway.config` and `gateway.desiredEnabled`. They must be read/written through dedicated Gateway methods so generic settings IPC never returns Gateway secrets.

---

## File Map

### New Electron main-process modules

- `electron/gateway/contracts.js` — enums, validation helpers, channel and adapter contracts.
- `electron/gateway/sessionSignalBus.js` — explicit lifecycle publication/subscription; no terminal heuristics.
- `electron/gateway/config.js` — draft validation, redaction, test fingerprint, channel identity fingerprint.
- `electron/gateway/secretStore.js` — injected `safeStorage` wrapper.
- `electron/gateway/routeStore.js` — durable relay selection, root/message routes, and decision audit.
- `electron/gateway/taskQueue.js` — per-session FIFO, `relayTaskId`, max-five rule, pause/continue/clear.
- `electron/gateway/decisionRegistry.js` — pending decisions, one-time action tokens, first-writer-wins resolution.
- `electron/gateway/snapshotStore.js` — in-memory plan/result snapshots, splitting, deterministic overview.
- `electron/gateway/redaction.js` — deterministic sensitive-value redaction and display limits.
- `electron/gateway/viewModels.js` — platform-neutral root, decision, plan, result, and completion views.
- `electron/gateway/channels/feishuCards.js` — Feishu card V2 rendering and action payloads.
- `electron/gateway/channels/feishuChannel.js` — official SDK connection, normalization, send/update/reaction.
- `electron/gateway/runtime.js` — global state, routing, root lifecycle, reconnect sync, hot swap.

### New renderer modules

- `src/stores/gateway.js` — status/config/session relay state and IPC actions.
- `src/components/gateway/GatewayHeaderControl.vue` — quick global switch and compact status.
- `src/components/gateway/GatewayConfigDrawer.vue` — endpoint draft/test/apply, session selection, runtime details.
- `src/gatewayPresentation.js` — pure labels, colors, validation display, and status summaries.

### Existing modules to modify

- `electron/permission/engine.js`
- `electron/adapters/cliAdapter.js`
- `electron/adapters/claudeAdapter.js`
- `electron/adapters/codexAdapter.js`
- `electron/adapters/openCodeAdapter.js`
- `electron/orchestrator.js`
- `electron/persistence/db.js`
- `electron/preload.js`
- `electron/main.js`
- `electron/diagnosticsService.js`
- `src/ipc.js`
- `src/views/Workbench.vue`
- `src/views/Settings.vue`
- `package.json`
- `package-lock.json`
- `docs/protocol-reference.md`
- `docs/release-acceptance.md`

---

## Delivery Gate A — Explicit CLI Semantics

### Task 1: Remove Permission Auto-Deny Without Changing Safety Rules

**Files:**
- Modify: `electron/permission/engine.js`
- Create: `test/permission-engine.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write a failing no-timeout test**

Use Node mock timers, advance beyond five minutes, and prove the pending decision remains unresolved:

```js
test('a requested permission stays pending until an explicit response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests = []
  const engine = createAskEverythingEngine((request) => requests.push(request))
  const decision = engine.decide('s1', { tool: 'Bash', input: { command: 'npm test' } })

  await Promise.resolve()
  t.mock.timers.tick(10 * 60 * 1000)
  assert.equal(engine.pendingCount(), 1)
  assert.equal(engine.respondApproval(requests[0].requestId, 'allow'), true)
  assert.equal((await decision).verdict, 'allow')
})
```

Add regression cases for:

- hard blacklist denies in all tiers;
- `always-agree` allows non-blacklisted operations;
- `ask-everything` remains pending;
- safety rules deny `deny`, ask `high-risk`, and allow both `allow` and unmatched `default`;
- `respondApproval()` remains single-use.

- [x] **Step 2: Run the focused test**

Run: `node --test test/permission-engine.test.mjs test/permission-classifier.test.mjs test/default-rules.test.mjs`

Expected: the no-timeout assertion fails because `_ask()` still schedules auto-deny.

- [x] **Step 3: Remove only timeout behavior**

Delete `ASK_TIMEOUT_MS`, the timer creation, `timedOut`, timeout-specific reason, `clearTimeout`, and the `timer` field. Store `{ resolve, req }`.

Do not reorder or alter classifier/tier branches.

- [x] **Step 4: Verify and commit**

```powershell
node --test test/permission-engine.test.mjs test/permission-classifier.test.mjs test/default-rules.test.mjs
git add electron/permission/engine.js test/permission-engine.test.mjs package.json
git commit -m "fix: keep permission decisions pending"
```

### Task 2: Add Gateway Lifecycle and Decision Contracts

**Files:**
- Create: `electron/gateway/contracts.js`
- Create: `electron/gateway/sessionSignalBus.js`
- Modify: `electron/adapters/cliAdapter.js`
- Create: `test/gateway-contracts.test.mjs`
- Create: `test/session-signal-bus.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing contract tests**

Assert:

- only the six approved lifecycle types can be published;
- every event requires `sessionId`, `turnId` where applicable, and `occurredAt`;
- every decision has `decisionId`, `kind`, `title`, `summary`, `options`, and `responseMode`;
- a decision may omit `expiresAt`;
- terminal/message/reasoning/tool/stat event types are rejected;
- subscribers receive events in publication order and can unsubscribe.

- [x] **Step 2: Add the pure contracts and signal bus**

`SessionSignalBus.publish(event)` validates and synchronously snapshots the event before notifying listeners. It does not deduplicate completion based on timing; adapter/provider stable IDs provide identity.

```js
export class SessionSignalBus {
  constructor({ validate = validateGatewayEvent } = {}) {
    this.validate = validate
    this.listeners = new Set()
  }

  publish(input) {
    const event = Object.freeze(structuredClone(this.validate(input)))
    for (const listener of [...this.listeners]) listener(event)
    return event
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
```

- [x] **Step 3: Extend `BaseAdapter` without breaking existing adapters**

Add:

- `emitGatewayEvent(event)`
- default `gatewayCapabilities`
- default snapshot getters returning `null`
- default `respondDecision()` that handles a current permission request through `PermissionEngine.respondApproval()` and otherwise returns `{ accepted: false, reason: 'unsupported' }`

Keep existing `emitEvent()` and renderer events unchanged.

- [x] **Step 4: Verify and commit**

```powershell
node --test test/gateway-contracts.test.mjs test/session-signal-bus.test.mjs test/adapter-stats.test.mjs test/opencode-adapter.test.mjs
git add electron/gateway/contracts.js electron/gateway/sessionSignalBus.js electron/adapters/cliAdapter.js test package.json
git commit -m "refactor: define gateway adapter semantics"
```

### Task 3: Implement Claude Decision, Plan, Result, and Lifecycle Capabilities

**Files:**
- Modify: `electron/adapters/claudeAdapter.js`
- Create: `electron/adapters/claudeGatewayParser.js`
- Modify: `resources/claudeHook.runner.mjs`
- Add fixtures: `test/fixtures/gateway/claude-plan.jsonl`
- Add fixtures: `test/fixtures/gateway/claude-question.jsonl`
- Add fixtures: `test/fixtures/gateway/claude-result.jsonl`
- Create: `test/claude-gateway-capabilities.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write parser tests from sanitized Claude transcript fixtures**

Cover:

- `AskUserQuestion` single-select, multi-select, and free-text questions;
- `ExitPlanMode` as `kind: 'plan_review'`;
- permission engine requests as `kind: 'permission'`;
- the latest complete assistant result for a stable turn;
- incomplete/truncated JSONL returns `null`, not guessed content;
- duplicate transcript scans do not re-emit the same lifecycle event.
- `AskUserQuestion` and `ExitPlanMode` bypass the safety-rule Hook decision so Claude keeps its native user prompt; all other tools continue through `PermissionEngine`.

- [x] **Step 2: Implement pure transcript extraction**

Expose:

```js
parseClaudeGatewayState(lines, previousCursor)
extractClaudePlanSnapshot(lines, decisionId)
extractClaudeResultSnapshot(lines, turnId)
```

The plan snapshot shape is:

```js
{
  kind: 'plan_review',
  title: 'Implementation plan',
  markdown: '# Implementation plan\n...',
  provider: 'claude',
  nativeSessionId: 'native-id',
  capturedAt: 1785370000000
}
```

No ANSI/TUI scraping is allowed. Use transcript tool-use/result structures only.

- [x] **Step 3: Emit lifecycle events from transcript transitions**

- emit `turn_started` when a new user turn appears;
- emit `decision_required` for current hook/question/plan state;
- emit `turn_completed` only from a provider completion record;
- emit `turn_interrupted` from explicit interruption/abort evidence;
- emit `turn_failed` from explicit provider error;
- emit `session_stopped` from PTY exit/dispose.

Continue emitting existing stats/terminal events for the desktop UI.

- [x] **Step 4: Implement verified decision responses**

`respondDecision(decisionId, response)` reloads the latest transcript state, verifies the ID is still current, then:

- permission: `engine.respondApproval(decisionId, 'allow'|'deny')`;
- question: provider-native selection/text translation owned by `ClaudeAdapter`;
- plan review: execute/reject/revision through the current `ExitPlanMode` prompt;
- stale ID: `{ accepted: false, reason: 'already_resolved' }`.

Only the adapter may write provider-native PTY sequences.

- [x] **Step 5: Verify and commit**

```powershell
node --test test/claude-gateway-capabilities.test.mjs test/adapter-stats.test.mjs test/session-history.test.mjs
git add electron/adapters/claudeAdapter.js electron/adapters/claudeGatewayParser.js test package.json
git commit -m "feat: expose Claude gateway capabilities"
```

### Task 4: Implement Codex and OpenCode Gateway Capabilities

**Files:**
- Modify: `electron/adapters/codexAdapter.js`
- Modify: `electron/adapters/openCodeAdapter.js`
- Create: `electron/adapters/codexGatewayParser.js`
- Create: `electron/adapters/openCodeGatewayParser.js`
- Add fixtures: `test/fixtures/gateway/codex-plan.jsonl`
- Add fixtures: `test/fixtures/gateway/codex-result.jsonl`
- Add fixtures: `test/fixtures/gateway/opencode-plan-export.json`
- Add fixtures: `test/fixtures/gateway/opencode-result-export.json`
- Create: `test/codex-gateway-capabilities.test.mjs`
- Create: `test/opencode-gateway-capabilities.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing provider fixture tests**

Codex tests use native JSONL plan-mode prompt and turn records. OpenCode tests use provider-native session export. Statistics continue to use sanitized exports; Gateway decision and snapshot extraction requests the complete export and keeps it in memory only. Prove:

- provider records, not PTY silence or token changes, emit completion;
- plan waiting emits `decision_required` and not `turn_completed`;
- result snapshots are scoped to the requested `turnId`;
- failed extraction returns `null`;
- old/stale decision IDs cannot affect the current prompt.

- [x] **Step 2: Add pure provider parsers**

Expose equivalent normalized functions:

```js
parseCodexGatewayState(lines, previousCursor)
extractCodexPlanSnapshot(lines, decisionId)
extractCodexResultSnapshot(lines, turnId)

parseOpenCodeGatewayState(sessionExport, previousCursor)
extractOpenCodePlanSnapshot(sessionExport, decisionId)
extractOpenCodeResultSnapshot(sessionExport, turnId)
```

- [x] **Step 3: Wire adapter capabilities**

Use existing Codex transcript discovery and OpenCode export facilities. OSC9 notifications may trigger a rescan but are never themselves treated as the full decision or completion proof.

Both adapters implement provider-native `respondDecision()` and re-check the latest prompt immediately before writing.

- [x] **Step 4: Verify all adapters**

```powershell
node --test test/codex-gateway-capabilities.test.mjs test/opencode-gateway-capabilities.test.mjs test/opencode-adapter.test.mjs test/adapter-stats.test.mjs
npm test
git add electron/adapters test package.json
git commit -m "feat: expose Codex and OpenCode gateway capabilities"
```

---

## Delivery Gate B — Durable Configuration and Pure Gateway Core

### Task 5: Add Gateway Persistence, Encrypted Secrets, and Transactional Configuration

**Files:**
- Modify: `electron/persistence/db.js`
- Create: `electron/gateway/secretStore.js`
- Create: `electron/gateway/config.js`
- Create: `electron/gateway/routeStore.js`
- Create: `test/gateway-db-migration.test.mjs`
- Create: `test/gateway-secret-store.test.mjs`
- Create: `test/gateway-config.test.mjs`
- Create: `test/gateway-route-store.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write additive migration tests**

Open both a new database and a legacy database fixture. Assert all four Gateway tables appear without altering sessions, statistics, rules, or settings.

`removeSession(id)` must:

- set relay selection off;
- deactivate message routes;
- retain decision audit metadata;
- retain existing session/statistics retention behavior.

- [x] **Step 2: Add DB methods and route invariants**

Implement:

```js
getGatewaySetting(key)
saveGatewaySetting(key, value)
getGatewaySecretCiphertext(key)
saveGatewaySecretCiphertext(key, ciphertext)
listGatewaySessionRoutes()
upsertGatewaySessionRoute(route)
saveGatewayMessageRoute(route)
resolveGatewayMessageRoute(messageId, channelFingerprint)
deactivateGatewayRoutesForSession(sessionId)
deactivateGatewayRoutesForFingerprint(channelFingerprint)
saveGatewayDecisionAudit(record)
```

No method accepts message content, task text, plan markdown, result markdown, or action tokens.

- [x] **Step 3: Implement secure secret storage**

`SecretStore` receives Electron `safeStorage` as a dependency:

```js
if (!safeStorage.isEncryptionAvailable()) {
  throw Object.assign(new Error('Secure storage is unavailable'), {
    code: 'SECURE_STORAGE_UNAVAILABLE'
  })
}
```

Store `encryptString(plaintext).toString('base64')`. Never use a plaintext fallback.

- [x] **Step 4: Implement strict endpoint configuration**

Applied config:

```js
{
  channelType: 'feishu',
  appId: 'cli_xxx',
  target: { type: 'user', id: 'ou_xxx' },
  operatorOpenIds: ['ou_operator']
}
```

Validation rules:

- `appId` must start with `cli_`;
- user target must start with `ou_`;
- group target must start with `oc_`;
- allowlist must contain at least one unique `ou_...`;
- unknown properties are discarded;
- `redactGatewayConfig()` returns `hasAppSecret`, never secret material.

`channelFingerprint` hashes only `{ channelType, appId, target.type, target.id }`. Secret and operator allowlist changes do not force new roots; App/target identity changes do.

- [x] **Step 5: Test config transaction semantics**

Define:

```js
testDraft({ config, appSecret }) -> { testId, fingerprint, botIdentity }
applyTestedDraft({ testId }) -> redactedAppliedConfig
```

`testId` is in-memory, single-use, and bound to the exact normalized draft plus secret hash. Changing the draft, running a new test, disabling Gateway, or shutting down invalidates the entry and zeroes its retained secret buffer. Apply connects a fresh candidate again, then within one operation:

1. retain the tested normalized draft and plaintext secret in a main-process-only test registry;
2. connect a fresh candidate from that exact registry entry;
3. begin a database transaction and stage the encrypted secret plus normalized config;
4. swap the runtime reference to the already-connected candidate;
5. commit the database transaction;
6. disconnect the old channel and erase the test registry entry.

If candidate connection, encryption, staging, swap, or commit fails, roll back the database transaction, restore the old runtime reference, disconnect the candidate, erase the failed registry entry, and retain the old persisted config, old secret, and old live channel. When the draft App Secret field is blank, testing uses the already stored secret; it never returns that secret to the renderer.

- [x] **Step 6: Verify and commit**

```powershell
node --test test/gateway-db-migration.test.mjs test/gateway-secret-store.test.mjs test/gateway-config.test.mjs test/gateway-route-store.test.mjs test/db-retention.test.mjs test/db-recovery.test.mjs
git add electron/persistence/db.js electron/gateway test package.json
git commit -m "feat: persist gateway configuration and routes"
```

### Task 6: Build Queue, Decision, Snapshot, and Redaction Primitives

**Files:**
- Create: `electron/gateway/taskQueue.js`
- Create: `electron/gateway/decisionRegistry.js`
- Create: `electron/gateway/snapshotStore.js`
- Create: `electron/gateway/redaction.js`
- Create: `electron/gateway/viewModels.js`
- Create: `test/gateway-task-queue.test.mjs`
- Create: `test/gateway-decision-registry.test.mjs`
- Create: `test/gateway-snapshots.test.mjs`
- Create: `test/gateway-redaction.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Implement and test per-session FIFO**

`GatewayTaskQueue.enqueue(sessionId, sourceMessageId, text)` assigns a UUID `relayTaskId`.

Assert:

- one running plus at most five waiting tasks per session;
- different sessions progress independently;
- decision responses never enter this queue;
- interrupt pauses the queue;
- `continue` resumes at the head;
- `clear` returns the cancelled count;
- session stop and relay disable clear the queue;
- queue state is empty after a new process/runtime instance.

- [x] **Step 2: Implement first-writer-wins decisions**

```js
register(decision, sessionId)
issueActionToken(decisionId, action)
resolve({ decisionId, response, source }) // source: desktop | feishu
cancelForSession(sessionId, reason)
invalidateRemoteTokens(reason)
listPendingForSession(sessionId)
```

`resolve()` calls one injected responder exactly once. The winner records metadata through `RouteStore`; the loser receives `already_resolved`. Tokens are random, in memory, single-use, and bound to decision ID plus action.

- [x] **Step 3: Implement deterministic plan overview**

`buildPlanOverview(markdown)` extracts:

1. first heading as title;
2. first paragraph under `Goal`, `目标`, or `Objective`;
3. first five section/step headings;
4. first eight unique file paths;
5. total heading count, file count, and character count.

If none are found, return the first 300 Unicode code points labeled `内容预览`. No LLM call or AI CLI call is permitted.

- [x] **Step 4: Implement in-memory snapshots**

`SnapshotStore` generates opaque `planSnapshotId` and `resultSnapshotId`, stores full normalized markdown only in memory, and splits requested detail into card-safe chunks. The final plan chunk alone contains execute/reject actions.

On extraction failure:

- plan view says “无法可靠提取完整方案，请在 UCLI 中处理” and has no execute button;
- result view says “无法可靠提取完整结果，请在 UCLI 中查看”.

- [x] **Step 5: Implement display redaction**

Redact:

- `Authorization` and `Bearer` values;
- `password`, `secret`, `token`, `api_key` key/value pairs;
- sensitive URL query values;
- environment assignments with the same sensitive names.

Decision summaries stop at 1,000 Unicode code points with a “查看完整内容” action. Binary/NUL or content that cannot be safely normalized is marked desktop-only.

- [x] **Step 6: Verify and commit**

```powershell
node --test test/gateway-task-queue.test.mjs test/gateway-decision-registry.test.mjs test/gateway-snapshots.test.mjs test/gateway-redaction.test.mjs
git add electron/gateway test package.json
git commit -m "feat: implement gateway core primitives"
```

---

## Delivery Gate C — Feishu Channel and Runtime

### Task 7: Implement the Feishu Communication Channel

**Files:**
- Create: `electron/gateway/channels/feishuCards.js`
- Create: `electron/gateway/channels/feishuChannel.js`
- Create: `test/feishu-cards.test.mjs`
- Create: `test/feishu-channel.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Install the official SDK**

Run: `npm install @larksuiteoapi/node-sdk`

Use the installed lockfile version. Do not implement a custom WebSocket protocol. The SDK `Channel.connect()` completes the real WebSocket handshake, has its own 15-second connection timeout, and auto-reconnects afterward.

- [x] **Step 2: Write a fake-SDK contract test**

Inject `createLarkChannel` so tests do not access Feishu. Assert:

- `connect()` and `disconnect()` are called once;
- `reconnecting`, `reconnected`, `error`, `message`, and `cardAction` are normalized;
- outbound failures surface `permission_denied`, `target_revoked`, `rate_limited`, `send_timeout`, and `not_connected`;
- inbound callbacks schedule work and return without awaiting Gateway task execution;
- `includeRawInMessage` is false.

- [x] **Step 3: Configure policy for deterministic routing**

Use:

```js
{
  transport: 'websocket',
  policy: {
    requireMention: false,
    dmMode: 'allowlist',
    dmAllowlist: operatorOpenIds,
    groupAllowlist: target.type === 'group' ? [target.id] : [],
    respondToMentionAll: false
  },
  safety: {
    dedup: { ttl: 12 * 60 * 60 * 1000, maxEntries: 5000 },
    staleMessageWindowMs: 30 * 60 * 1000,
    chatQueue: { enabled: true }
  },
  includeRawInMessage: false
}
```

The runtime still verifies `senderId` against the operator allowlist and ignores non-routed group messages. `requireMention:false` is necessary so a known thread reply reaches UCLI without `@bot`.

- [x] **Step 4: Normalize only supported inbound content**

Produce:

```js
{
  messageId,
  chatId,
  chatType,
  senderOpenId: senderId,
  text: content,
  rawContentType,
  replyToMessageId,
  rootId,
  threadId
}
```

Mark non-text `rawContentType` unsupported. Do not download resources.

- [x] **Step 5: Render card V2 views**

Implement root, decision, plan overview/detail, completion, queue, and interrupt cards. Card action payload contains only an opaque action token:

```js
{ integration: 'ucli-gateway', token: 'opaque-random-token' }
```

Never embed session IDs, decision IDs, task text, credentials, or native CLI identifiers in button values.

- [x] **Step 6: Implement send/update/reaction helpers**

Use SDK:

- `send(targetId, { card }, { replyTo, replyInThread: true })`;
- `updateCard(messageId, card)`;
- `addReaction(messageId, emojiType)`;
- `removeReaction(messageId, reactionId)`.

Keep returned reaction IDs in memory. Reaction failures must not fail task routing. Cards remain the authoritative state.

- [x] **Step 7: Verify and commit**

```powershell
node --test test/feishu-cards.test.mjs test/feishu-channel.test.mjs
git add electron/gateway/channels package.json package-lock.json test
git commit -m "feat: add Feishu gateway channel"
```

### Task 8: Implement Global Runtime, Roots, Routing, Queue Receipts, and Reconnect Sync

**Files:**
- Create: `electron/gateway/runtime.js`
- Create: `test/gateway-runtime-state.test.mjs`
- Create: `test/gateway-session-routing.test.mjs`
- Create: `test/gateway-root-lifecycle.test.mjs`
- Create: `test/gateway-reconnect.test.mjs`
- Create: `test/gateway-decision-flow.test.mjs`
- Create: `test/gateway-queue-flow.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Define observable runtime state**

```js
{
  desiredEnabled: true,
  phase: 'connected', // off | connecting | connected | reconnecting | error
  channelType: 'feishu',
  targetLabel: '研发群',
  errorCode: null,
  errorMessage: '',
  selectedSessionCount: 2,
  readySessionCount: 1,
  pendingDecisionCount: 1,
  queuedTaskCount: 3,
  lastConnectedAt: 1785370000000
}
```

Every transition publishes one redacted status event to the renderer.

- [x] **Step 2: Implement root lifecycle**

On selected session `ready`:

1. load the route for the current channel fingerprint;
2. update the existing root if possible;
3. on `target_revoked`, create a new root and replace the route;
4. persist root/thread IDs and state.

Root state includes display name, adapter/provider, short session ID, current state, current relay task, queue count, and latest completion state. It contains no terminal output.

On `stopped`, `failed`, `interrupted`, relay disabled, Gateway paused, or target migration, update/close the appropriate view as defined in Global Constraints.

- [x] **Step 3: Implement exact inbound routing**

Routing precedence:

1. valid card token -> registered decision/control action;
2. `replyToMessageId`, `rootId`, or `threadId` -> active message/root route;
3. private unquoted text -> the only selected ready/running session;
4. otherwise ignore or explain ambiguity.

Group normal messages never reach step 3. Resolve all IDs through `RouteStore` and the current channel fingerprint. Never fall back to latest session.

- [x] **Step 4: Implement task acceptance and FIFO**

For valid ordinary text:

- sanitize controls and enforce the channel text limit;
- create `relayTaskId`;
- immediately add a processing receipt reaction;
- if queued, reply `已加入队列，第 N 条`;
- when head starts, call only `adapter.sendTurn(text)`;
- bind the next adapter `turn_started` to the active relay task;
- on explicit completion/failure/interruption update receipt, completion card, root, and start the next item.

Each completed turn receives its own completion reply. If items remain, the root says it is moving to the next task; otherwise it returns to idle.

- [x] **Step 5: Implement decision flow**

On `decision_required`:

- register the decision;
- set root to `waiting_decision`;
- send the appropriate card;
- for plan review, attach deterministic overview and `查看完整方案`;
- for large safe permission content, attach `查看完整内容`;
- for unsafe/binary content, mark desktop-only.

On response:

- operator allowlist check;
- consume opaque token;
- call `adapter.respondDecision(decisionId, response)`;
- first accepted response wins;
- persist only `{ decisionId, kind, verdict, source, resolvedAt }`;
- update both Feishu and desktop surfaces to resolved/already handled.

- [x] **Step 6: Implement plan/result detail actions**

- `查看完整方案` reads `planSnapshotId` from memory and sends chunked cards in the same session thread; only the final card contains execute/reject.
- `回复修改意见` accepts a routed free-text response through `respondDecision()`.
- completion card offers `查看完整结果`; its action fetches `getLatestResultSnapshot(turnId)` and sends chunked detail.
- if UCLI restarted or the snapshot was cleared, explain that the content is no longer cached and direct the user to desktop/history.

- [x] **Step 7: Implement remote interrupt**

Interrupt action calls `adapter.interrupt()` for the exact session, pauses its queue, updates root, and sends buttons:

- `继续队列` -> unpause and run the head;
- `清空队列` -> clear and report cancelled count.

No other remote session-management action exists.

- [x] **Step 8: Implement Gateway off and reconnect**

Intentional off:

- persist `desiredEnabled=false`;
- invalidate remote action tokens;
- disconnect channel;
- retain relay selections and root routes;
- clear no underlying decisions;
- perform no backfill when later enabled.

Unexpected reconnect:

- phase `reconnecting` -> `connected`;
- update/recreate current roots;
- resend current pending decisions and plan review;
- send latest completion per selected session;
- do not replay task/message history.

- [x] **Step 9: Verify and commit**

```powershell
node --test test/gateway-runtime-state.test.mjs test/gateway-session-routing.test.mjs test/gateway-root-lifecycle.test.mjs test/gateway-reconnect.test.mjs test/gateway-decision-flow.test.mjs test/gateway-queue-flow.test.mjs
git add electron/gateway/runtime.js test package.json
git commit -m "feat: orchestrate global communication gateway"
```

---

## Delivery Gate D — UCLI Integration and Product Surface

### Task 9: Integrate Runtime With Orchestrator, Startup, Shutdown, and IPC

**Files:**
- Modify: `electron/orchestrator.js`
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Create: `test/gateway-orchestrator.test.mjs`
- Create: `test/gateway-startup.test.mjs`
- Create: `test/gateway-ipc.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Create an injected Gateway port in orchestrator**

The runtime receives only:

```js
{
  listSessions,
  getSession,
  sendTurn,
  interrupt,
  respondDecision,
  getDecisionContext,
  getLatestPlanSnapshot,
  getLatestResultSnapshot,
  subscribeGatewayEvents
}
```

It must not reach directly into the orchestrator `sessions` map or PTY process.

- [x] **Step 2: Wire all explicit lifecycle sources**

- permission engine request/resolution;
- adapter gateway lifecycle events;
- adapter `ready` and `exit`;
- session remove/stop/resume;
- desktop decision responses.

When a desktop response wins, call `DecisionRegistry.resolve({ source: 'desktop' })` before notifying the Gateway view.

- [x] **Step 3: Add startup and shutdown order**

After persistence:

```js
await orchestrator.initPersistence()
await orchestrator.startGateway()
orchestrator.registerIpc()
```

Startup connection failure records error state but does not prevent tray/window/session use.

Shutdown order:

1. stop accepting Gateway inbound work;
2. disconnect communication channel;
3. dispose adapters/hook server;
4. flush and close database.

- [x] **Step 4: Add narrow IPC**

Preload API:

```js
getGatewayState()
setGatewayDesiredEnabled(enabled)
getGatewayConfiguration()
testGatewayDraft(draft)
applyGatewayDraft(testId)
listGatewaySessions()
setSessionRelayEnabled(sessionId, enabled)
resyncGatewaySession(sessionId)
onGatewayState(listener)
```

Rules:

- `getGatewayConfiguration()` returns redacted applied config and `hasAppSecret`;
- `testGatewayDraft()` is the only call that accepts App Secret plaintext;
- no generic `settings:get` response contains secret data;
- IPC validates IDs and booleans in the main process;
- enabling without valid applied config returns `CONFIG_REQUIRED`.

- [x] **Step 5: Verify and commit**

```powershell
node --test test/gateway-orchestrator.test.mjs test/gateway-startup.test.mjs test/gateway-ipc.test.mjs test/diagnostics-ipc.test.mjs test/update-ipc.test.mjs
npm test
git add electron/orchestrator.js electron/main.js electron/preload.js src/ipc.js test package.json
git commit -m "feat: integrate gateway runtime with UCLI"
```

### Task 10: Add Workbench Quick Switch and Settings Drawer

**Files:**
- Create: `src/stores/gateway.js`
- Create: `src/components/gateway/GatewayHeaderControl.vue`
- Create: `src/components/gateway/GatewayConfigDrawer.vue`
- Create: `src/gatewayPresentation.js`
- Modify: `src/views/Workbench.vue`
- Modify: `src/views/Settings.vue`
- Create: `test/gateway-presentation.test.mjs`
- Create: `test/gateway-header-template.test.mjs`
- Create: `test/gateway-settings-template.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Build and test the Pinia store**

Store actions mirror the IPC list. It subscribes once to state changes and does not store App Secret after test submission.

Draft shape in the drawer may temporarily contain `appSecret` in component-local state only. Clear it after successful test, failed test, drawer close, and unmount.

- [x] **Step 2: Add the workbench header control**

Place `GatewayHeaderControl` in `src/views/Workbench.vue`’s existing `.toolbar`, on the right side before layout/count controls.

It shows:

- switch for desired enabled state;
- compact phase badge: off, connecting, connected, reconnecting, or error;
- tooltip with selected/ready session counts and redacted last error;
- click on status calls `router.push({ name: 'settings', query: { panel: 'gateway' } })`.

It contains no endpoint fields and no session relay list.

- [x] **Step 3: Add Settings summary card**

The card shows:

- channel: Feishu;
- target type and redacted target ID;
- desired/actual status;
- selected/ready session counts;
- last connection result;
- `配置` action that opens the drawer.

`Settings.vue` watches `route.query.panel`; the value `gateway` opens the drawer, and closing the drawer replaces the route without that query key so browser Back does not repeatedly reopen it.

- [x] **Step 4: Build the drawer sections**

**Communication endpoint**

- App ID;
- write-only App Secret field with “已保存” state;
- target type and target ID;
- operator Open ID allowlist;
- deterministic content-sharing warning;
- buttons `测试连接` and `保存并应用`.

Apply remains disabled until the current normalized draft has a successful unused `testId`.

**AI CLI sessions**

Each existing session row shows name, adapter/provider, online state, relay toggle, root state, queue count, and `重新同步`. Default relay is off.

**Gateway runtime**

Show desired state, connection phase, bot identity, last connected time, redacted error, pending decisions, and queued tasks. Do not show secret, task text, message body, command body, or snapshot content.

- [x] **Step 5: Add accessibility and failure behavior**

- switches and buttons have labels;
- drawer focus returns to the trigger;
- failed enable with `CONFIG_REQUIRED` opens the drawer;
- failed apply preserves the old applied summary and displays the candidate error;
- error text is copyable but redacted.

- [x] **Step 6: Verify and commit**

```powershell
node --test test/gateway-presentation.test.mjs test/gateway-header-template.test.mjs test/gateway-settings-template.test.mjs test/workbench-keyboard.test.mjs test/workbench-route-retention.test.mjs
npm run build
git add src test package.json
git commit -m "feat: add gateway controls to UCLI"
```

### Task 11: Diagnostics, Documentation, Packaging, and End-to-End Acceptance

**Files:**
- Modify: `electron/diagnosticsService.js`
- Modify: `docs/protocol-reference.md`
- Modify: `docs/release-acceptance.md`
- Create: `test/gateway-diagnostics.test.mjs`
- Create: `test/gateway-e2e.test.mjs`
- Modify: `test/release-verification.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Add redacted diagnostics**

Diagnostics may include:

- desired/actual state;
- channel type;
- redacted target;
- selected/ready counts;
- last connection timestamp;
- error code and redacted message;
- route/audit row counts.

Diagnostics must not include App Secret/ciphertext, operator full IDs, message bodies, task text, decision content, plan/result content, action tokens, or AI output.

- [x] **Step 2: Add a fake-channel end-to-end test**

Exercise:

1. apply tested Feishu config;
2. enable Gateway;
3. select two sessions, one offline and one ready;
4. create/reuse the ready session root;
5. accept one private unquoted task because exactly one session is ready/running;
6. queue five and reject the sixth waiting item;
7. emit plan review, view full plan, revise, then execute;
8. race desktop and Feishu decision responses and prove one winner;
9. complete the task, request full result, and advance the queue;
10. interrupt, continue, then clear remaining queue;
11. simulate reconnect and current-state sync;
12. disable Gateway and prove CLI sessions keep running;
13. restart and prove disabled state, selections, and routes persist without content.

- [x] **Step 3: Document protocol and operator setup**

`docs/protocol-reference.md` must describe:

- Gateway/channel boundary;
- adapter lifecycle/decision contract;
- exact route precedence;
- persistent versus in-memory data;
- no Gateway decision expiry;
- session and queue state machines;
- first-writer-wins behavior.

`docs/release-acceptance.md` must include Feishu app prerequisites:

- bot capability;
- WebSocket event delivery;
- message receive and card action subscriptions;
- send/update/reply/reaction permissions;
- group full-message permission when group target is used;
- operator allowlist and target ID validation.

- [x] **Step 4: Run security/source scans**

```powershell
rg -n "ASK_TIMEOUT_MS|timedOut|确认超时|auto-deny" electron test
rg -n "appSecret|ciphertext|Authorization|Bearer" electron src test
rg -n "sendTurn\\(" electron/gateway
rg -n "terminal|reasoning|tool_call|token_usage" electron/gateway
```

Expected:

- no permission timeout remains;
- secret references are limited to config ingestion/encryption and explicit redaction tests;
- Gateway runtime calls `sendTurn()` only for ordinary queued tasks;
- prohibited event names appear only in negative tests/guards, not outbound mappings.

- [x] **Step 5: Run full verification**

```powershell
npm test
npm run build
npm run verify:release
git diff --check
git status --short
```

Expected: all commands pass. Review `git status --short` and ensure only files in this plan are staged for the feature.

- [ ] **Step 6: Manual Feishu acceptance (pending test enterprise credentials)**

With a test enterprise app:

- test and atomically apply a user target;
- confirm startup auto-connect when enabled;
- confirm header off persists across restart;
- confirm a selected session root is reused;
- confirm recalled root is recreated;
- confirm unauthorized operators cannot route;
- confirm group non-thread messages are ignored;
- confirm known group thread reply works without `@bot`;
- confirm plan overview/full-plan flow needs no LLM;
- confirm task completion and requested full result;
- confirm unexpected reconnect sync versus intentional-off no-backfill;
- export diagnostics and inspect for secret/content leakage.

- [x] **Step 7: Final commit**

```powershell
git add electron src test docs package.json package-lock.json
git commit -m "docs: finalize communication gateway acceptance"
```

---

## V1 Non-Goals

- Multiple simultaneous communication channels or endpoints.
- Webhook deployment or a public callback server.
- Streaming all AI CLI output to Feishu.
- Media/file forwarding in either direction.
- Duplicating or remotely editing AI CLI launch configuration.
- Remote start, resume, stop, delete, relay toggle, or Gateway toggle from Feishu.
- LLM-generated summaries.
- Durable task queues, message bodies, full plans, or full results.
- Time-based decision expiration imposed by Gateway.

## Final Review Checklist

- [x] Search the plan and implementation for `TODO`, `TBD`, placeholder secrets, and unexplained ellipses.
- [x] Trace every accepted requirement to at least one test above.
- [x] Confirm the core imports no Feishu SDK/types.
- [x] Confirm every provider emits explicit lifecycle evidence and never infers completion from silence/token changes.
- [x] Confirm ordinary tasks use `sendTurn()` and all structured decisions use `respondDecision()`.
- [x] Confirm only one selected running private session permits unquoted fallback.
- [x] Confirm group routing always requires a known root/reply/thread.
- [x] Confirm Gateway off does not modify CLI process state.
- [x] Confirm secret-only hot swap keeps roots and failed hot swap keeps the old connection.
- [x] Confirm no fixed route/decision expiry or five-minute auto-deny remains.
- [x] Confirm `git diff --check`, full tests, build, and release verification pass.
