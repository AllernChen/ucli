# Work Summary Task Lifecycle Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make work-summary generation reliably reach Claude through a fresh workspace, project canonical reports as live manageable tasks, and close rename/note/delete lifecycle behavior without restoring a second task truth source.

**Architecture:** `summary_reports` remains the canonical task/report record and gains additive title/note fields. Claude delivery becomes a bounded transcript-confirmed submit state machine; main-process progress publishes the queued report before preparation, while the renderer reconciles unknown progress IDs through the existing report API. Task edits and deletes flow through narrow summary IPC and synchronize or remove only the UCLI-owned session projection, never the CLI-native transcript.

**Tech Stack:** Electron main/preload IPC, Vue 3 + Pinia + Ant Design Vue, sql.js SQLite persistence, Node.js built-in test runner, electron-vite.

**Spec:** `docs/superpowers/specs/2026-08-25-work-summary-task-lifecycle-repair-design.md`

## Global Constraints

- `summary_reports` is the only business truth for task metadata, status, versions, current-version selection, and report content.
- Do not restore `summaryTasks`, `taskNote`-encoded generation arrays, renderer file polling, or `workLogs` completion inference.
- Default task title is `工作总结（<周期>）YYYY-MM-DD HH:mm`; version remains a separate `vN` field/tag.
- Editing changes only task title and note; Markdown, period, version, executor, model, and native transcript are immutable through this feature.
- Title is trimmed, 1–120 characters, and rejects line breaks/NUL/control characters. Note is at most 1000 characters, permits ordinary line breaks, and rejects NUL/unsafe control characters.
- Deleting a task removes the canonical report, controlled workspace, and exclusive UCLI session projection. It must not delete Claude/Codex/OpenCode/U-Code native transcripts.
- Active deletion cancels and settles the run before canonical deletion; inability to stop must preserve the task.
- Prompt, transcript, tool payload, credentials, absolute workspace paths, and raw provider output must not enter database metadata, logs, or renderer IPC.
- Claude delivery stays fail-closed and bounded. No automatic model replay occurs after application restart.
- Preserve all unrelated tracked and untracked user files.

## File Map

- Create `shared/summaryTaskContracts.js`: pure cross-process title, metadata-validation, and status-presentation contract; no Node/Electron imports.
- Create `src/components/summaries/SummaryReportListItem.vue`: one canonical report task card and its state-aware actions.
- Create `src/components/summaries/SummaryTaskEditDialog.vue`: title/note editor only.
- Modify `electron/adapters/claudeAdapter.js`: bounded Claude submit/confirm state machine and immediate gateway rescan after transcript confirmation.
- Modify `electron/summaries/interactiveSummaryContracts.js`: shared 30-second outer delivery deadline.
- Modify `electron/summaries/interactiveSummaryJobService.js`: initial preparing publication and canonical default session name.
- Modify `electron/persistence/db.js`: additive migration, report mapping, task metadata transaction, and exclusive session removal during report deletion.
- Modify `electron/summaries/reportRepository.js`: canonical task normalization, creation defaults, update-task facade, and extended deletion result.
- Modify `electron/orchestrator.js`: IPC validation, edit synchronization, active cancel-before-delete, and shared UCLI session projection cleanup.
- Modify `electron/preload.js` and `src/ipc.js`: narrow `summary:update-task` bridge.
- Modify `src/stores/summaries.js`: unknown-report progress reconciliation, task edits, and deletion result handling.
- Modify `src/components/summaries/WorkSummaryPanel.vue`, `SummaryHistory.vue`, and `SummaryReportView.vue`: task cards, Chinese status presentation, edit/delete entry points, and correct period display.
- Modify focused tests under `test/claude-gateway-capabilities.test.mjs`, `test/interactive-summary-session-runtime.test.mjs`, `test/interactive-summary-job-service.test.mjs`, `test/summary-db-migration.test.mjs`, `test/usage-ledger-db.test.mjs`, `test/summary-ipc.test.mjs`, `test/summary-view.test.mjs`, and `test/summary-view-mounted.test.mjs`.
- Modify `CONTEXT.md`, `CHANGELOG.md`, and `docs/qa/2026-08-24-work-summary-closure-acceptance.md` with the final contract and verified evidence.

---

### Task 1: Make Claude Turn Submission Survive Fresh-Workspace Trust

**Files:**
- Modify: `electron/adapters/claudeAdapter.js:24`
- Modify: `electron/adapters/claudeAdapter.js:578`
- Modify: `electron/summaries/interactiveSummaryContracts.js:7`
- Test: `test/claude-gateway-capabilities.test.mjs:215`
- Test: `test/interactive-summary-session-runtime.test.mjs:238`
- Test: `test/interactive-summary-job-service.test.mjs:418`

**Interfaces:**
- Consumes: existing `ClaudeAdapter.writeInput(data)`, `_waitTurnDelivered(fingerprint, sinceMs)`, `_extractStats()`, and runtime `deliver(sessionId, text, { timeoutMs })`.
- Produces: `ClaudeAdapter._waitTurnDelivered(fingerprint, sinceMs, timeoutMs = 8_000): Promise<boolean>` and a public `sendTurn(text): Promise<boolean>` that performs at most two text writes and two submit-only pulses before returning false.
- Produces: `INTERACTIVE_SUMMARY_DELIVERY_TIMEOUT_MS = 30_000` shared by job service and session runtime.

- [ ] **Step 1: Write the failing Claude submission tests**

Add public-interface tests that prove a transcript-confirmed early success does not retry, and that a fresh-workspace sequence uses submit-only recovery before retyping:

```js
test('Claude sendTurn confirms once without duplicate input', async () => {
  const adapter = new ClaudeAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  const writes = []
  let scans = 0
  adapter.ptyProc = { write: value => writes.push(value), kill() {} }
  adapter._waitTurnDelivered = async () => true
  adapter._extractStats = () => { scans += 1 }

  assert.equal(await adapter.sendTurn('summary prompt'), true)
  assert.deepEqual(writes, ['summary prompt\r'])
  assert.equal(scans, 1)
  await adapter.dispose()
})

test('Claude sendTurn pulses submit before one bounded retype', async () => {
  const adapter = new ClaudeAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  const writes = []
  const windows = []
  const outcomes = [false, false, false, true]
  let scans = 0
  adapter.ptyProc = { write: value => writes.push(value), kill() {} }
  adapter._waitTurnDelivered = async (_fingerprint, _sinceMs, timeoutMs) => {
    windows.push(timeoutMs)
    return outcomes.shift()
  }
  adapter._extractStats = () => { scans += 1 }

  assert.equal(await adapter.sendTurn('summary prompt'), true)
  assert.deepEqual(writes, [
    'summary prompt\r',
    '\r',
    '\x1b\x1b',
    'summary prompt\r',
    '\r'
  ])
  assert.deepEqual(windows, [8_000, 8_000, 500, 8_000])
  assert.equal(scans, 1)
  await adapter.dispose()
})
```

- [ ] **Step 2: Run the Claude tests and confirm RED**

Run:

```powershell
node --test test/claude-gateway-capabilities.test.mjs
```

Expected: FAIL because `_waitTurnDelivered` does not accept a bounded window, `sendTurn` writes duplicate text immediately, and it does not trigger an immediate gateway scan.

