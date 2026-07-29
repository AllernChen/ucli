# Multi-Pane Complete History Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each AI CLI's native interactive TUI while giving every 1/2/4-pane session a complete, selectable, independently scrollable history view.

**Architecture:** Treat the xterm instance as a live interactive screen, not as conversation storage. Load provider-owned history through a normalized main-process history service and display it in a read-only pane view that stays beside the mounted terminal. Synchronize PTY dimensions from xterm resize events so compact panes render at their real row/column size.

**Tech Stack:** Electron IPC, Vue 3, xterm.js 6, node-pty, Node test runner, Claude/Codex JSONL transcripts, `opencode export --sanitize`.

## Global Constraints

- Windows remains the priority platform; macOS behavior must not regress.
- UCLI must not change the AI CLI terminal page, key bindings, slash commands, or native interaction model.
- The native xterm instance must remain mounted when history is displayed so switching back preserves the live TUI screen and input state.
- Provider history is read only and loaded on demand; this feature must not delete or rewrite Claude, Codex, or OpenCode source records.
- History content must be rendered as text, never with `v-html`.
- Existing usage logs, token statistics, cost statistics, and retention behavior remain unchanged.
- All 1/2/4-pane layouts must support history scrolling and selection independently.

## Root Cause Record

1. UCLI currently treats one xterm instance as both the native interactive screen and the history viewer.
2. xterm creates its normal buffer with scrollback, but creates the alternate buffer with `hasScrollback = false` (`node_modules/@xterm/xterm/src/common/buffer/BufferSet.ts`). Native screen-oriented CLIs can therefore render correctly while offering no scrollback, even when UCLI configures `scrollback: 5000`.
3. Claude and Codex replay transcript text into xterm and then start their native TUI. The TUI can activate/clear the alternate screen, making replayed normal-buffer content unavailable while the TUI is active.
4. OpenCode has no `replayHistory()` implementation. `session:attach-terminal` therefore loads no OpenCode history; the user sees only output emitted by the current TUI process.
5. Every PTY starts at `120x40`, while four-pane xterms are much smaller. Resize propagation depends on a DOM `ResizeObserver` after `fit()`, so the first TUI frame and history replay can be produced for stale dimensions. This amplifies clipping and redraw loss but is not the primary scrollback cause.
6. Raw terminal data is deliberately excluded from the renderer activity list, so there is no second complete UCLI buffer to fall back to.

---

### Task 1: Normalize Provider-Owned Conversation History

**Files:**
- Create: `electron/sessionHistory.js`
- Create: `test/session-history.test.mjs`
- Create: `test/fixtures/history/claude.jsonl`
- Create: `test/fixtures/history/codex.jsonl`
- Reuse: `test/fixtures/opencode/session-export.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseClaudeHistory(lines) -> HistoryItem[]`
- Produces: `parseCodexHistory(lines) -> HistoryItem[]`
- Produces: `parseOpenCodeHistory(source) -> HistoryItem[]`
- Produces: `historyPage(items, { before, limit }) -> { items, nextBefore, complete }`
- `HistoryItem`: `{ id: string, role: 'user'|'assistant'|'tool'|'system', text: string, timestamp: number|null }`

- [ ] **Step 1: Add redacted fixtures and write failing parser tests**

