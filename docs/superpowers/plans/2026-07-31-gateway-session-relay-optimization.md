# Gateway Session Relay Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-session Gateway relay selection discoverable, consistent, and reliable from both the session list and each workbench pane, while preserving the single global Gateway switch.

**Architecture:** Keep `GatewayRuntime` and `gateway:set-session-relay` as the source of truth. Add one pure presentation model and one reusable `GatewayRelayToggle` component; session cards and workbench panes consume that component instead of duplicating Gateway logic. The Pinia store owns initialization de-duplication, per-session mutation locks, refresh, and failure recovery.

**Tech Stack:** Electron 32, Vue 3, Pinia, Ant Design Vue, Node.js ESM, Node built-in test runner, `@vue/compiler-sfc`.

## Global Constraints

- The workbench header continues to expose only the global Gateway switch and compact status.
- A session shortcut changes only that session's persisted relay selection; it never starts or stops the global Gateway.
- Relay selection is allowed while Gateway is off, unconfigured, connecting, or waiting for Feishu binding; forwarding begins only when all runtime conditions are ready.
- Stopping a session preserves its relay selection. Removing a session disables its relay route through the existing persistence cleanup.
- Session-level controls must distinguish “not selected”, “selected but waiting”, “actively forwarding”, “switching”, and “error”.
- All entry points use the same component, wording, color semantics, pending lock, and error handling.
- No task text, AI output, Feishu IDs, decisions, plans, or results enter renderer relay state.
- Existing unrelated untracked plan documents must not be staged or committed.
- Do not move or rewrite the existing public `v0.5.0` tag. Deliver this optimization as the next patch version.

---

## File Structure

**Create**

- `src/gatewayRelayPresentation.js` — pure conversion from Gateway/session state to a bounded relay-control view model.
- `src/components/gateway/GatewayRelayToggle.vue` — the only session-level relay control.
- `test/gateway-relay-presentation.test.mjs` — state matrix for the pure presentation model.
- `test/gateway-relay-template.test.mjs` — SFC structure and accessibility assertions for every entry point.

**Modify**

- `src/stores/gateway.js` — single-flight initialization, relay lookup, per-session pending locks, refresh and error recovery.
- `src/components/SessionCard.vue` — replace the current inline globe prototype with `GatewayRelayToggle`.
- `src/views/SessionDetail.vue` — replace pane-local toggle code with `GatewayRelayToggle`.
- `src/views/Workbench.vue` — initialize Gateway state for session cards.
- `src/components/gateway/GatewayConfigDrawer.vue` — use the same relay status wording in the detailed session list.
- `src/components/gateway/GatewayHeaderControl.vue` — keep the global-only surface; initialization becomes safe through the store single-flight.
- `package.json` — add the two new tests to `pretest`.
- `CHANGELOG.md` — document the user-visible session relay shortcuts.
- `docs/release-acceptance.md` — add the relay selection/effective-state acceptance matrix.

---

### Task 1: Define One Relay-Control State Model

**Files:**
- Create: `src/gatewayRelayPresentation.js`
- Create: `test/gateway-relay-presentation.test.mjs`

**Interfaces:**
- Consumes:

```js
deriveGatewayRelayControl({
  session: {
    relayEnabled: boolean,
    routeStatus: 'active' | 'waiting' | 'paused' | string,
    status: string
  } | null,
  gatewayPhase: string,
  pending: boolean
})
```

- Produces:

```js
{
  selected: boolean,
  effective: boolean,
  state: 'off' | 'switching' | 'paused' | 'waiting_binding' |
    'waiting_connection' | 'waiting_session' | 'forwarding' | 'error',
  label: string,
  tooltip: string,
  tone: 'default' | 'blue' | 'green' | 'orange' | 'red',
  nextEnabled: boolean
}
```

- [ ] **Step 1: Write the failing state-matrix test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveGatewayRelayControl } from '../src/gatewayRelayPresentation.js'

const session = (overrides = {}) => ({
  relayEnabled: true,
  routeStatus: 'active',
  status: 'idle',
  ...overrides
})