- [ ] **Step 3: Implement the bounded Claude submit state machine**

Use explicit constants and a single confirmation helper:

```js
const TURN_DELIVERY_WINDOW_MS = 8000
const TURN_RETYPE_SETTLE_MS = 500
const TURN_DELIVERY_POLL_MS = 400

_waitTurnDelivered(fingerprint, sinceMs, timeoutMs = TURN_DELIVERY_WINDOW_MS) {
  return new Promise((resolve) => {
    const started = Date.now()
    const step = () => {
      if (this._disposed || !this.ptyProc) return resolve(false)
      if (this._scanProjectTranscripts(fingerprint, sinceMs)) return resolve(true)
      const elapsed = Date.now() - started
      if (elapsed >= timeoutMs) return resolve(false)
      setTimeout(step, Math.min(TURN_DELIVERY_POLL_MS, timeoutMs - elapsed))
    }
    step()
  })
}

async _confirmTurnDelivery(fingerprint, sinceMs, timeoutMs) {
  const delivered = await this._waitTurnDelivered(fingerprint, sinceMs, timeoutMs)
  if (delivered) this._extractStats()
  return delivered
}

async sendTurn(text) {
  if (!this.ptyProc) return false
  const fingerprint = makeTurnFingerprint(text)
  const sinceMs = Date.now()

  this.writeInput(text + '\r')
  if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)) return true

  this.writeInput('\r')
  if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)) return true

  this.writeInput('\x1b\x1b')
  this.writeInput(text + '\r')
  if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_RETYPE_SETTLE_MS)) return true

  this.writeInput('\r')
  return this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)
}
```

Keep the same `sinceMs` and fingerprint for every stage. Do not write prompt text after any stage confirms delivery.

- [ ] **Step 4: Expand the outer delivery contract test and implementation**

Change the shared constant:

```js
export const INTERACTIVE_SUMMARY_DELIVERY_TIMEOUT_MS = 30_000
```

Change the mock-timer runtime regression from 17 seconds to 26 seconds:

```js
test('default delivery window allows the bounded Claude trust recovery to confirm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { adapter, runtime } = harness()
  adapter.sendTurn = () => new Promise(resolve => {
    setTimeout(() => {
      adapter.emitGateway('turn_started', { turnId: 'turn-trust-recovery' })
      resolve(true)
    }, 26_000)
  })

  const delivery = runtime.deliver('session-1', 'prompt')
  await Promise.resolve()
  t.mock.timers.tick(26_000)
  assert.equal((await delivery).turnId, 'turn-trust-recovery')
})
```

- [ ] **Step 5: Run focused delivery tests and confirm GREEN**

Run:

```powershell
node --test test/claude-gateway-capabilities.test.mjs test/claude-turn-delivery.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs
```

Expected: PASS; existing immediate process-terminal, cancellation, listener cleanup, and fail-closed tests remain green.

- [ ] **Step 6: Commit the delivery protocol**

```powershell
git add electron/adapters/claudeAdapter.js electron/summaries/interactiveSummaryContracts.js test/claude-gateway-capabilities.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs
git commit -m "fix: submit Claude summary turns after workspace trust"
```

---

### Task 2: Add Canonical Task Metadata and Presentation Contracts

**Files:**
- Create: `shared/summaryTaskContracts.js`
- Modify: `electron/persistence/db.js:436`
- Modify: `electron/persistence/db.js:969`
- Modify: `electron/persistence/db.js:2295`
- Modify: `electron/persistence/db.js:2381`
- Modify: `electron/summaries/reportRepository.js:8`
- Modify: `electron/summaries/reportRepository.js:286`
- Test: `test/summary-task-contracts.test.mjs`
- Test: `test/summary-db-migration.test.mjs:22`
- Test: `test/usage-ledger-db.test.mjs:74`

**Interfaces:**
- Produces: `buildSummaryTaskTitle({ periodType, createdAt, timezone }): string`.
- Produces: `normalizeSummaryTaskMetadata({ title, taskNote }): { title, taskNote }`, throwing `INVALID_SUMMARY_TASK_METADATA` for unsafe values.
- Produces: `summaryTaskStatusMeta(report, progress?): { label, color, detail }`, where terminal `status` always wins over absent/stale `runPhase`.
- Produces: report properties `title: string` and `taskNote: string` from repository `get/list/createQueued/importCompleted`.

- [ ] **Step 1: Write the failing pure contract tests**

Create `test/summary-task-contracts.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSummaryTaskTitle,
  normalizeSummaryTaskMetadata,
  summaryTaskStatusMeta
} from '../shared/summaryTaskContracts.js'

test('default summary task title follows the historical naming rule', () => {
  assert.equal(buildSummaryTaskTitle({
    periodType: 'week',
    createdAt: Date.UTC(2026, 7, 25, 1, 50),
    timezone: 'Asia/Shanghai'
  }), '工作总结（每周）2026-08-25 09:50')
})

test('summary task metadata validates title and note boundaries', () => {
  assert.deepEqual(normalizeSummaryTaskMetadata({
    title: '  周报复盘  ', taskNote: '第一行\r\n第二行'
  }), { title: '周报复盘', taskNote: '第一行\n第二行' })
  assert.throws(
    () => normalizeSummaryTaskMetadata({ title: 'bad\nname', taskNote: '' }),
    { code: 'INVALID_SUMMARY_TASK_METADATA' }
  )
  assert.throws(
    () => normalizeSummaryTaskMetadata({ title: 'x', taskNote: 'a'.repeat(1001) }),
    { code: 'INVALID_SUMMARY_TASK_METADATA' }
  )
})

test('completed database status wins when runPhase is absent', () => {
  assert.deepEqual(
    summaryTaskStatusMeta({ status: 'completed', runPhase: null }),
    { label: '已完成', color: 'green', detail: '总结已生成' }
  )
})
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `shared/summaryTaskContracts.js`.

- [ ] **Step 3: Implement the shared pure contract**

Create a Node/Electron-free module with exact period/status maps:

```js
const PERIOD_LABELS = Object.freeze({
  day: '每日', week: '每周', month: '每月', quarter: '每季度', year: '每年'
})

const STATUS = Object.freeze({
  queued: { label: '等待生成', color: 'default', detail: '等待生成' },
  running: { label: '正在生成', color: 'processing', detail: '正在生成总结' },
  awaiting_confirmation: { label: '等待确认', color: 'warning', detail: '等待确认' },
  completed: { label: '已完成', color: 'green', detail: '总结已生成' },
  failed: { label: '生成失败', color: 'red', detail: '总结生成失败' },
  cancelled: { label: '已取消', color: 'default', detail: '生成已取消' },
  interrupted: { label: '已中断', color: 'default', detail: '生成已中断' },
  skipped_empty: { label: '无可总结内容', color: 'default', detail: '周期内没有可总结内容' }
})

const PHASE_DETAIL = Object.freeze({
  preparing: '正在准备材料',
  starting: '正在启动 AI CLI',
  'awaiting-delivery': '正在投递生成指令',
  running: '正在生成总结',
  validating: '正在验证 Markdown 报告'
})