```js
test('all providers normalize complete user and assistant turns', () => {
  for (const items of [claudeItems, codexItems, openCodeItems]) {
    assert.deepEqual(items.filter(item => item.role !== 'system').map(item => item.role), [
      'user', 'assistant', 'user', 'assistant'
    ])
    assert.ok(items.every(item => typeof item.text === 'string' && item.text.length > 0))
  }
})

test('history pages load newest items first and page backward without overlap', () => {
  const newest = historyPage(items, { before: null, limit: 2 })
  const older = historyPage(items, { before: newest.nextBefore, limit: 2 })
  assert.deepEqual([...older.items, ...newest.items].map(item => item.id), items.map(item => item.id))
  assert.equal(older.complete, true)
})
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `node --test test/session-history.test.mjs`

Expected: FAIL because `electron/sessionHistory.js` and its exports do not exist.

- [ ] **Step 3: Implement minimal normalized parsers and cursor pagination**

```js
export function historyPage(items, { before = null, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100))
  const end = before == null ? items.length : Math.max(0, Math.min(items.length, Number(before)))
  const start = Math.max(0, end - safeLimit)
  return {
    items: items.slice(start, end),
    nextBefore: start > 0 ? start : null,
    complete: start === 0
  }
}
```

Implement provider parsers with explicit role/type allowlists. Include user text, assistant text, tool name/output summaries, and timestamps; ignore reasoning payloads and malformed records. Do not render raw serialized objects when no approved text field exists.

- [ ] **Step 4: Run the parser test and full history-related tests**

Run: `node --test test/session-history.test.mjs test/adapter-stats.test.mjs test/opencode-stats.test.mjs`

Expected: PASS.

- [ ] **Step 5: Register the test and commit**

```powershell
git add electron/sessionHistory.js test/session-history.test.mjs test/fixtures/history test/fixtures/opencode/session-export.json package.json
git commit -m "feat: normalize provider session history"
```

---

### Task 2: Load History Safely in the Main Process

**Files:**
- Create: `electron/sessionHistoryService.js`
- Modify: `electron/sessionDiscovery.js`
- Modify: `electron/openCodeStats.js`
- Modify: `electron/orchestrator.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Create: `test/session-history-service.test.mjs`
- Create: `test/session-history-ipc.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 parser and pagination functions.
- Produces: `createSessionHistoryService({ resolveSession, readFile, exportOpenCode })`
- Produces: `service.getPage(sessionId, { before, limit }) -> Promise<HistoryPage>`
- Produces renderer bridge: `ipc.getSessionHistory(sessionId, options)` on `session:get-history`.

- [ ] **Step 1: Write failing service tests for all providers and invalid sessions**

```js
test('history service resolves source paths only from the stored session', async () => {
  const page = await service.getPage('ucli-session-1', { before: null, limit: 100 })
  assert.equal(page.source, 'claude')
  assert.equal(page.items[0].role, 'user')
  assert.equal(readCalls[0], storedTranscriptPath)
})

test('renderer cannot pass a transcript path', async () => {
  await assert.rejects(
    service.getPage('../arbitrary-file', { before: null, limit: 100 }),
    /session not found/
  )
})
```

Add an OpenCode test that injects `exportOpenCode`, verifies one sanitized export call, and returns normalized items.

- [ ] **Step 2: Run service tests and verify RED**

Run: `node --test test/session-history-service.test.mjs test/session-history-ipc.test.mjs`

Expected: FAIL because the service and IPC methods do not exist.

- [ ] **Step 3: Expose shared server-side source resolvers**

Export a Claude transcript resolver from `sessionDiscovery.js`. Extract the Codex rollout resolver currently embedded in `CodexAdapter` into a pure exported helper. Extend `openCodeStats.js` with:

```js
export function exportOpenCodeSession(sessionId, options = {}) {
  return runOpenCodeExport(sessionId, options).then(source => source || null)
}
```

Use the existing Windows executable resolution and `--sanitize`; retain the 15-second timeout and 8 MiB output cap.

- [ ] **Step 4: Implement the service with a short per-session cache**

```js
const CACHE_TTL_MS = 5000