test('relay control distinguishes selection from effective forwarding', () => {
  assert.equal(deriveGatewayRelayControl({
    session: session({ relayEnabled: false }),
    gatewayPhase: 'connected',
    pending: false
  }).state, 'off')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'off',
    pending: false
  }).state, 'paused')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'waiting_binding',
    pending: false
  }).state, 'waiting_binding')
  assert.equal(deriveGatewayRelayControl({
    session: session({ routeStatus: 'waiting', status: 'stopped' }),
    gatewayPhase: 'connected',
    pending: false
  }).state, 'waiting_session')
  assert.deepEqual(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'connected',
    pending: false
  }), {
    selected: true,
    effective: true,
    state: 'forwarding',
    label: '正在转发',
    tooltip: '此会话正在通过 Gateway 转发',
    tone: 'green',
    nextEnabled: false
  })
})

test('pending and error states never look actively forwarded', () => {
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'connected',
    pending: true
  }).state, 'switching')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'error',
    pending: false
  }).state, 'error')
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test test/gateway-relay-presentation.test.mjs
```

Expected: FAIL because `src/gatewayRelayPresentation.js` does not exist.

- [ ] **Step 3: Implement the exact state priority**

Implement in this order:

1. `pending` → `switching`
2. missing session or `relayEnabled !== true` → `off`
3. `gatewayPhase === 'error'` → `error`
4. `gatewayPhase === 'off'` → `paused`
5. `gatewayPhase === 'waiting_binding'` → `waiting_binding`
6. `connecting` or `reconnecting` → `waiting_connection`
7. `gatewayPhase === 'connected' && routeStatus === 'active'` → `forwarding`
8. otherwise → `waiting_session`

Use these exact user-facing strings:

```js
const RELAY_STATES = {
  off: ['未选择转发', '点击选择此会话进行 Gateway 转发', 'default'],
  switching: ['正在更新', '正在保存此会话的转发选择', 'blue'],
  paused: ['已选择，Gateway 已关闭', '开启全局 Gateway 后将开始转发', 'blue'],
  waiting_binding: ['已选择，等待飞书绑定', '完成飞书绑定后将开始转发', 'orange'],
  waiting_connection: ['已选择，等待连接', 'Gateway 连接完成后将开始转发', 'orange'],
  waiting_session: ['已选择，等待会话', '会话可运行后将开始转发', 'orange'],
  forwarding: ['正在转发', '此会话正在通过 Gateway 转发', 'green'],
  error: ['已选择，Gateway 异常', '请打开 Gateway 设置检查连接状态', 'red']
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```powershell
node --test test/gateway-relay-presentation.test.mjs
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/gatewayRelayPresentation.js test/gateway-relay-presentation.test.mjs
git commit -m "refactor: define gateway relay presentation states"
```

---

### Task 2: Make Gateway Store Initialization and Relay Mutations Race-Safe

**Files:**
- Modify: `src/stores/gateway.js`
- Modify: `test/gateway-presentation.test.mjs`

**Interfaces:**
- Produces:

```js
gateway.relaySessionFor(sessionId) // session row or null
gateway.relayPendingFor(sessionId) // boolean
await gateway.setSessionRelayEnabled(sessionId, enabled)
```

- [ ] **Step 1: Extend the existing store source-contract test**

Add assertions:

```js
assert.match(source, /let initPromise = null/)
assert.match(source, /relayPendingById/)
assert.match(source, /relaySessionFor/)
assert.match(source, /relayPendingFor/)
assert.match(source, /GATEWAY_RELAY_BUSY/)
assert.match(source, /await this\.refreshSessions\(\)/)
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test test/gateway-presentation.test.mjs
```

Expected: FAIL on missing initialization and pending-lock fields.

- [ ] **Step 3: Implement single-flight initialization**

Add a module-level `initPromise` beside the existing unsubscribe handle. `init()` must:

- install the state listener once;
- return immediately when `initialized`;
- return the existing `initPromise` while initialization is running;
- clear `initPromise` in `finally`;
- leave `initialized === false` when any initial IPC call fails.

Use:

```js
let initPromise = null

async init() {
  if (!unsubscribe) {
    unsubscribe = ipc.onGatewayState((state) => {
      this.runtime = { ...EMPTY_STATE, ...state }
    })
  }
  if (this.initialized) return
  if (initPromise) return initPromise
  this.loading = true
  initPromise = Promise.all([
    ipc.getGatewayState(),
    ipc.getGatewayConfiguration(),
    ipc.listGatewaySessions()
  ]).then(([runtime, configuration, sessions]) => {
    this.runtime = { ...EMPTY_STATE, ...runtime }
    this.configuration = configuration
    this.sessions = sessions
    this.initialized = true
  }).finally(() => {
    this.loading = false
    initPromise = null
  })
  return initPromise
}
```

- [ ] **Step 4: Implement per-session mutation locking**

Add `relayPendingById: {}` to state and getters:

```js
relaySessionFor: (state) => (sessionId) =>
  state.sessions.find((item) =>
    item.id === sessionId || item.sessionId === sessionId
  ) || null,
relayPendingFor: (state) => (sessionId) =>
  state.relayPendingById[sessionId] === true
```

Replace the relay action with:

```js
async setSessionRelayEnabled(sessionId, enabled) {
  if (this.relayPendingById[sessionId]) {
    throw Object.assign(new Error('该会话的转发状态正在更新'), {
      code: 'GATEWAY_RELAY_BUSY'
    })
  }
  this.relayPendingById = {
    ...this.relayPendingById,
    [sessionId]: true
  }
  try {
    const result = await ipc.setSessionRelayEnabled(sessionId, Boolean(enabled))
    if (result?.accepted === false) {
      throw Object.assign(new Error('会话转发状态更新失败'), {
        code: result.reason || 'GATEWAY_RELAY_REJECTED'
      })
    }
    await this.refreshSessions()
    this.runtime = await ipc.getGatewayState()
    return result
  } catch (error) {
    await Promise.allSettled([
      this.refreshSessions(),
      ipc.getGatewayState().then((state) => {
        this.runtime = { ...EMPTY_STATE, ...state }
      })
    ])
    throw error
  } finally {
    const next = { ...this.relayPendingById }
    delete next[sessionId]
    this.relayPendingById = next
  }
}
```

- [ ] **Step 5: Remove dead prototype state**

Remove the unused `relaySessionCount` getter unless the header or settings drawer consumes it in this same change. Do not retain speculative state.

- [ ] **Step 6: Run Gateway tests**

Run:

```powershell
npm run pretest
```

Expected: all Gateway tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/stores/gateway.js test/gateway-presentation.test.mjs
git commit -m "fix: serialize session relay updates"
```

---

### Task 3: Build the Reusable Session Relay Toggle

**Files:**
- Create: `src/components/gateway/GatewayRelayToggle.vue`
- Create: `test/gateway-relay-template.test.mjs`

**Interfaces:**
- Props:

```js
{
  sessionId: { type: String, required: true },
  compact: { type: Boolean, default: false }
}
```

- [ ] **Step 1: Write the failing SFC contract test**

Parse the SFC with `@vue/compiler-sfc` and assert:

```js
assert.match(source, /aria-label/)
assert.match(source, /gateway\.relayPendingFor\(props\.sessionId\)/)
assert.match(source, /deriveGatewayRelayControl/)
assert.match(source, /message\.error/)
assert.match(source, /@click\.stop="toggleRelay"/)
assert.doesNotMatch(source, /v-html/)
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test test/gateway-relay-template.test.mjs
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component**

The component must:

- read the session row and pending state from the Gateway store;
- derive all copy and colors through `deriveGatewayRelayControl`;
- render an Ant Design text button inside a tooltip;
- show a loading spinner while pending;
- use `aria-pressed` for selection and an exact dynamic `aria-label`;
- call only `gateway.setSessionRelayEnabled(sessionId, state.nextEnabled)`;
- show `message.error(error.message || '会话转发状态更新失败')` on failure;
- never toggle the global Gateway state.

The accessible label must be:

```js
`${view.label}：${sessionName || '当前会话'}`
```

Use one small relay/globe icon inside this component. Remove duplicated inline SVG from consumers in Task 4.

- [ ] **Step 4: Run component tests**

Run:

```powershell
node --test test/gateway-relay-template.test.mjs test/gateway-relay-presentation.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/components/gateway/GatewayRelayToggle.vue test/gateway-relay-template.test.mjs
git commit -m "feat: add reusable gateway relay toggle"
```

---

### Task 4: Replace Both Prototype Entry Points

**Files:**
- Modify: `src/components/SessionCard.vue`
- Modify: `src/views/SessionDetail.vue`
- Modify: `src/views/Workbench.vue`
- Modify: `test/gateway-relay-template.test.mjs`

**Interfaces:**
- Consumes: `GatewayRelayToggle(sessionId, compact)`

- [ ] **Step 1: Add failing integration-template assertions**

Assert:

```js
assert.match(sessionCard, /<GatewayRelayToggle[^>]*:session-id="session\.id"/)
assert.match(sessionDetail, /<GatewayRelayToggle[^>]*:session-id="pane\.sessionId"/)
assert.doesNotMatch(sessionCard, /relaySwitching|relay-icon|toggleRelay/)
assert.doesNotMatch(sessionDetail, /paneRelayOn|togglePaneRelay/)
assert.match(workbench, /gateway\.init\(\)/)
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test test/gateway-relay-template.test.mjs
```

Expected: FAIL while consumers still contain prototype code.

- [ ] **Step 3: Replace the session-card prototype**

In `SessionCard.vue`:

- render `<GatewayRelayToggle :session-id="session.id" compact />` before the permission-tier tag;
- remove `useGatewayStore`, `relaySwitching`, `relayOn`, `relayTooltip`, `toggleRelay`, inline SVG, and relay-specific styles;
- keep `@click.stop` encapsulated inside the reusable component so clicking the relay button never opens the session.

- [ ] **Step 4: Replace the workbench-pane prototype**

In `SessionDetail.vue`:

- render `<GatewayRelayToggle v-if="pane.sessionId" :session-id="pane.sessionId" compact />` beside the History/Terminal button;
- remove `paneRelayOn()` and `togglePaneRelay()`;
- keep `gateway.init()` in the page initializer; store single-flight makes the existing header initializer harmless.

- [ ] **Step 5: Keep list-page initialization**

In `Workbench.vue`, retain `gateway.init()` in the existing `Promise.all` so session cards receive relay rows before interaction. Do not add a second global switch to this page.

- [ ] **Step 6: Run template and build verification**

Run:

```powershell
node --test test/gateway-relay-template.test.mjs
npm run build
```

Expected: tests pass and renderer build succeeds.

- [ ] **Step 7: Commit**

```powershell
git add src/components/SessionCard.vue src/views/SessionDetail.vue src/views/Workbench.vue test/gateway-relay-template.test.mjs
git commit -m "feat: expose session relay shortcuts"
```

---

### Task 5: Align Settings and Runtime Feedback

**Files:**
- Modify: `src/components/gateway/GatewayConfigDrawer.vue`
- Modify: `src/components/gateway/GatewayHeaderControl.vue`
- Modify: `test/gateway-settings-template.test.mjs`
- Modify: `test/gateway-header-template.test.mjs`

**Interfaces:**
- Consumes: `deriveGatewayRelayControl`

- [ ] **Step 1: Add failing copy and boundary assertions**

Require:

- the header contains only the global switch, phase/status button, and settings navigation;
- the drawer session rows use “未选择转发 / 已选择，等待… / 正在转发” rather than treating `relayEnabled` as proof of active forwarding;
- the drawer retains “重新同步” for selected sessions;
- neither component renders task/message content.

- [ ] **Step 2: Run tests and verify they fail on inconsistent wording**

Run:

```powershell
node --test test/gateway-settings-template.test.mjs test/gateway-header-template.test.mjs
```

- [ ] **Step 3: Use the shared presentation state in the drawer**

For each session row, derive status from:

```js
deriveGatewayRelayControl({
  session: item,
  gatewayPhase: gateway.runtime.phase,
  pending: gateway.relayPendingFor(item.id)
})
```

The detailed drawer may show the text label and queue count. The card and pane controls remain compact icons with tooltips.

- [ ] **Step 4: Improve global header tooltip without adding controls**

The tooltip may include:

```text
已选择 N 个会话；当前可转发 M 个会话
```

Do not add session checkboxes, target selection, binding actions, or configuration fields to the header.

- [ ] **Step 5: Run tests**

Run:

```powershell
node --test test/gateway-settings-template.test.mjs test/gateway-header-template.test.mjs test/gateway-relay-presentation.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add src/components/gateway/GatewayConfigDrawer.vue src/components/gateway/GatewayHeaderControl.vue test/gateway-settings-template.test.mjs test/gateway-header-template.test.mjs
git commit -m "refactor: align gateway relay status feedback"
```

---

### Task 6: Acceptance, Documentation, and Patch Release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/release-acceptance.md`

**Interfaces:**
- Produces: verified Windows installer and portable artifacts for the next patch version.

- [ ] **Step 1: Register new tests in `pretest`**

Append:

```text
test/gateway-relay-presentation.test.mjs
test/gateway-relay-template.test.mjs
```

- [ ] **Step 2: Add the manual acceptance matrix**

Document and execute:

| Session selection | Global Gateway | Binding/connection | Session state | Expected control | Expected network behavior |
| --- | --- | --- | --- | --- | --- |
| Off | Any | Any | Any | 未选择转发 | No session root/message |
| On | Off | Any | Any | 已选择，Gateway 已关闭 | No send; selection persists |
| On | On | Unbound | Any | 已选择，等待飞书绑定 | No send |
| On | On | Connecting | Any | 已选择，等待连接 | No send |
| On | On | Connected | Stopped/offline | 已选择，等待会话 | No root until ready |
| On | On | Connected | Idle/running | 正在转发 | Root exists/reused |
| Switching | Any | Any | Any | 正在更新; control disabled | Exactly one IPC mutation |
| Failed mutation | Any | Any | Any | Restored server state + visible error | No false success |

- [ ] **Step 3: Update changelog and version**

Add a patch release entry describing:

- session-card relay shortcut;
- pane-header relay shortcut;
- distinct selected/effective states;
- duplicate-click protection and visible failure recovery.

Use `npm version patch --no-git-tag-version` so `package.json` and `package-lock.json` stay aligned. Do not reuse or move `v0.5.0`.

- [ ] **Step 4: Run the complete verification gate**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected:

- Gateway and full project tests pass;
- production renderer/main/preload build succeeds;
- no whitespace errors.

- [ ] **Step 5: Request independent code review**

The reviewer must specifically inspect:

- duplicate-click and cross-entry concurrency;
- selected versus effective-forwarding semantics;
- failure feedback and state recovery;
- no accidental global Gateway toggle;
- no duplicate inline implementations;
- template accessibility;
- unchanged routing/security boundaries.

Fix all Critical and Important findings, then rerun Step 4.

- [ ] **Step 6: Build and verify Windows artifacts**

Run:

```powershell
npm run dist:win
npm run verify:release
Get-FileHash "dist\UCLI-Setup-*-x64.exe","dist\UCLI-Portable-*-x64.exe" -Algorithm SHA256
```

Expected: installer, portable executable, blockmap, and `latest.yml` all match the patch version.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json CHANGELOG.md docs/release-acceptance.md
git commit -m "chore: prepare gateway relay optimization release"
```

---

## Final Self-Review

- Spec coverage: global-only header, session-card shortcut, pane shortcut, settings detail, persisted selection, effective-state feedback, pending lock, failure recovery, tests, docs, and release packaging all map to explicit tasks.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: every consumer uses `deriveGatewayRelayControl`, `relaySessionFor`, `relayPendingFor`, and `GatewayRelayToggle`.
- Scope boundary: no Gateway protocol, Feishu binding, routing, decision, snapshot, or AI CLI adapter semantics are changed.
- Release safety: the existing `v0.5.0` tag is not rewritten; the optimization ships as a patch release.