export function buildSummaryTaskTitle({ periodType, createdAt, timezone }) {
  const label = PERIOD_LABELS[periodType]
  if (!label || !Number.isSafeInteger(createdAt) || typeof timezone !== 'string') {
    throw Object.assign(new TypeError('Invalid summary task title input'), {
      code: 'INVALID_SUMMARY_TASK_METADATA'
    })
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(createdAt)).map(part => [part.type, part.value]))
  return `工作总结（${label}）${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function normalizeSummaryTaskMetadata({ title, taskNote } = {}) {
  const safeTitle = typeof title === 'string' ? title.trim() : ''
  const safeNote = typeof taskNote === 'string' ? taskNote.replace(/\r\n?/g, '\n') : ''
  if (!safeTitle || safeTitle.length > 120 || /[\u0000-\u001f\u007f]/.test(safeTitle) ||
    safeNote.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(safeNote)) {
    throw Object.assign(new TypeError('Invalid summary task metadata'), {
      code: 'INVALID_SUMMARY_TASK_METADATA'
    })
  }
  return { title: safeTitle, taskNote: safeNote }
}

export function summaryTaskStatusMeta(report = {}, progress = null) {
  const status = STATUS[report.status] || STATUS.running
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty']
    .includes(report.status)
  return {
    ...status,
    detail: terminal ? status.detail : progress?.text || PHASE_DETAIL[report.runPhase] || status.detail
  }
}
```

- [ ] **Step 4: Write the failing additive migration and repository tests**

Extend the legacy migration assertion with `title` and `task_note`; assert raw legacy rows map to `title: null`, `taskNote: ''`, while repository projection derives the title:

```js
for (const column of ['title', 'task_note']) {
  assert.ok(columns.includes(column), `missing migrated column ${column}`)
}
assert.equal(db.getSummaryReport('legacy-r1').title, null)
assert.equal(db.getSummaryReport('legacy-r1').taskNote, '')
assert.equal(
  createReportRepository({ db }).get('legacy-r1').title,
  '工作总结（每周）1970-01-01 08:00'
)
```

Add a repository creation assertion with a fixed clock:

```js
const repository = createReportRepository({
  db,
  now: () => Date.UTC(2026, 7, 25, 1, 50),
  idFactory: () => 'task-title-report'
})
const report = await repository.createQueued({
  periodType: 'week', periodStart: 1, periodEndExclusive: 2,
  timezone: 'Asia/Shanghai', generatedBy: 'manual'
})
assert.equal(report.title, '工作总结（每周）2026-08-25 09:50')
assert.equal(report.taskNote, '')
```