async function getPage(sessionId, options = {}) {
  const session = resolveSession(sessionId)
  if (!session) throw new Error('session not found')
  const items = await loadProviderItems(session)
  return { source: session.adapterId, ...historyPage(items, options) }
}
```

Cache parsed items for at most five seconds and invalidate when `before === null` after a completed turn. Never accept a filesystem path or executable name from renderer arguments.

- [ ] **Step 5: Add IPC handlers and renderer bridge**

```js
ipcMain.handle('session:get-history', (_event, sessionId, options) =>
  historyService.getPage(sessionId, options)
)
```

Add matching preload and `src/ipc.js` methods. Keep the response structured-clone-safe.

- [ ] **Step 6: Run focused and complete tests**

Run: `node --test test/session-history.test.mjs test/session-history-service.test.mjs test/session-history-ipc.test.mjs`

Run: `npm test`

Expected: all tests pass, with only the existing macOS packaging skip.

- [ ] **Step 7: Commit**

```powershell
git add electron/sessionHistoryService.js electron/sessionDiscovery.js electron/openCodeStats.js electron/orchestrator.js electron/preload.js src/ipc.js test/session-history-service.test.mjs test/session-history-ipc.test.mjs package.json
git commit -m "feat: expose complete session history pages"
```

---

### Task 3: Add a Per-Pane Read-Only History View

**Files:**
- Create: `src/components/PaneHistory.vue`
- Create: `src/historyPresentation.js`
- Modify: `src/views/SessionDetail.vue`
- Create: `test/history-presentation.test.mjs`
- Create: `test/pane-history-integration.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ipc.getSessionHistory(sessionId, { before, limit })`.
- Produces: `<PaneHistory :session-id="id" :active="active" />`.
- Produces: `mergeHistoryPage(current, page) -> HistoryItem[]` with ID de-duplication.

- [ ] **Step 1: Write failing presentation and source-integration tests**

```js
test('older pages prepend without duplicates and preserve chronological order', () => {
  assert.deepEqual(
    mergeHistoryPage([{ id: '3' }, { id: '4' }], { items: [{ id: '1' }, { id: '2' }, { id: '3' }] })
      .map(item => item.id),
    ['1', '2', '3', '4']
  )
})