- [ ] **Step 5: Run persistence tests and confirm RED**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs
```

Expected: FAIL because the schema, mapper, fixtures, and repository do not expose task metadata.

- [ ] **Step 6: Implement additive persistence and repository normalization**

Add columns to fresh DDL and idempotent migration:

```sql
title                 TEXT,
task_note             TEXT NOT NULL DEFAULT '',
```

```js
for (const [column, ddl] of [
  ['title', 'ALTER TABLE summary_reports ADD COLUMN title TEXT'],
  ['task_note', "ALTER TABLE summary_reports ADD COLUMN task_note TEXT NOT NULL DEFAULT ''"]
]) {
  if (!summaryReportColumns.some(candidate => candidate.name === column)) this.sql.run(ddl)
}
```

Thread `title` and `taskNote` through insert/update validation, SQL columns, and `rowToSummaryReport`. In `normalizeReport`, derive legacy titles but preserve valid stored values:

```js
const fallbackTitle = buildSummaryTaskTitle({
  periodType: report.periodType,
  createdAt: report.createdAt,
  timezone: report.timezone
})
const metadata = normalizeSummaryTaskMetadata({
  title: report.title || fallbackTitle,
  taskNote: report.taskNote || ''
})
normalized.title = metadata.title
normalized.taskNote = metadata.taskNote
```

In both `createQueued` and `importCompleted`, persist:

```js
title: buildSummaryTaskTitle({ periodType: key.periodType, createdAt: timestamp, timezone: key.timezone }),
taskNote: '',
```

Update exact-object fixtures with explicit values; do not weaken deep equality assertions:

```js
function summaryReport(overrides = {}) {
  return {
    id: 'report-1',
    periodType: 'week',
    periodStart: 100,
    periodEndExclusive: 200,
    timezone: 'Asia/Shanghai',
    partial: false,
    version: 1,
    status: 'queued',
    title: '工作总结（每周）1970-01-01 08:00',
    taskNote: '',
    markdown: null,
    executorId: 'codex',
    profileId: 'profile-1',
    model: 'gpt-5',
    usageSnapshot: {},
    coverage: {},
    generationUsage: {},
    generationMetrics: {},
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: null,
    isCurrent: false,
    generatedBy: 'manual',
    errorText: null,
    executionMode: 'isolated-runner',
    sessionId: null,
    runPhase: null,
    artifactMetadata: {},
    legacyImportKey: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}
```

For legacy raw DB assertions use `title: null`; for repository projections use the derived non-null title.

- [ ] **Step 7: Run persistence tests and confirm GREEN**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-job-service.test.mjs
```

Expected: PASS with migration idempotency and legacy projection intact.

- [ ] **Step 8: Commit canonical task metadata**

```powershell
git add shared/summaryTaskContracts.js electron/persistence/db.js electron/summaries/reportRepository.js test/summary-task-contracts.test.mjs test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-job-service.test.mjs
git commit -m "feat: persist canonical summary task metadata"
```

---

### Task 3: Add Task Rename and Note Editing Through Narrow IPC

**Files:**
- Modify: `electron/persistence/db.js:1036`
- Modify: `electron/summaries/reportRepository.js:347`
- Modify: `electron/orchestrator.js:594`
- Modify: `electron/orchestrator.js:3190`
- Modify: `electron/preload.js:168`
- Modify: `src/ipc.js:104`
- Modify: `src/stores/summaries.js:180`
- Test: `test/summary-db-migration.test.mjs`
- Test: `test/summary-ipc.test.mjs:330`
- Test: `test/summary-view.test.mjs:175`

**Interfaces:**
- Consumes: Task 2 `normalizeSummaryTaskMetadata` and persisted `report.title/taskNote`.
- Produces: `db.updateSummaryTask(reportId, metadata): Promise<{ report, sessionId, sessionUpdated }>`.
- Produces: `repository.updateTask(reportId, metadata): Promise<{ report, sessionId, sessionUpdated }>`.
- Produces: IPC `summary:update-task` accepting exactly `{ reportId, title, taskNote }` and returning one safe canonical report.
- Produces: Pinia `summaries.updateTask(reportId, { title, taskNote }): Promise<report>`.

- [ ] **Step 1: Write the failing database transaction tests**

Seed a UCLI session plus an interactive report, then require one transaction to update both projections:

```js
db.insertSession({
  id: 'summary-session', project_path: 'C:\\summary', adapter_id: 'claude',
  name: 'old name', task_note: '', tier: 'safety-rules', status: 'offline', created_at: 1
})
await db.createSummaryReport(summaryReport({
  id: 'editable-report', sessionId: 'summary-session', title: 'old name', taskNote: ''
}))

const result = await db.updateSummaryTask('editable-report', {
  title: '新的任务名称', taskNote: '复盘说明', updatedAt: 2
})
assert.equal(result.report.title, '新的任务名称')
assert.equal(result.report.taskNote, '复盘说明')
assert.equal(result.sessionUpdated, true)
assert.equal(db.getSession('summary-session').name, '新的任务名称')
assert.equal(db.getSession('summary-session').taskNote, '复盘说明')
```

Add a shared-session anomaly test:

```js
await db.createSummaryReport(summaryReport({
  id: 'shared-owner', version: 2, sessionId: 'summary-session', title: 'second owner'
}))
const shared = await db.updateSummaryTask('editable-report', {
  title: '只更新报告', taskNote: '共享异常', updatedAt: 3
})
assert.equal(shared.report.title, '只更新报告')
assert.equal(shared.sessionUpdated, false)
assert.equal(db.getSession('summary-session').name, '新的任务名称')
```

- [ ] **Step 2: Run the database tests and confirm RED**

Run:

```powershell
node --test test/summary-db-migration.test.mjs
```

Expected: FAIL because `updateSummaryTask` is undefined.

- [ ] **Step 3: Implement the database and repository task-update facade**

Add a dedicated database method rather than allowing arbitrary renderer patches:

```js
async updateSummaryTask(reportId, fields) {
  const metadata = normalizeSummaryTaskMetadata(fields)
  return this.transactionSync(() => {
    const target = this.getSummaryReport(reportId)
    if (!target) throw Object.assign(new Error('Summary report not found'), {
      code: 'SUMMARY_REPORT_NOT_FOUND'
    })
    const report = this.#updateSummaryReportSync(reportId, {
      ...metadata,
      updatedAt: fields.updatedAt
    })
    let sessionUpdated = false
    if (target.sessionId) {
      const other = rows(this.sql.exec(
        'SELECT id FROM summary_reports WHERE session_id = ? AND id <> ? LIMIT 1',
        [target.sessionId, reportId]
      ))[0]
      if (!other) {
        this.sql.run(
          `UPDATE sessions SET name = ?, task_note = ?, updated_at = ?
           WHERE id = ? AND removed_at IS NULL`,
          [metadata.title, metadata.taskNote, fields.updatedAt, target.sessionId]
        )
        sessionUpdated = this.sql.getRowsModified() > 0
      }
    }
    return { report, sessionId: target.sessionId || null, sessionUpdated }
  })
}
```

Add repository method:

```js
async updateTask(reportId, patch) {
  const metadata = normalizeSummaryTaskMetadata(patch)
  const result = await db.updateSummaryTask(reportId, { ...metadata, updatedAt: now() })
  return { ...result, report: normalizeReport(result.report) }
}
```

- [ ] **Step 4: Write the failing IPC and renderer-store tests**

Register the new handler and reject both extra keys and unsafe controls:

```js
const updated = await handlers.get('summary:update-task')({}, {
  reportId: 'report-1', title: '新名称', taskNote: '备注'
})
assert.equal(updated.ok, true)
assert.equal(updated.value.title, '新名称')

const rejected = await handlers.get('summary:update-task')({}, {
  reportId: 'report-1', title: 'bad\nname', taskNote: '', workspace: 'C:\\secret'
})
assert.equal(rejected.ok, false)
assert.equal(rejected.error.code, 'INVALID_SUMMARY_IPC')
assert.doesNotMatch(JSON.stringify(rejected), /secret|workspace/i)
```

Add the store behavior:

```js
const report = await store.updateTask('report-1', {
  title: '新名称', taskNote: '备注'
})
assert.equal(report.title, '新名称')
assert.equal(store.reports[0].taskNote, '备注')
assert.equal(store.versions[0].title, '新名称')
```

- [ ] **Step 5: Run IPC/store tests and confirm RED**

Run:

```powershell
node --test test/summary-ipc.test.mjs test/summary-view.test.mjs
```

Expected: FAIL because the handler, preload bridge, renderer wrapper, and store action are absent.

- [ ] **Step 6: Implement the narrow IPC and in-memory session synchronization**

Add strict validation in `registerSummaryIpc`:

```js
ipcMain.handle('summary:update-task', safeSummaryEnvelope((_event, value) => {
  const keys = Object.keys(value || {})
  if (keys.length !== 3 || !keys.every(key => ['reportId', 'title', 'taskNote'].includes(key))) {
    throw invalidSummaryIpc()
  }
  const reportId = validateSummaryId(value.reportId)
  let metadata
  try { metadata = normalizeSummaryTaskMetadata(value) }
  catch { throw invalidSummaryIpc() }
  return service.updateTask({ reportId, ...metadata })
}))
```

Implement service synchronization without a second database write:

```js
async updateTask({ reportId, title, taskNote }) {
  const result = await summaryRepository.updateTask(reportId, { title, taskNote })
  if (result.sessionUpdated && result.sessionId) {
    const entry = sessions.get(result.sessionId)
    if (entry) {
      entry.session.name = result.report.title
      entry.session.taskNote = result.report.taskNote
      entry.updatedAt = result.report.updatedAt
    }
  }
  scheduleFlush()
  return result.report
}
```

Bridge it narrowly:

```js
// preload
updateSummaryTask: value => invokeSummary('summary:update-task', value),

// src/ipc.js
updateSummaryTask: value => u.updateSummaryTask(value),

// Pinia
async updateTask(reportId, patch) {
  const report = await ipc.updateSummaryTask({ reportId, ...patch })
  this.upsertReport(report)
  return report
}
```

- [ ] **Step 7: Run edit tests and confirm GREEN**

Run:

```powershell
node --test test/summary-db-migration.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs
```

Expected: PASS; unsafe values never appear in the safe error envelope.

- [ ] **Step 8: Commit task editing**

```powershell
git add electron/persistence/db.js electron/summaries/reportRepository.js electron/orchestrator.js electron/preload.js src/ipc.js src/stores/summaries.js test/summary-db-migration.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs
git commit -m "feat: edit work summary task metadata"
```

---

### Task 4: Delete the Complete Task Lifecycle

**Files:**
- Modify: `electron/persistence/db.js:1220`
- Modify: `electron/summaries/reportRepository.js:444`
- Modify: `electron/orchestrator.js:586`
- Modify: `electron/orchestrator.js:3208`
- Modify: `electron/orchestrator.js:3456`
- Modify: `src/stores/summaries.js:196`
- Test: `test/summary-db-migration.test.mjs`
- Test: `test/usage-ledger-db.test.mjs:938`
- Test: `test/summary-ipc.test.mjs:733`
- Test: `test/summary-view.test.mjs:175`

**Interfaces:**
- Consumes: existing `cancelActiveSummary`, `repository.delete`, `workspaceService.remove`, and session removal semantics (`status='removed'`, `removed_at`).
- Produces: `db.deleteSummaryReport(reportId)` and `repository.delete(reportId)` result `{ deletedReportId, currentReportId, removedSessionId }`.
- Produces: `deleteSummaryReportAndWorkspace(reportId, { repository, interactiveJobService, headlessJobService, workspaceService, removeSessionProjection, onEvent })` that cancels active work before deletion.

- [ ] **Step 1: Write the failing exclusive-session database deletion tests**

Add a completed report with an exclusive UCLI session and assert canonical promotion plus soft session removal:

```js
const result = await db.deleteSummaryReport('week-v2')
assert.deepEqual(result, {
  deletedReportId: 'week-v2',
  currentReportId: 'week-v1',
  removedSessionId: 'summary-session-v2'
})
assert.equal(db.getSession('summary-session-v2').removedAt > 0, true)
assert.equal(db.getSummaryReport('week-v1').isCurrent, true)
```

Add a defensive shared-session case:

```js
await db.createSummaryReport(summaryReport({
  id: 'shared-session-report', version: 3,
  sessionId: 'summary-session-v2', title: '共享会话报告'
}))
const sharedDelete = await db.deleteSummaryReport('week-v2')
assert.equal(sharedDelete.removedSessionId, null)
assert.equal(db.getSession('summary-session-v2').removedAt, null)
```

- [ ] **Step 2: Run database deletion tests and confirm RED**

Run:

```powershell
node --test test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs
```

Expected: FAIL because deletion does not remove or report the owned UCLI session.

- [ ] **Step 3: Extend the deletion transaction**

Inside the existing transaction, capture exclusivity before deleting the report and apply existing UCLI remove semantics:

```js
let removedSessionId = null
if (target.sessionId) {
  const otherOwner = rows(this.sql.exec(
    'SELECT id FROM summary_reports WHERE session_id = ? AND id <> ? LIMIT 1',
    [target.sessionId, reportId]
  ))[0]
  if (!otherOwner) {
    const timestamp = Date.now()
    this.sql.run(
      `UPDATE sessions SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?`,
      [timestamp, timestamp, target.sessionId]
    )
    if (this.sql.getRowsModified() > 0) {
      this.deactivateGatewayRoutesForSession(target.sessionId)
      removedSessionId = target.sessionId
    }
  }
}
return { deletedReportId: reportId, currentReportId, removedSessionId }
```

Keep the lower-level active-report rejection. Active cancellation belongs to the orchestration service, not persistence.

- [ ] **Step 4: Write the failing orchestration tests for terminal and active deletion**

Replace the old “never removes while active” expectation with cancel-before-delete:

```js
test('active summary deletion cancels before canonical and workspace removal', async () => {
  const calls = []
  const result = await deleteSummaryReportAndWorkspace('report-active', {
    repository: {
      get: () => ({ id: 'report-active', sessionId: 'session-1' }),
      delete: async () => {
        calls.push('delete-report')
        return { deletedReportId: 'report-active', currentReportId: null, removedSessionId: 'session-1' }
      }
    },
    interactiveJobService: {
      isActive: () => true,
      async cancel() { calls.push('cancel'); return true }
    },
    headlessJobService: { isActive: () => false },
    removeSessionProjection: async id => calls.push(`remove-session:${id}`),
    workspaceService: { remove: async id => calls.push(`remove-workspace:${id}`) }
  })
  assert.equal(result.deletedReportId, 'report-active')
  assert.deepEqual(calls, [
    'cancel', 'delete-report', 'remove-session:session-1', 'remove-workspace:report-active'
  ])
})
```

Add a cancellation failure test where no deletion starts:

```js
test('active summary deletion preserves resources when cancellation fails', async () => {
  let deletes = 0
  let sessionRemovals = 0
  let workspaceRemovals = 0
  await assert.rejects(deleteSummaryReportAndWorkspace('report-active', {
    repository: {
      get: () => ({ id: 'report-active', sessionId: 'session-1' }),
      delete: async () => { deletes += 1 }
    },
    interactiveJobService: {
      isActive: () => true,
      async cancel() { throw Object.assign(new Error('stop failed'), { code: 'SUMMARY_RUN_FAILED' }) }
    },
    headlessJobService: { isActive: () => false },
    removeSessionProjection: async () => { sessionRemovals += 1 },
    workspaceService: { remove: async () => { workspaceRemovals += 1 } }
  }), { code: 'SUMMARY_RUN_FAILED' })
  assert.deepEqual([deletes, sessionRemovals, workspaceRemovals], [0, 0, 0])
})
```

- [ ] **Step 5: Run orchestration tests and confirm RED**

Run:

```powershell
node --test test/summary-ipc.test.mjs
```

Expected: FAIL because active tasks are not cancelled and session projection cleanup is absent.

- [ ] **Step 6: Extract one shared UCLI session projection remover**

Refactor the existing `session:delete` body into an internal function used by both public session deletion and summary task cleanup:

```js
async function removeSessionProjection(sessionId, { persist = true } = {}) {
  const entry = sessions.get(sessionId)
  if (!entry) return true
  clearInteractiveProfileCapability(entry)
  engine.removeSession(sessionId)
  gatewaySignals.publish({ type: 'session_stopped', sessionId, occurredAt: Date.now() })
  let cleanupError = null
  try { await entry.adapter?.dispose() } catch (error) { cleanupError = error }
  finally {
    clearInteractiveProfileCapability(entry)
    interactiveAdapterFacades.delete(sessionId)
    sessions.delete(sessionId)
    historyService.invalidate(sessionId)
    if (persist) getDb()?.removeSession(sessionId)
    scheduleFlush()
  }
  if (cleanupError) throw cleanupError
  return true
}
```

The summary path passes `{ persist: false }` because the report deletion transaction already marked the session removed.

- [ ] **Step 7: Implement cancel-before-delete and best-effort derived cleanup**

Update the exported service:

```js
export async function deleteSummaryReportAndWorkspace(reportId, deps = {}) {
  deps.repository.get(reportId)
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}
  const active = deps.interactiveJobService?.isActive(reportId) ||
    deps.headlessJobService?.isActive?.(reportId)
  if (active) {
    await cancelActiveSummary(reportId, {
      interactiveJobService: deps.interactiveJobService,
      headlessJobService: deps.headlessJobService
    })
  }
  const result = await deps.repository.delete(reportId)
  if (result.removedSessionId) {
    try { await deps.removeSessionProjection(result.removedSessionId) }
    catch { onEvent({ phase: 'session-delete', code: 'SUMMARY_SESSION_DELETE_FAILED' }) }
  }
  try { await deps.workspaceService?.remove(reportId) }
  catch { onEvent({ phase: 'workspace-delete', code: 'SUMMARY_WORKSPACE_DELETE_FAILED' }) }
  return result
}
```

Pass both job services and `id => removeSessionProjection(id, { persist: false })` from the orchestrator. Keep operational logs free of adapter errors and paths.

- [ ] **Step 8: Update the Pinia deletion result without stale selection**

Keep existing deletion guards and accept the extended result:

```js
const nextId =
  (selectedId !== reportId && this.reports.some(report => report.id === selectedId) ? selectedId : null) ||
  result.currentReportId || this.reports[0]?.id || null
```

Assert that `removedSessionId` is never copied into report projections and late terminal events remain ignored.

- [ ] **Step 9: Run deletion tests and confirm GREEN**

Run:

```powershell
node --test test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs
```

Expected: PASS; active tasks cancel before deletion, current version promotion remains correct, and native transcript APIs are never called.

- [ ] **Step 10: Commit lifecycle deletion**

```powershell
git add electron/persistence/db.js electron/summaries/reportRepository.js electron/orchestrator.js src/stores/summaries.js test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs
git commit -m "feat: delete work summary task resources"
```

---

### Task 5: Publish and Reconcile Live Task State Before Startup Returns

**Files:**
- Modify: `electron/summaries/interactiveSummaryJobService.js:582`
- Modify: `electron/summaries/interactiveSummaryJobService.js:669`
- Modify: `src/stores/summaries.js:17`
- Modify: `src/stores/summaries.js:83`
- Test: `test/interactive-summary-job-service.test.mjs:360`
- Test: `test/summary-view.test.mjs:40`
- Test: `test/summary-view-mounted.test.mjs:130`

**Interfaces:**
- Consumes: Task 2 `queued.title`, existing `publish(report)`, existing `getSummaryReport(reportId)` IPC.
- Produces: the first job progress phase `preparing` immediately after active registration and before `buildPrompt`, workspace creation, or preparation.
- Produces: store reconciliation that coalesces one in-flight fetch per unknown report and applies only the latest buffered progress.

- [ ] **Step 1: Write the failing initial-publication job test**

Gate preparation and prove the task is already visible in progress:

```js
test('queued report publishes preparing before slow preparation resolves', async t => {
  const preparationGate = deferred()
  const state = await fixture(t, { preparationGate })
  const progress = []
  state.service.subscribe(event => progress.push(event))

  const starting = state.service.start(request())
  await waitUntil(() => progress.length === 1)
  assert.deepEqual(progress.map(item => [item.status, item.phase]), [
    ['queued', 'preparing']
  ])

  preparationGate.resolve()
  const run = await starting
  assert.equal(run.report.title.startsWith('工作总结（每周）'), true)
})
```

Update the normal lifecycle assertion and session config expectation exactly:

```js
assert.deepEqual(progress.map(item => item.phase), [
  'preparing', 'starting', 'awaiting-delivery', 'running', 'validating', 'completed'
])
assert.deepEqual(state.fake.config(run.sessionId), {
  adapterId: 'claude', profileId: 'p1', model: 'm1',
  name: run.report.title,
  cwd: join(state.root, 'summaries', 'workspaces', run.report.id, 'work')
})
```

- [ ] **Step 2: Run the job test and confirm RED**

Run:

```powershell
node --test test/interactive-summary-job-service.test.mjs
```

Expected: FAIL because no event is published until `starting` and the session name ignores canonical title.

- [ ] **Step 3: Publish queued state and use the canonical title**

Immediately after `active.set(queued.id, job)` and timer setup, publish the queued report:

```js
active.set(queued.id, job)
publish(queued)
```

Use the canonical report title for the created session:

```js
name: queued.title,
```

Add `preparing: '正在准备工作总结'` to `phaseText` so direct subscribers and orchestrator projection agree.

- [ ] **Step 4: Write the failing unknown-report renderer reconciliation tests**

Use a deferred `getSummaryReport` and two progress events:

```js
test('unknown progress loads one report and applies the newest event', async () => {
  const originalGet = window.ucli.getSummaryReport
  let resolveReport
  let gets = 0
  const pending = new Promise(resolve => { resolveReport = resolve })
  const store = freshStore()
  try {
    window.ucli.getSummaryReport = async () => { gets += 1; return pending }
    store.applyProgress({
      reportId: 'new-report', status: 'queued', phase: 'preparing',
      completed: 0, total: 1, text: '正在准备工作总结'
    })
    store.applyProgress({
      reportId: 'new-report', status: 'running', phase: 'starting',
      completed: 0, total: 1, text: '正在启动 AI CLI'
    })
    assert.equal(gets, 1)
    resolveReport({
      id: 'new-report', title: '工作总结（每周）2026-08-25 09:50', taskNote: '',
      status: 'running', runPhase: 'starting', version: 1
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(store.reports[0].id, 'new-report')
    assert.equal(store.progress['new-report'].phase, 'starting')
  } finally {
    window.ucli.getSummaryReport = originalGet
    store.dispose()
  }
})
```

Add a deletion race test where the unknown-report fetch resolves after deletion:

```js
test('unknown progress fetch cannot resurrect a deleted report', async () => {
  let resolveReport
  const pending = new Promise(resolve => { resolveReport = resolve })
  const store = freshStore()
  window.ucli.getSummaryReport = () => pending
  window.ucli.deleteSummaryReport = async id => ({
    deletedReportId: id, currentReportId: null, removedSessionId: null
  })
  window.ucli.listSummaryReports = async () => []

  store.applyProgress({
    reportId: 'delete-race', status: 'queued', phase: 'preparing',
    completed: 0, total: 1, text: '正在准备工作总结'
  })
  await store.deleteReport('delete-race')
  resolveReport({ id: 'delete-race', status: 'queued', version: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.reports.some(report => report.id === 'delete-race'), false)
  store.dispose()
})
```

- [ ] **Step 5: Run renderer store tests and confirm RED**

Run:

```powershell
node --test test/summary-view.test.mjs
```

Expected: FAIL because unknown progress only populates `progress` and never inserts a report.

- [ ] **Step 6: Implement one-flight unknown report reconciliation**

Extend store metadata:

```js
value = {
  unsubscribe: null, initPromise: null, owners: new Set(), selectionEpoch: 0,
  terminalReports: new Set(), deletedReports: new Set(),
  pendingProgress: new Map(), reportRefreshes: new Map()
}
```

Refactor progress projection into a known-report helper and add:

```js
async ensureReportProjection(reportId) {
  const meta = metadata(this)
  if (meta.deletedReports.has(reportId)) return null
  if (meta.reportRefreshes.has(reportId)) return meta.reportRefreshes.get(reportId)
  const pending = this.refreshReport(reportId).then(report => {
    const latest = meta.pendingProgress.get(reportId)
    if (report && latest && !meta.deletedReports.has(reportId)) {
      this.applyProgressToKnown(latest)
    }
    return report
  }).finally(() => {
    meta.pendingProgress.delete(reportId)
    meta.reportRefreshes.delete(reportId)
  })
  meta.reportRefreshes.set(reportId, pending)
  return pending
}
```

In `applyProgress`, always store the latest payload. If the report is unknown, call `ensureReportProjection` and return; if known, update it immediately. Reuse existing terminal refresh and not-found handling.

- [ ] **Step 7: Run live projection tests and confirm GREEN**

Run:

```powershell
node --test test/interactive-summary-job-service.test.mjs test/summary-view.test.mjs test/summary-view-mounted.test.mjs
```

Expected: PASS; the report appears during gated preparation, only one fetch occurs, and deletion races remain safe.

- [ ] **Step 8: Commit live task projection**

```powershell
git add electron/summaries/interactiveSummaryJobService.js src/stores/summaries.js test/interactive-summary-job-service.test.mjs test/summary-view.test.mjs test/summary-view-mounted.test.mjs
git commit -m "fix: project work summary tasks in real time"
```

---

### Task 6: Restore Task Cards, Correct Status, and Management UI

**Files:**
- Create: `src/components/summaries/SummaryReportListItem.vue`
- Create: `src/components/summaries/SummaryTaskEditDialog.vue`
- Modify: `src/components/summaries/WorkSummaryPanel.vue:1`
- Modify: `src/components/summaries/SummaryHistory.vue:1`
- Modify: `src/components/summaries/SummaryReportView.vue:1`
- Test: `test/summary-view.test.mjs:320`
- Test: `test/summary-view-mounted.test.mjs:30`

**Interfaces:**
- Consumes: Task 2 `summaryTaskStatusMeta`, Task 3 `summaries.updateTask`, Task 4 `summaries.deleteReport`, Task 5 live `progress` projection.
- Produces: `SummaryReportListItem` events `select`, `edit`, `delete-report`, `retry`, and `open-conversation`.
- Produces: `SummaryTaskEditDialog` events `update:open` and `submit({ title, taskNote })`.

- [ ] **Step 1: Write the failing mounted UI behavior test**

Mount a completed legacy report with `runPhase: null`, open edit, submit, and delete from the task card:

```js
const report = {
  id: 'legacy-completed', title: '工作总结（每日）2026-08-19 11:28', taskNote: '',
  version: 1, status: 'completed', runPhase: null, markdown: '# 摘要',
  periodType: 'day', periodStart: Date.UTC(2026, 7, 19),
  periodEndExclusive: Date.UTC(2026, 7, 19, 3, 28), timezone: 'Asia/Shanghai'
}

assert.match(wrapper.text(), /已完成/)
assert.doesNotMatch(wrapper.text(), /等待生成/)
await wrapper.get('[data-testid="summary-task-edit-legacy-completed"]').trigger('click')
await wrapper.get('[data-testid="summary-task-title"]').setValue('8 月 19 日总结')
await wrapper.get('[data-testid="summary-task-note"]').setValue('已复核')
await wrapper.get('[data-testid="summary-task-edit-submit"]').trigger('click')
assert.deepEqual(updateCalls, [{
  reportId: 'legacy-completed', title: '8 月 19 日总结', taskNote: '已复核'
}])
await wrapper.get('[data-testid="summary-task-delete-legacy-completed"]').trigger('click')
assert.deepEqual(deleteCalls, ['legacy-completed'])
```

Add an active report assertion:

```js
wrapper.vm.summaries.reports = [{
  ...report, id: 'active-report', status: 'running', runPhase: 'starting'
}]
wrapper.vm.summaries.progress['active-report'] = {
  reportId: 'active-report', status: 'running', phase: 'starting',
  completed: 0, total: 1, text: '正在启动 AI CLI'
}
await flushPromises()
assert.match(wrapper.text(), /正在启动 AI CLI/)
assert.equal(
  wrapper.get('[data-testid="summary-task-delete-active-report"]').attributes('title'),
  '取消并删除这个总结任务？'
)
```

- [ ] **Step 2: Run mounted UI tests and confirm RED**

Run:

```powershell
node --test test/summary-view.test.mjs test/summary-view-mounted.test.mjs
```

Expected: FAIL because the list has no task management component or edit dialog and renders raw English status/fallback text.

- [ ] **Step 3: Implement the report task card**

Create `SummaryReportListItem.vue` around canonical report props:

```vue
<template>
  <a-list-item :class="{ selected }" @click="emit('select', report.id)">
    <a-list-item-meta>
      <template #title>
        <span>{{ report.title }}</span>
        <a-tag>v{{ report.version }}</a-tag>
        <a-tag v-if="report.isCurrent" color="blue">当前</a-tag>
      </template>
      <template #description>
        <a-tag :color="status.color">{{ status.label }}</a-tag>
        <span>{{ status.detail }}</span>
        <span>{{ report.executorId || '—' }} · {{ new Date(report.createdAt).toLocaleString() }}</span>
        <span v-if="report.taskNote">{{ report.taskNote }}</span>
      </template>
    </a-list-item-meta>
    <template #actions>
      <a-button :data-testid="`summary-task-edit-${report.id}`" @click.stop="emit('edit', report)">编辑</a-button>
      <a-button v-if="['failed', 'interrupted', 'cancelled'].includes(report.status)" @click.stop="emit('retry', report)">重试</a-button>
      <a-button @click.stop="emit('open-conversation', report)">查看对话</a-button>
      <a-popconfirm
        :title="active ? '取消并删除这个总结任务？' : '删除这个总结任务？'"
        @confirm="emit('delete-report', report.id)"
      >
        <a-button
          danger
          :data-testid="`summary-task-delete-${report.id}`"
          :title="active ? '取消并删除这个总结任务？' : '删除这个总结任务？'"
          @click.stop
        >删除</a-button>
      </a-popconfirm>
    </template>
  </a-list-item>
</template>

<script setup>
import { computed } from 'vue'
import { summaryTaskStatusMeta } from '../../../shared/summaryTaskContracts.js'

const props = defineProps({ report: { type: Object, required: true }, progress: Object, selected: Boolean })
const emit = defineEmits(['select', 'edit', 'delete-report', 'retry', 'open-conversation'])
const status = computed(() => summaryTaskStatusMeta(props.report, props.progress))
const active = computed(() => ['queued', 'running', 'awaiting_confirmation'].includes(props.report.status))
</script>
```

- [ ] **Step 4: Implement the title/note edit dialog**

Create a controlled modal that copies the selected report into local form state on open and submits only normalized fields:

```vue
<template>
  <a-modal
    :open="open"
    title="编辑总结任务"
    :confirm-loading="confirmLoading"
    @ok="submit"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical">
      <a-form-item label="任务名称">
        <a-input v-model:value="form.title" :maxlength="120" data-testid="summary-task-title" />
      </a-form-item>
      <a-form-item label="备注">
        <a-textarea v-model:value="form.taskNote" :maxlength="1000" :rows="4" data-testid="summary-task-note" />
      </a-form-item>
    </a-form>
    <button type="button" hidden data-testid="summary-task-edit-submit" @click="submit" />
  </a-modal>
</template>

<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({ open: Boolean, report: Object, confirmLoading: Boolean })
const emit = defineEmits(['update:open', 'submit'])
const form = reactive({ title: '', taskNote: '' })
watch(() => [props.open, props.report?.id], () => {
  if (!props.open) return
  form.title = props.report?.title || ''
  form.taskNote = props.report?.taskNote || ''
}, { immediate: true })

function submit() {
  emit('submit', { title: form.title.trim(), taskNote: form.taskNote.replace(/\r\n?/g, '\n') })
}
</script>
```

- [ ] **Step 5: Wire task card actions through `WorkSummaryPanel`**

Replace raw `<a-list-item-meta>` rendering with:

```vue
<SummaryReportListItem
  :report="item"
  :progress="summaries.progress[item.id] || null"
  :selected="item.id === summaries.selectedReportId"
  @select="select(item.id)"
  @edit="openEdit(item)"
  @delete-report="remove"
  @retry="retry"
  @open-conversation="openConversation"
/>
```

Add panel state and handlers:

```js
const editDialogOpen = ref(false)
const editReport = ref(null)
const editSaving = ref(false)

function openEdit(report) {
  editReport.value = report
  editDialogOpen.value = true
}

async function saveEdit(patch) {
  if (!editReport.value || editSaving.value) return
  editSaving.value = true
  try {
    await summaries.updateTask(editReport.value.id, patch)
    editDialogOpen.value = false
  } catch {
    summaries.error = new Error('无法更新总结任务')
  } finally {
    editSaving.value = false
  }
}
```

Do not reintroduce a renderer timer or file-system API.

- [ ] **Step 6: Replace raw status in history/detail**

Use `summaryTaskStatusMeta` in `SummaryHistory.vue` and `SummaryReportView.vue`:

```js
const status = computed(() => summaryTaskStatusMeta(props.report, props.progress))
```

```vue
<template #extra><a-tag :color="status.color">{{ status.label }}</a-tag></template>
```

Fix the period title to display an inclusive end for completed calendar periods rather than rendering `endExclusive` as the next day:

```js
const displayEnd = computed(() => {
  if (!props.report) return null
  return props.report.partial
    ? props.report.periodEndExclusive
    : props.report.periodEndExclusive - 1
})
```

The 2026-08-19 daily report must render `2026/8/19 — 2026/8/19 · v1`, while partial reports retain their actual endpoint.

- [ ] **Step 7: Run UI tests and confirm GREEN**

Run:

```powershell
node --test test/summary-task-contracts.test.mjs test/summary-view.test.mjs test/summary-view-mounted.test.mjs
```

Expected: PASS; completed legacy reports show `已完成`, default names follow the historical rule, edit persists through the store, and both active and terminal delete actions are present.

- [ ] **Step 8: Run renderer build before committing**

Run:

```powershell
npm run build
```

Expected: main, preload, and renderer production bundles all complete successfully; no cross-process import pulls Node/Electron APIs into renderer.

- [ ] **Step 9: Commit task management UI**

```powershell
git add src/components/summaries/SummaryReportListItem.vue src/components/summaries/SummaryTaskEditDialog.vue src/components/summaries/WorkSummaryPanel.vue src/components/summaries/SummaryHistory.vue src/components/summaries/SummaryReportView.vue test/summary-view.test.mjs test/summary-view-mounted.test.mjs
git commit -m "feat: manage work summary tasks"
```

---

### Task 7: Integrate, Document, and Verify Automated Closure

**Files:**
- Modify: `CONTEXT.md:12`
- Modify: `CHANGELOG.md:1`
- Modify: `docs/qa/2026-08-24-work-summary-closure-acceptance.md:1`
- Review: every file changed by Tasks 1–6

**Interfaces:**
- Consumes: all prior task contracts.
- Produces: durable domain language, release notes, automated evidence, and a clean branch ready for real CLI acceptance.

- [ ] **Step 1: Update domain and release documentation**

Add these ownership rules to `CONTEXT.md`:

```markdown
- **总结任务元数据**：任务名称和备注属于 `summary_reports`；关联 UCLI session 只同步显示，不成为恢复真相源。
- **删除总结任务**：先收口活动 run，再删除报告、受控 workspace 和独占 UCLI session 投影；CLI 原生 transcript 永远不在该删除范围内。
```

Add this `0.11.6` changelog entry; do not claim real CLI acceptance until it has occurred:

```markdown
- 修复 Claude 新工作区信任门禁后的总结指令提交，使用有界 transcript 确认避免任务文本停留在输入框。
- 工作总结任务在材料准备开始时实时出现并更新；完成报告不再错误显示“等待生成”。
- 恢复 `工作总结（周期）YYYY-MM-DD HH:mm` 默认命名，支持编辑任务名称/备注，并在删除时清理报告、受控工作区和独占 UCLI 会话投影。
```

- [ ] **Step 2: Run all focused summary and Claude tests**

Run:

```powershell
node --test test/claude-gateway-capabilities.test.mjs test/claude-turn-delivery.test.mjs test/interactive-summary-contracts.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs test/summary-task-contracts.test.mjs test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs test/summary-view-mounted.test.mjs
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 3: Run full automated verification from a clean process**

Run:

```powershell
npm test
npm run build
npm run verify:release
git diff --check
```

Expected:

- full test suite: zero failures;
- production main/preload/renderer build: success;
- release verifier: Setup, Portable, and packaged DSH bridge accepted for the current package version;
- diff check: no whitespace errors.

- [ ] **Step 4: Record exact automated evidence**

Update `docs/qa/2026-08-24-work-summary-closure-acceptance.md` with command timestamps, totals, exit codes, and artifact names. Preserve the prior v1/v2/v3 failure evidence and state that the next real Claude run remains pending; do not include prompts, transcripts, credentials, or absolute workspace paths.

- [ ] **Step 5: Review the complete branch diff**

Run:

```powershell
git diff 5e35792 --stat
git diff 5e35792 --check
git status --short
```

Inspect every changed hunk for:

- report/session ownership inversion;
- duplicate model-turn risk;
- active-delete races;
- renderer polling or absolute path leakage;
- unsafe title/note logging;
- late progress resurrecting deleted reports;
- unrelated user files staged by mistake.

- [ ] **Step 6: Commit documentation and automated evidence**

```powershell
git add CONTEXT.md CHANGELOG.md docs/qa/2026-08-24-work-summary-closure-acceptance.md
git commit -m "docs: record summary task closure verification"
```

---

### Task 8: Perform Real CLI and Installed-App Acceptance

**Files:**
- Modify after evidence exists: `docs/qa/2026-08-24-work-summary-closure-acceptance.md`

**Interfaces:**
- Consumes: built development app and release artifacts verified in Task 7.
- Produces: release-closure evidence only; no implementation changes unless a newly diagnosed failure requires a separate RED→GREEN fix.

- [ ] **Step 1: Run one real Claude summary in a new workspace**

From the development app, generate the next weekly version with Claude. Observe without pressing Refresh:

```text
任务立即出现 → 正在准备材料 → 正在启动 AI CLI → 正在投递生成指令 → 正在生成总结 → 正在验证 Markdown 报告 → 已完成
```

Expected: a new report version completes, has a native session ID, stores canonical Markdown, and no `SUMMARY_TURN_NOT_CONFIRMED` is persisted. This step invokes a real model and must only run with the user's explicit cost authorization or by the user through the UI.

- [ ] **Step 2: Verify metadata and completed legacy presentation**

Expected:

- the new task default title is `工作总结（每周）YYYY-MM-DD HH:mm`;
- the existing 2026-08-19 completed daily report shows `已完成`, not `等待生成`;
- editing title and note survives application restart and is reflected in the associated UCLI session display.

- [ ] **Step 3: Verify terminal and active deletion**

Delete a completed non-current test task and confirm report, workspace, and UCLI session entry disappear while its CLI-native transcript remains discoverable. Then start a disposable task, choose `取消并删除`, and confirm the process stops before the task disappears and does not reappear after restart.

- [ ] **Step 4: Run existing four-CLI acceptance**

Repeat the canonical generation/retry/conversation/export checks for Claude, Codex, OpenCode, and U-Code. Record executor, report ID, version, terminal status, and pass/fail only; do not record prompt/transcript content.

- [ ] **Step 5: Run installed Setup and Portable acceptance**

Install/open the current Setup build and open the Portable build. Verify summary list loading, one safe task edit/delete flow, Markdown preview, and HTML/Markdown export. Record artifact filename, timestamp, and result.

- [ ] **Step 6: Finalize QA evidence and commit only after every check passes**

```powershell
git add docs/qa/2026-08-24-work-summary-closure-acceptance.md
git commit -m "test: close work summary task acceptance"
```

If any real acceptance step fails, stop this task, capture the new safe error code/timing, and return to `diagnose` before editing code. Do not mark the release closed or make this final commit with pending/failed CLI or installed-app rows.