test('session pane keeps terminal mounted while history is visible', async () => {
  assert.match(source, /v-show="pane\.viewMode === 'terminal'"/)
  assert.match(source, /<PaneHistory/)
  assert.doesNotMatch(source, /v-html/)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/history-presentation.test.mjs test/pane-history-integration.test.mjs`

Expected: FAIL because the component/helper and view-mode wiring do not exist.

- [ ] **Step 3: Implement plain-text pagination presentation**

```js
export function mergeHistoryPage(current, page) {
  const byId = new Map([...page.items, ...current].map(item => [item.id, item]))
  return [...byId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
}
```

`PaneHistory.vue` loads the newest 100 items, prepends older pages when the user reaches the top or clicks “加载更早记录”, preserves scroll position after prepend, and displays loading/error/empty states.

- [ ] **Step 4: Wire a history toggle into each pane without replacing xterm**

Add `viewMode: 'terminal' | 'history'` to the renderer-only pane object. Add a header button labeled “历史” / “返回终端”. Render:

```vue
<div v-show="pane.viewMode === 'terminal'" :ref="el => setPaneRef(i, el)" class="pane-terminal"></div>
<PaneHistory
  v-show="pane.viewMode === 'history'"
  :session-id="pane.sessionId"
  :active="pane.viewMode === 'history'"
/>
```

Do not dispose, clear, resize to zero, or recreate the terminal when toggling. On return to terminal, call `fit()` once and focus the pane.

- [ ] **Step 5: Add selectable, independently scrolling history styles**

```css
.pane-history {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  user-select: text;
  background: #fff;
}
.history-text { white-space: pre-wrap; overflow-wrap: anywhere; }
```

Each pane owns its own scroll container and loading cursor. Do not use the page-level scrollbar.

- [ ] **Step 6: Run focused tests, full tests, and build**

Run: `node --test test/history-presentation.test.mjs test/pane-history-integration.test.mjs test/workbench-route-retention.test.mjs`

Run: `npm test`

Run: `npm run build`

Expected: all commands succeed.

- [ ] **Step 7: Commit**

```powershell
git add src/components/PaneHistory.vue src/historyPresentation.js src/views/SessionDetail.vue test/history-presentation.test.mjs test/pane-history-integration.test.mjs package.json
git commit -m "feat: add per-pane complete history viewer"
```

---

### Task 4: Make Four-Pane PTY Sizing Deterministic

**Files:**
- Create: `src/terminalResize.js`
- Modify: `src/views/SessionDetail.vue`
- Create: `test/terminal-resize.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `terminalSizeChanged(previous, next) -> boolean`.
- Produces internal `syncPaneTerminalSize(index)` that fits xterm and sends exactly one IPC resize for each changed `{ cols, rows }`.

- [ ] **Step 1: Write failing resize-deduplication tests**

```js
test('terminal resize is sent only for valid changed dimensions', () => {
  assert.equal(terminalSizeChanged(null, { cols: 58, rows: 12 }), true)
  assert.equal(terminalSizeChanged({ cols: 58, rows: 12 }, { cols: 58, rows: 12 }), false)
  assert.equal(terminalSizeChanged({ cols: 58, rows: 12 }, { cols: 0, rows: 0 }), false)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/terminal-resize.test.mjs`

Expected: FAIL because `src/terminalResize.js` does not exist.

- [ ] **Step 3: Implement size comparison and per-pane synchronization**

```js
export function terminalSizeChanged(previous, next) {
  return Boolean(next?.cols > 0 && next?.rows > 0 &&
    (previous?.cols !== next.cols || previous?.rows !== next.rows))
}
```

Store `lastPtySize` on each pane. Subscribe to `term.onResize(({ cols, rows }) => ...)` and send `terminalResize` only when dimensions change. Keep `ResizeObserver` responsible for calling `fit()`; do not send stale `term.cols/term.rows` before fit completes.

- [ ] **Step 4: Synchronize at all structural transitions**

Call `syncPaneTerminalSize(i)` after initial `term.open()`, after assigning a session, after switching 1/2/4 layouts, after showing the session list, and after leaving either full-screen mode. Use `nextTick()` before fitting.

- [ ] **Step 5: Run tests and build**

Run: `node --test test/terminal-resize.test.mjs test/workbench-keyboard.test.mjs`

Run: `npm test`

Run: `npm run build`

Expected: all commands succeed.

- [ ] **Step 6: Commit**

```powershell
git add src/terminalResize.js src/views/SessionDetail.vue test/terminal-resize.test.mjs package.json
git commit -m "fix: synchronize compact pane terminal dimensions"
```

---

### Task 5: Manual Provider Matrix and Release Readiness

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/release-checklist.md` if it exists; otherwise modify `README.md` under the testing section.

**Interfaces:**
- Consumes all previous tasks.
- Produces a verified Windows release candidate with unchanged native CLI interaction and complete per-pane history.

- [ ] **Step 1: Run automated verification**

Run: `npm test`

Run: `npm run build`

Expected: tests pass with only the existing macOS-specific skip; production build exits 0.

- [ ] **Step 2: Execute the Windows 1/2/4-pane matrix**

For Claude Code, Codex, and OpenCode, verify all of the following in each layout:

- Native terminal accepts typing, slash commands, interruption, copy, paste, and provider-native mouse behavior unchanged.
- “历史” opens a selectable text view in only that pane.
- Mouse wheel scrolls that pane's history without moving another pane.
- “加载更早记录” eventually reaches the first user turn and reports completion.
- Switching back to terminal preserves the live TUI screen and accepts input immediately.
- Switching layout or full-screen mode produces no clipped rows and restores the correct PTY dimensions.

- [ ] **Step 3: Verify provider-specific recovery**

- Claude: restore an imported native session and confirm the first and last turns appear.
- Codex: restore a provider-switched session and confirm history loads without using the missing historical provider.
- OpenCode: restore with `--session`, confirm export-based history contains messages older than the current TUI viewport.
- Missing/deleted provider source: show “源历史记录不可用” without closing or restarting the live CLI.

- [ ] **Step 4: Document the behavior and commit**

Add a changelog entry explaining that interactive TUI and read-only history are intentionally separate views.

```powershell
git add CHANGELOG.md README.md docs/release-checklist.md
git commit -m "docs: add multi-pane history acceptance matrix"
```

Only add files that exist or were intentionally modified; do not create an empty release checklist.

## Self-Review

- Spec coverage: independent scrolling, selection, complete provider history, unchanged native TUI, 1/2/4 panes, OpenCode completeness, and compact-pane sizing each map to a task.
- Placeholder scan: no implementation step relies on unspecified follow-up work.
- Type consistency: `HistoryItem`, `HistoryPage`, `getSessionHistory`, and `mergeHistoryPage` names are consistent across service, IPC, renderer, and tests.
- Scope boundary: raw PTY recording and duplicate conversation persistence are intentionally excluded; provider-owned sources remain authoritative.
