# 工作总结业务闭环修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将交互式 AI CLI 生成的工作总结接入数据库报告仓库、独立运行空间和可恢复状态机，使生成、版本、预览、导出、提醒、历史与失败处理形成一个可验证闭环。

**Architecture:** `summary_reports` 是唯一业务真相源；每次生成先创建唯一 report/version，再绑定独立 UCLI 会话和独立 workspace，由主进程驱动 `queued → running → completed/failed/interrupted/cancelled`。AI CLI 只需在受控 workspace 写出规范 Markdown，主进程验证并原子提交，HTML 统一由现有本地渲染/导出服务派生；旧 `workLogs` 仅做只读、幂等导入，不再参与运行状态判断。

**Tech Stack:** Electron main/preload IPC、Node.js ESM、sql.js、Vue 3、Pinia、Ant Design Vue、Node test runner、现有 summary theme/export pipeline。

## Global Constraints

- 目标修复版本为 `0.11.6`；在所有发布门禁通过前不得标记发布完成。
- 不新增运行时依赖；仅测试挂载层允许增加 `@vue/test-utils@2.4.6` 与 `jsdom@26.1.0` 开发依赖。
- `summary_reports` 是报告、版本、当前版本、调度去重和状态恢复的唯一真相源。
- 每个生成 run 必须拥有唯一 `reportId`、独立 workspace、独立 UCLI `sessionId` 和独立原生 CLI 会话。
- Markdown 是唯一规范产物；HTML、打印和文件导出均从已入库 Markdown 本地派生。
- renderer 不持有生成计时器、文件轮询器、CLI 启停或完成判定。
- prompt 投递必须由 `turn_started` 网关事件确认；超时或无法确认时 fail-closed。
- 旧 `summary_reports` 与旧 `workLogs` 文件不得删除或覆盖；导入必须幂等且不保存旧绝对路径。
- workspace 产物必须通过路径包含、非符号链接、大小、UTF-8、稳定性和标题顺序校验。
- prompt、transcript、工具 payload、凭据和绝对 workspace 路径不得进入数据库、日志或 renderer IPC。
- Windows 与 macOS 都必须通过自动化；四种 CLI（Claude、Codex、OpenCode、U-Code）各完成一条受控人工闭环验收。

---

## 文件职责与边界

### 新建文件

- `docs/adr/0003-summary-reports-are-the-canonical-work-summary.md`：记录唯一真相源、独立 run、规范 Markdown 和旧数据导入决策。
- `electron/summaries/interactiveSummaryContracts.js`：集中定义 execution mode、run phase、终态和安全错误码。
- `electron/summaries/summaryPreparationService.js`：收集周期材料并写入指定 report workspace，不决定任务状态。
- `electron/summaries/interactiveSummaryArtifact.js`：生成 prompt、定位并验证 `output/report.md`。
- `electron/summaries/interactiveSummarySessionRuntime.js`：把现有 session/adapter 能力封装成 ready、投递确认、生命周期订阅和停止接口。
- `electron/summaries/interactiveSummaryJobService.js`：主进程唯一的交互式总结状态机与超时所有者。
- `electron/summaries/legacyWorkLogsImporter.js`：只读扫描旧 workLogs，并幂等导入数据库。
- `test/interactive-summary-contracts.test.mjs`：契约和迁移字段测试。
- `test/summary-db-migration.test.mjs`：从 `0.11.5` 旧表升级并保留报告的真实数据库测试。
- `test/interactive-summary-artifact.test.mjs`：产物边界与结构验证测试。
- `test/interactive-summary-session-runtime.test.mjs`：ready、投递确认和生命周期测试。
- `test/interactive-summary-job-service.test.mjs`：fake adapter 纵向状态机测试。
- `test/legacy-worklogs-import.test.mjs`：旧数据幂等导入测试。
- `test/summary-view-mounted.test.mjs`：真实挂载组件并执行生成/进度/打开报告流程。
- `test/fixtures/summaryFakeAdapter.js`：可编排 ready、gateway event、文件写入、退出和错误的 fake adapter。
- `test/helpers/fsCapabilities.mjs`：Windows 文件锁/符号链接能力探测与明确 skip。
- `docs/qa/2026-08-24-work-summary-closure-acceptance.md`：四 CLI 与安装包验收证据。

### 修改文件

- `electron/persistence/db.js`：扩展报告字段、唯一导入键和原子完成提交。
- `electron/summaries/reportRepository.js`：校验交互式字段并提供 `complete()`、`importCompleted()`。
- `electron/summaries/summaryWorkspaceService.js`：暴露受控 output 路径读取能力，继续负责容量和恢复。
- `electron/summaries/workLogsService.js`：复用材料收集，保留旧目录只读兼容，停止承担新 run 准备。
- `electron/adapters/cliAdapter.js`、`claudeAdapter.js`、`codexAdapter.js`、`openCodeAdapter.js`、`ucodeAdapter.js`：统一 `sendTurn(): Promise<boolean>` 投递接受契约。
- `electron/orchestrator.js`：装配 interactive job/session runtime、注册 IPC、发布进度、启动恢复和关闭中断。
- `electron/preload.js`、`src/ipc.js`：只暴露经校验的交互式生成/取消 API。
- `electron/summaries/summaryScheduler.js`：用规范数据库 completed/current 结果去重提醒。
- `src/stores/summaries.js`：以报告仓库和主进程进度为唯一前端状态。
- `src/components/summaries/SummaryGenerateDialog.vue`：只收集生成参数，不创建或复用会话。
- `src/components/summaries/WorkSummaryPanel.vue`：统一显示数据库任务、版本、当前报告和失败操作。
- `src/components/summaries/SummaryConversationDrawer.vue`：按 `report.sessionId` 打开本次专属会话。
- `src/components/summaries/SummaryHistory.vue`、`SummaryReportView.vue`：恢复统一版本/预览入口。
- `electron/summaries/reportExportService.js`、`SummaryHtmlStyleDialog.vue`：只从规范 Markdown 生成导出结果。
- `test/summary-ipc.test.mjs`、`summary-startup.test.mjs`、`summary-scheduler.test.mjs`、`summary-view.test.mjs`、`summary-export.test.mjs`、`summary-workspace.test.mjs`：更新现有契约和回归断言。
- `scripts/package-dsh-bridge.mjs`、`test/dsh-bridge-package.test.mjs` 及使用符号链接的测试：消除全量门禁的文件占用/权限假失败。
- `README.md`、`CONTEXT.md`、`CHANGELOG.md`、`package.json`、`package-lock.json`：同步产品语义、版本和验收命令。

### 最终删除文件

- `src/stores/summaryTasks.js`
- `src/components/summaries/summaryTaskNote.js`
- `src/components/summaries/summaryTaskStatus.js`
- `src/components/summaries/SummaryTaskCard.vue`
- `src/components/summaries/SummaryTaskDetail.vue`

---

### Task 1: 固化唯一真相源与状态契约

**Files:**
- Create: `docs/adr/0003-summary-reports-are-the-canonical-work-summary.md`
- Create: `electron/summaries/interactiveSummaryContracts.js`
- Create: `test/interactive-summary-contracts.test.mjs`

**Interfaces:**
- Consumes: 现有 `summary_reports.status` 集合和 Gateway `turn_started/turn_completed/turn_failed/turn_interrupted`。
- Produces: `SUMMARY_EXECUTION_MODE`、`INTERACTIVE_SUMMARY_PHASE`、`INTERACTIVE_SUMMARY_TERMINAL_PHASES`、`assertInteractiveSummaryPhase(value)`、`safeInteractiveSummaryError(error, fallbackCode)`。

- [ ] **Step 1: 写失败的契约测试**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SUMMARY_EXECUTION_MODE,
  INTERACTIVE_SUMMARY_PHASE,
  assertInteractiveSummaryPhase,
  safeInteractiveSummaryError
} from '../electron/summaries/interactiveSummaryContracts.js'

test('interactive summary contracts are closed and safe', () => {
  assert.deepEqual(Object.values(SUMMARY_EXECUTION_MODE), [
    'isolated-runner', 'interactive-cli', 'legacy-worklog-import'
  ])
  assert.equal(assertInteractiveSummaryPhase(INTERACTIVE_SUMMARY_PHASE.VALIDATING), 'validating')
  assert.throws(() => assertInteractiveSummaryPhase('waiting-forever'), { code: 'SUMMARY_RUN_PHASE_INVALID' })
  assert.deepEqual(safeInteractiveSummaryError(new Error('C:\\secret\\prompt.txt'), 'SUMMARY_RUN_FAILED'), {
    code: 'SUMMARY_RUN_FAILED', message: '工作总结生成失败'
  })
})
```

- [ ] **Step 2: 运行契约测试并确认因模块不存在而失败**

Run: `node --test test/interactive-summary-contracts.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现封闭枚举和脱敏错误映射**

```js
export const SUMMARY_EXECUTION_MODE = Object.freeze({
  ISOLATED_RUNNER: 'isolated-runner',
  INTERACTIVE_CLI: 'interactive-cli',
  LEGACY_WORKLOG_IMPORT: 'legacy-worklog-import'
})

export const INTERACTIVE_SUMMARY_PHASE = Object.freeze({
  PREPARING: 'preparing', STARTING: 'starting', AWAITING_DELIVERY: 'awaiting-delivery',
  RUNNING: 'running', VALIDATING: 'validating', COMPLETED: 'completed',
  FAILED: 'failed', INTERRUPTED: 'interrupted', CANCELLED: 'cancelled'
})

export const INTERACTIVE_SUMMARY_TERMINAL_PHASES = Object.freeze(
  new Set(['completed', 'failed', 'interrupted', 'cancelled'])
)

const SAFE_MESSAGES = Object.freeze({
  SUMMARY_READY_TIMEOUT: 'AI CLI 启动超时',
  SUMMARY_TURN_NOT_CONFIRMED: '生成指令未确认送达',
  SUMMARY_RUN_TIMEOUT: '工作总结生成超时',
  SUMMARY_ARTIFACT_INVALID: '生成的 Markdown 报告无效',
  SUMMARY_RUN_FAILED: '工作总结生成失败'
})
```

`assertInteractiveSummaryPhase` 只接受上述 phase；`safeInteractiveSummaryError` 只返回白名单 `code/message`，不回传原始错误文本。

- [ ] **Step 4: 编写 ADR 并明确被取代的旧路径**

ADR 必须写明：数据库是唯一真相源；workLogs 是兼容导入源；每次 run 独立；Markdown 规范、HTML 派生；renderer 不做状态机；旧共享会话、mtime 完成判断、CLI 格式转换全部废弃；启动中断不自动重放，避免重复 AI 成本。

- [ ] **Step 5: 运行测试并提交契约**

Run: `node --test test/interactive-summary-contracts.test.mjs`

Expected: PASS。

```powershell
git add docs/adr/0003-summary-reports-are-the-canonical-work-summary.md electron/summaries/interactiveSummaryContracts.js test/interactive-summary-contracts.test.mjs
git commit -m "docs: define canonical work summary lifecycle"
```

---

### Task 2: 扩展报告持久化并提供原子完成提交

**Files:**
- Modify: `electron/persistence/db.js:426-467`
- Modify: `electron/persistence/db.js` 的 `createSummaryReport`、`updateSummaryReport`、row mapper 和 current-report transaction
- Modify: `electron/summaries/reportRepository.js:1-220`
- Create: `test/summary-db-migration.test.mjs`
- Modify: `test/summary-job-service.test.mjs`
- Modify: `test/interactive-summary-contracts.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 execution mode、run phase 校验。
- Produces: 报告字段 `executionMode`、`sessionId`、`runPhase`、`artifactMetadata`、`legacyImportKey`；`repository.complete(reportId, result)`；`repository.importCompleted(input)`。

- [ ] **Step 1: 写旧库升级和幂等字段的失败测试**

```js
import assert from 'node:assert/strict'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import initSqlJs from 'sql.js'
import { openDb } from '../electron/persistence/db.js'

test('existing summary database gains interactive run fields without losing reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-db-'))
  const dbPath = join(root, 'ucli.db')
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run(V0115_SUMMARY_REPORTS_DDL)
  legacy.run(`INSERT INTO summary_reports (
    id, period_type, period_start, period_end_exclusive, timezone, partial,
    version, status, markdown, usage_snapshot_json, coverage_json,
    generation_usage_json, generation_metrics_json, is_current, generated_by,
    created_at, updated_at
  ) VALUES ('legacy-r1', 'week', 1, 2, 'Asia/Shanghai', 0, 1, 'completed',
    '# 摘要', '{}', '{}', '{}', '{}', 1, 'manual', 10, 10)`)
  await writeFile(dbPath, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(dbPath)
  const result = db.sql.exec('PRAGMA table_info(summary_reports)')[0]
  const columns = result.values.map(row => row[1])
  assert.ok(columns.includes('execution_mode'))
  assert.ok(columns.includes('session_id'))
  assert.ok(columns.includes('run_phase'))
  assert.ok(columns.includes('artifact_metadata_json'))
  assert.ok(columns.includes('legacy_import_key'))
  assert.equal(db.getSummaryReport('legacy-r1').markdown, '# 摘要')
})
```

测试文件中的旧表常量使用以下确定内容，确保测试真的从缺少五个新列的旧库打开：

```js
const V0115_SUMMARY_REPORTS_DDL = `CREATE TABLE summary_reports (
  id TEXT PRIMARY KEY,
  period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month','quarter','year')),
  period_start INTEGER NOT NULL,
  period_end_exclusive INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','completed','failed','cancelled','interrupted',
    'awaiting_confirmation','skipped_empty'
  )),
  markdown TEXT,
  executor_id TEXT,
  profile_id TEXT,
  model TEXT,
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  generation_usage_json TEXT NOT NULL DEFAULT '{}',
  generation_metrics_json TEXT NOT NULL DEFAULT '{}',
  generation_cost_usd REAL,
  prompt_version TEXT,
  source_hash TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('manual','automatic')),
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (period_type, period_start, period_end_exclusive, timezone, version),
  CHECK (period_start < period_end_exclusive),
  CHECK (is_current = 0 OR status = 'completed')
)`
```

再在 repository 测试中断言：旧记录归一为 `executionMode: 'isolated-runner'`；新 interactive queued 记录保存 `runPhase: 'preparing'`；禁止 patch `version`、`periodStart` 和原始路径。

- [ ] **Step 2: 运行持久化测试并确认字段断言失败**

Run: `node --test test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/summary-job-service.test.mjs`

Expected: FAIL，缺少 `execution_mode` 或 repository 拒绝新字段。

- [ ] **Step 3: 添加向后兼容列和唯一导入索引**

```sql
ALTER TABLE summary_reports ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'isolated-runner'
  CHECK (execution_mode IN ('isolated-runner', 'interactive-cli', 'legacy-worklog-import'));
ALTER TABLE summary_reports ADD COLUMN session_id TEXT;
ALTER TABLE summary_reports ADD COLUMN run_phase TEXT
  CHECK (run_phase IS NULL OR run_phase IN (
    'preparing', 'starting', 'awaiting-delivery', 'running', 'validating',
    'completed', 'failed', 'interrupted', 'cancelled'
  ));
ALTER TABLE summary_reports ADD COLUMN artifact_metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE summary_reports ADD COLUMN legacy_import_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_reports_legacy_import
ON summary_reports(legacy_import_key)
WHERE legacy_import_key IS NOT NULL;
```

每条 `ALTER TABLE` 都先通过 `PRAGMA table_info(summary_reports)` 判断，确保从任意旧版本重复启动安全。

- [ ] **Step 4: 实现 repository 字段归一和原子 `complete()`**

```js
repository.complete = async (reportId, {
  markdown, sourceHash, usageSnapshot, coverage,
  artifactMetadata, updatedAt = now()
}) => normalizeReport(await db.completeSummaryReport(reportId, {
  status: 'completed', runPhase: 'completed', markdown, sourceHash,
  usageSnapshot, coverage, artifactMetadata, errorText: null, updatedAt
}))
```

`db.completeSummaryReport` 必须在同一 transaction 内：确认目标仍为 `running`、写入 Markdown/元数据、清除同逻辑周期旧 `is_current`、将目标设为 current、提交；任何语句失败都 rollback。

- [ ] **Step 5: 实现 `importCompleted()` 的数据库级幂等语义**

```js
const imported = await repository.importCompleted({
  ...period,
  markdown,
  legacyImportKey,
  sourceHash,
  generatedBy: 'manual',
  executionMode: 'legacy-worklog-import',
  artifactMetadata: { canonical: 'markdown', bytes, sha256: sourceHash }
})
// repeated import returns { report, imported: false }
```

若 `legacyImportKey` 已存在，返回原报告；否则分配该逻辑周期的下一个 version 并直接以 completed 非 current 写入，避免导入覆盖用户当前版本。

- [ ] **Step 6: 运行回归并提交持久化**

Run: `node --test test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/summary-job-service.test.mjs`

Expected: PASS，且旧 repository 用例全部保持通过。

```powershell
git add electron/persistence/db.js electron/summaries/reportRepository.js test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/summary-job-service.test.mjs
git commit -m "feat: persist interactive summary runs"
```

---

### Task 3: 在独立 workspace 准备输入并验证规范 Markdown

**Files:**
- Create: `electron/summaries/summaryPreparationService.js`
- Create: `electron/summaries/interactiveSummaryArtifact.js`
- Create: `test/interactive-summary-artifact.test.mjs`
- Modify: `electron/summaries/workLogsService.js`
- Modify: `electron/summaries/summaryWorkspaceService.js`
- Modify: `test/work-logs-service.test.mjs`
- Modify: `test/summary-workspace.test.mjs`

**Interfaces:**
- Consumes: `workspaceService.create(reportId)`、`writeArtifact(reportId, relativePath, content)`，现有 history/usage 收集器。
- Produces: `createSummaryPreparationService(...).prepare({ report, workspace })`；`buildInteractiveSummaryPrompt({ periodLabel })`；`waitForCanonicalMarkdown({ workspacePath, signal, deadlineMs })`。

- [ ] **Step 1: 写隔离和产物校验失败测试**

```js
test('two runs use different inputs and only accept stable canonical markdown', async () => {
  const first = await workspaceService.create('report-v1')
  const second = await workspaceService.create('report-v2')
  assert.notEqual(first.path, second.path)
  assert.equal(first.workDirectory.endsWith(join('report-v1', 'work')), true)

  await writeFile(join(first.path, 'output', 'report.md'), '# 摘要\n\n内容')
  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: first.path, deadlineMs: Date.now() + 50 }),
    { code: 'SUMMARY_ARTIFACT_INVALID' }
  )
})
```

增加用例：符号链接逃逸、0 字节、超过 5 MiB、非 UTF-8、标题乱序、写入过程中 size 改变均不得完成；连续两次 1 秒 stat 一致且标题完整才返回 Markdown 和 sha256。

- [ ] **Step 2: 运行产物测试并确认失败**

Run: `node --test test/interactive-summary-artifact.test.mjs test/summary-workspace.test.mjs`

Expected: FAIL，缺少 artifact/preparation 模块。

- [ ] **Step 3: 抽取无共享目录副作用的材料准备服务**

```js
export function createSummaryPreparationService({ historyService, listSessions, snapshotUsage, workspaceService }) {
  return {
    async prepare({ report, workspace }) {
      const input = await collectSummaryInput({
        periodType: report.periodType,
        start: report.periodStart,
        endExclusive: report.periodEndExclusive,
        timezone: report.timezone,
        historyService, listSessions, snapshotUsage
      })
      await workspaceService.writeArtifact(report.id, 'input/data.json', JSON.stringify(input.data, null, 2))
      await workspaceService.writeArtifact(report.id, 'input/template.md', input.templateMarkdown)
      await workspaceService.writeArtifact(report.id, 'input/README.md', input.readmeMarkdown)
      return { coverage: input.coverage, usageSnapshot: input.usageSnapshot, workspace }
    }
  }
}
```

`workLogsService.prepare()` 仅作为旧 IPC 兼容层调用同一个 `collectSummaryInput`；新 interactive run 不写 flat workLogs root。

- [ ] **Step 4: 实现固定 prompt 和 artifact validator**

```js
export const REQUIRED_HEADINGS = Object.freeze([
  '# 摘要', '## 使用量分析', '## 项目进展',
  '## 跨项目观察', '## 下一步建议', '## 数据覆盖'
])

export function buildInteractiveSummaryPrompt({ periodLabel }) {
  return [
    `为 ${periodLabel} 生成工作总结。`,
    '只读取 ../input/data.json、../input/template.md、../input/README.md。',
    '只写入 ../output/report.md；不要生成 HTML，不要改动其他文件。',
    `标题必须按此顺序出现：${REQUIRED_HEADINGS.join(' → ')}。`
  ].join('\n')
}
```

validator 使用 `lstat + realpath` 确认普通文件且仍位于 `<workspace>/output`，限制 `1..5*1024*1024` 字节，严格 UTF-8 解码，检查标题顺序，并要求两次相隔 1000ms 的 `size/mtimeMs` 相同。

- [ ] **Step 5: 补齐 workspace 安全读取接口**

只新增 `resolveArtifact(reportId, 'output/report.md')`，内部继续走 `artifactPath()` 和 `assertSafeSummaryChild()`；不得把该绝对路径通过 IPC 返回 renderer。

- [ ] **Step 6: 运行回归并提交 workspace 闭环**

Run: `node --test test/interactive-summary-artifact.test.mjs test/work-logs-service.test.mjs test/summary-workspace.test.mjs`

Expected: PASS。

```powershell
git add electron/summaries/summaryPreparationService.js electron/summaries/interactiveSummaryArtifact.js electron/summaries/workLogsService.js electron/summaries/summaryWorkspaceService.js test/interactive-summary-artifact.test.mjs test/work-logs-service.test.mjs test/summary-workspace.test.mjs
git commit -m "feat: isolate and validate summary artifacts"
```

---

### Task 4: 统一 CLI 投递接受与 `turn_started` 确认

**Files:**
- Create: `electron/summaries/interactiveSummarySessionRuntime.js`
- Create: `test/interactive-summary-session-runtime.test.mjs`
- Modify: `electron/adapters/cliAdapter.js`
- Modify: `electron/adapters/codexAdapter.js:749-751`
- Modify: `electron/adapters/openCodeAdapter.js:600-602`
- Verify: `electron/adapters/ucodeAdapter.js`
- Verify: `electron/adapters/claudeAdapter.js:597-624`
- Modify: `test/claude-gateway-capabilities.test.mjs`
- Modify: `test/codex-gateway-capabilities.test.mjs`
- Modify: `test/opencode-gateway-capabilities.test.mjs`
- Modify: `test/ucode-adapter.test.mjs`

**Interfaces:**
- Consumes: adapter `event`、`gateway-event` 和现有 session registry/start/stop functions。
- Produces: `createInteractiveSummarySessionRuntime(...).create/start/waitReady/deliver/subscribe/stop`；所有 adapter 的 `sendTurn(text): Promise<boolean>`。

- [ ] **Step 1: 写 ready 与投递确认失败测试**

```js
test('delivery succeeds only after the same session emits turn_started', async () => {
  const adapter = new FakeAdapter()
  const runtime = createRuntime(adapter)
  const pending = runtime.deliver('session-1', 'prompt', { timeoutMs: 100 })
  adapter.emit('gateway-event', {
    type: 'turn_started', sessionId: 'session-1', turnId: 'turn-1', occurredAt: Date.now()
  })
  assert.deepEqual(await pending, { accepted: true, confirmed: true, turnId: 'turn-1' })
})

test('delivery timeout is typed and terminal', async () => {
  await assert.rejects(runtime.deliver('session-1', 'prompt', { timeoutMs: 10 }), {
    code: 'SUMMARY_TURN_NOT_CONFIRMED'
  })
})
```

另写用例：ready 超时、`sendTurn()` 返回 false、其他 session 的 `turn_started`、先失败/退出、重复 `turn_started`。

- [ ] **Step 2: 运行 session runtime 测试并确认失败**

Run: `node --test test/interactive-summary-session-runtime.test.mjs`

Expected: FAIL，缺少 runtime 模块。

- [ ] **Step 3: 让 Codex/OpenCode/U-Code 明确返回是否写入 PTY**

```js
async sendTurn(text) {
  return this.writeInput(text + '\r')
}
```

Claude 保留 transcript 确认逻辑并返回 boolean；U-Code 显式继承 OpenCode 的 boolean 契约。BaseAdapter JSDoc 固定返回类型，已有普通工作台调用继续兼容。

- [ ] **Step 4: 实现 session runtime 的双重门禁**

```js
async function deliver(sessionId, text, { timeoutMs = 12_000 } = {}) {
  const entry = requireEntry(sessionId)
  const started = waitForGatewayEvent(sessionId, 'turn_started', timeoutMs)
  const accepted = await entry.adapter.sendTurn(text)
  if (accepted !== true) {
    started.cancel()
    throw typed('SUMMARY_TURN_NOT_ACCEPTED')
  }
  const event = await started.promise
  return { accepted: true, confirmed: true, turnId: event.turnId }
}
```

`waitReady` 默认 60 秒；监听在发送前安装；每个 waiter 在 resolve/reject/timeout 时移除 listener 和 timer；`stop` 调用现有 session stop，不移除 UCLI 会话记录。

- [ ] **Step 5: 验证四种 parser 均能发出 lifecycle event**

Run: `node --test test/claude-gateway-capabilities.test.mjs test/codex-gateway-capabilities.test.mjs test/opencode-gateway-capabilities.test.mjs test/ucode-adapter.test.mjs test/interactive-summary-session-runtime.test.mjs`

Expected: 四种 CLI 路径（U-Code 复用 OpenCode parser）均覆盖 `turn_started`、`turn_completed`、`turn_failed/turn_interrupted`，全部 PASS。

- [ ] **Step 6: 提交投递契约**

```powershell
git add electron/adapters electron/summaries/interactiveSummarySessionRuntime.js test/interactive-summary-session-runtime.test.mjs test/claude-gateway-capabilities.test.mjs test/codex-gateway-capabilities.test.mjs test/opencode-gateway-capabilities.test.mjs test/ucode-adapter.test.mjs
git commit -m "fix: confirm summary prompt delivery"
```

---

### Task 5: 实现主进程交互式总结状态机

**Files:**
- Create: `electron/summaries/interactiveSummaryJobService.js`
- Create: `test/fixtures/summaryFakeAdapter.js`
- Create: `test/interactive-summary-job-service.test.mjs`
- Modify: `electron/summaries/summaryWorkspaceService.js`

**Interfaces:**
- Consumes: `repository.createQueued/update/complete`、Task 3 preparation/artifact、Task 4 session runtime。
- Produces: `createInteractiveSummaryJobService(deps)`，含 `start(request): Promise<{ report, sessionId, done }>`、`cancel(reportId)`、`isActive(reportId)`、`subscribe(listener)`、`interruptAll(code)`；`done` 只留在 main process。

- [ ] **Step 1: 写纵向 happy-path 失败测试**

```js
test('interactive run owns report workspace session artifact and atomic completion', async () => {
  const run = await service.start(request({ executorId: 'claude', profileId: 'p1', model: 'm1' }))
  fake.emitReady(run.sessionId)
  fake.emitTurnStarted(run.sessionId, 'turn-1')
  await fake.writeCanonicalMarkdown(run.reportId, validMarkdown)
  const completed = await run.done

  assert.equal(completed.status, 'completed')
  assert.equal(completed.runPhase, 'completed')
  assert.equal(completed.executionMode, 'interactive-cli')
  assert.equal(completed.sessionId, run.sessionId)
  assert.equal(completed.version, 1)
  assert.equal(completed.isCurrent, true)
  assert.equal(completed.markdown, validMarkdown)
})
```

- [ ] **Step 2: 写所有非 happy-path 终态测试**

固定覆盖：ready 60 秒超时、send false、12 秒无 `turn_started`、`turn_completed` 无文件、进程 exit/error、20 分钟总超时、artifact 无效、取消、应用关闭中断、renderer 不订阅仍完成、同周期 v1/v2、并发 day/week、不同 profile/model 创建不同 session。

每个用例都断言 `done` settlement、数据库终态、workspace manifest 终态和 timer/listener 被清理，不允许只断言事件文本。

- [ ] **Step 3: 运行 job 测试并确认失败**

Run: `node --test test/interactive-summary-job-service.test.mjs`

Expected: FAIL，缺少 job service。

- [ ] **Step 4: 实现单 run 状态推进器**

```js
const TRANSITIONS = Object.freeze({
  preparing: ['starting', 'failed', 'cancelled'],
  starting: ['awaiting-delivery', 'failed', 'cancelled'],
  'awaiting-delivery': ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'interrupted', 'cancelled'],
  validating: ['completed', 'failed', 'cancelled']
})

async function transition(job, phase, patch = {}) {
  if (!TRANSITIONS[job.phase]?.includes(phase)) throw typed('SUMMARY_RUN_TRANSITION_INVALID')
  job.phase = phase
  const status = ['failed', 'interrupted', 'cancelled'].includes(phase) ? phase : 'running'
  const report = repository.update(job.reportId, { status, runPhase: phase, ...patch, updatedAt: now() })
  publish(report)
  return report
}
```

`start()` 必须先同步创建 queued report，再创建 workspace/session；session 名固定为 `工作总结（<period label>）v<version>`，cwd 固定为该 report 的 `work` 目录，使用本次 request 的 executor/profile/model，不查询或复用历史 session。

- [ ] **Step 5: 实现有上界的 artifact/turn 竞态**

run 进入 `running` 后并行监听：artifact validator、同 turn 的 `turn_failed/turn_interrupted/session_stopped` 和 20 分钟 deadline。artifact 有效时进入 validating，调用 `repository.complete()` 原子入库；随后 best-effort 调用 `workspaceService.complete(reportId, { markdown })`，workspace 收尾失败只记安全 operational code，不能把已入库 completed 报告反向改成 failed。turn completed 但文件缺失时给 validator 最多 5 秒稳定窗口，随后以 `SUMMARY_ARTIFACT_MISSING` 失败。

- [ ] **Step 6: 实现取消、中断和资源释放**

`cancel(reportId)` abort validator、停止 CLI、标记 cancelled；`interruptAll('SUMMARY_APP_SHUTDOWN')` 将 active run 标记 interrupted 并停止进程；所有 terminal path 都清 timer/listener/AbortController，并从 active map 移除。不得自动重放 interrupted run。

- [ ] **Step 7: 运行纵向测试并提交状态机**

Run: `node --test test/interactive-summary-job-service.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-session-runtime.test.mjs`

Expected: PASS，无 pending timer 警告。

```powershell
git add electron/summaries/interactiveSummaryJobService.js electron/summaries/summaryWorkspaceService.js test/fixtures/summaryFakeAdapter.js test/interactive-summary-job-service.test.mjs
git commit -m "feat: own interactive summaries in main process"
```

---

### Task 6: 装配 IPC、进度发布、重启与调度去重

**Files:**
- Modify: `electron/orchestrator.js:504-563, 879-1005, 1675-1799, 2938-3027, shutdown lifecycle`
- Modify: `electron/preload.js:168-189`
- Modify: `src/ipc.js:109-115`
- Modify: `electron/summaries/summaryScheduler.js`
- Modify: `test/summary-ipc.test.mjs`
- Modify: `test/summary-startup.test.mjs`
- Modify: `test/summary-scheduler.test.mjs`
- Modify: `test/summary-settings.test.mjs`

**Interfaces:**
- Consumes: Task 5 `interactiveJobService.start/cancel/interruptAll/subscribe`。
- Produces: IPC `summary:start-interactive`、既有 `summary:cancel` 对两类 job 的统一路由、扩展后的 `summary:progress` safe payload。

- [ ] **Step 1: 写 IPC 最小表面和脱敏失败测试**

```js
const INTERACTIVE_CHANNELS = ['summary:start-interactive', 'summary:cancel']

test('interactive summary IPC returns identifiers but no workspace or prompt', async () => {
  const result = await handlers.get('summary:start-interactive')({}, {
    periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai',
    partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet'
  })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.data).sort(), ['report', 'sessionId'])
  assert.equal(JSON.stringify(result).includes('workspace'), false)
  assert.equal(JSON.stringify(result).includes('prompt'), false)
})
```

验证器只允许上述字段，拒绝 renderer 提供 `reportId`、`sessionId`、`cwd`、output path 或 `generatedBy`。

进度 payload 固定为 `{ reportId, status, phase, completed, total, text }`；不得包含 session transcript、prompt、workspace path 或 raw error。

- [ ] **Step 2: 运行 IPC/启动/调度测试并确认失败**

Run: `node --test test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs`

Expected: FAIL，缺少 `summary:start-interactive` 或装配顺序断言失败。

- [ ] **Step 3: 从 orchestrator 抽取可复用的 session runtime closures**

将现有 `session:start-adapter`、`session:send-turn`、`session:stop` 的主体分别抽为 `startAdapterSession(sessionId)`、`sendSessionTurn(sessionId, text)`、`stopSession(sessionId, reason)`；IPC handler 与 interactive runtime 都调用这些函数，避免第二套进程控制逻辑。

```js
const interactiveSessionRuntime = createInteractiveSummarySessionRuntime({
  createSession,
  resolveEntry: sessionId => sessions.get(sessionId) || null,
  startSession: startAdapterSession,
  stopSession,
  defaultTier: () => settings.defaultTier
})
```

- [ ] **Step 4: 注册 interactive service 与安全 IPC**

```js
interactiveSummaryJobService = createInteractiveSummaryJobService({
  repository: summaryRepository,
  workspaceService: summaryWorkspaceService,
  preparationService: summaryPreparationService,
  sessionRuntime: interactiveSessionRuntime
})

ipcMain.handle('summary:start-interactive', safeSummaryEnvelope((_event, value) =>
  interactiveSummaryJobService.start(validateInteractiveSummaryRequest(value)).then(run => ({
    report: run.report,
    sessionId: run.sessionId
  }))))
```

`summary:cancel` 先查 interactive active map，再查现有 headless summary job；不存在时返回 `SUMMARY_JOB_NOT_ACTIVE`。

- [ ] **Step 5: 发布可恢复的进度并处理中断**

`summaryProgressPayload` 对 interactive report 使用 `runPhase`，文本固定映射 preparing/starting/awaiting-delivery/running/validating/terminal。初始化时先 `repository.interruptStale()` 和 `workspaceService.recover()`，再接受新 run；应用 `before-quit` 时 await `interactiveSummaryJobService.interruptAll('SUMMARY_APP_SHUTDOWN')`，不自动重启旧 run。

- [ ] **Step 6: 让 scheduler 只依赖规范 completed report**

```js
test('completed interactive report suppresses reminder for its logical period', async () => {
  await repository.complete(report.id, completedResult)
  const reminder = await scheduler.evaluate(period)
  assert.equal(reminder, null)
})
```

不得让 scheduler 读取 workLogs 文件或 renderer task；已有数据库 completed 报告、新 interactive 报告和后续 legacy import 统一命中同一查询。

- [ ] **Step 7: 运行回归并提交装配**

Run: `node --test test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/summary-settings.test.mjs test/interactive-summary-job-service.test.mjs`

Expected: PASS。

```powershell
git add electron/orchestrator.js electron/preload.js src/ipc.js electron/summaries/summaryScheduler.js test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/summary-settings.test.mjs
git commit -m "feat: wire interactive summary lifecycle"
```

---

### Task 7: 幂等导入旧 workLogs，保留全部历史

**Files:**
- Create: `electron/summaries/legacyWorkLogsImporter.js`
- Create: `test/legacy-worklogs-import.test.mjs`
- Modify: `electron/orchestrator.js` 的 summary startup sequence
- Modify: `electron/summaries/workLogsService.js`
- Modify: `test/summary-startup.test.mjs`

**Interfaces:**
- Consumes: Task 2 `repository.importCompleted(input)` 和 `resolveSummaryWorkLogsRoot()`。
- Produces: `createLegacyWorkLogsImporter({ workLogsRoot, repository, timezone, now }).run()`，返回 `{ scanned, imported, existing, rejected }` 的计数，不返回文件内容或绝对路径。

- [ ] **Step 1: 写文件名解析和幂等导入失败测试**

```js
test('legacy markdown is imported once and never changes current report', async () => {
  await writeFile(join(root, '2026-W33-summary.md'), validMarkdown)
  const first = await importer.run()
  const second = await importer.run()

  assert.deepEqual(first, { scanned: 1, imported: 1, existing: 0, rejected: 0 })
  assert.deepEqual(second, { scanned: 1, imported: 0, existing: 1, rejected: 0 })
  const [report] = repository.list().filter(item => item.executionMode === 'legacy-worklog-import')
  assert.equal(report.periodType, 'week')
  assert.equal(report.status, 'completed')
  assert.equal(report.isCurrent, false)
  assert.equal(JSON.stringify(report).includes(root), false)
})
```

增加 day/month/quarter/year 文件名、template/README 忽略、HTML 忽略、无效 UTF-8、标题缺失、同名内容变化生成新 import key、旧数据库报告不变的测试。

- [ ] **Step 2: 运行 importer 测试并确认失败**

Run: `node --test test/legacy-worklogs-import.test.mjs`

Expected: FAIL，缺少 importer 模块。

- [ ] **Step 3: 实现封闭文件名解析器**

```js
const LEGACY_PATTERNS = Object.freeze([
  ['day', /^(\d{4})-(\d{2})-(\d{2})-summary\.md$/],
  ['week', /^(\d{4})-W(\d{2})-summary\.md$/],
  ['month', /^(\d{4})-(\d{2})-summary\.md$/],
  ['quarter', /^(\d{4})-Q([1-4])-summary\.md$/],
  ['year', /^(\d{4})-summary\.md$/]
])
```

周期边界必须调用现有 period helper 计算 `[start, endExclusive)`，不得用文件 mtime 猜周期；文件 mtime 仅作为 imported report 的 createdAt 候选并夹在 `0..now()`。

- [ ] **Step 4: 实现内容校验、hash 和幂等写入**

`sourceHash = sha256(markdown)`；`legacyImportKey = sha256(fileName + '\0' + markdown)`。旧格式兼容校验只要求普通非符号链接文件、UTF-8、`1..5 MiB` 和至少一个 Markdown 标题，不强制新模板标题顺序，也不要求两次 stat 稳定；导入记录的 coverage 增加 `legacyFormat: true`。单文件失败只增加 rejected 并记录安全 code，不阻止其他文件导入。

- [ ] **Step 5: 在 scheduler 启动前运行一次 importer**

启动顺序固定为：打开 DB → repository migration → interrupt stale → recover workspace → legacy import → scheduler evaluate。导入失败只发安全 operational event；不得阻止应用打开，也不得在每次页面进入时重复扫描。

- [ ] **Step 6: 运行 importer/startup 回归并提交**

Run: `node --test test/legacy-worklogs-import.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/work-logs-service.test.mjs`

Expected: PASS，重复启动报告数量不增加。

```powershell
git add electron/summaries/legacyWorkLogsImporter.js electron/summaries/workLogsService.js electron/orchestrator.js test/legacy-worklogs-import.test.mjs test/summary-startup.test.mjs
git commit -m "feat: import legacy work summaries safely"
```

---

### Task 8: 将统计页迁移到规范报告与主进程进度

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/summary-view-mounted.test.mjs`
- Modify: `src/stores/summaries.js`
- Modify: `src/components/summaries/SummaryGenerateDialog.vue`
- Modify: `src/components/summaries/WorkSummaryPanel.vue`
- Modify: `src/components/summaries/SummaryConversationDrawer.vue`
- Modify: `src/components/summaries/SummaryHistory.vue`
- Modify: `src/components/summaries/SummaryReportView.vue`
- Modify: `test/summary-view.test.mjs`
- Modify: `test/stats-view.test.mjs`

**Interfaces:**
- Consumes: Task 6 IPC `startInteractiveSummary(request)`、`cancelSummary(reportId)`、`onSummaryProgress(listener)`、现有 list/get/setCurrent/delete/export API。
- Produces: Pinia actions `generateInteractive(request)`、`applyProgress(progress)`、`selectReport(reportId)`；UI 仅渲染数据库 reports。

- [ ] **Step 1: 安装固定测试挂载依赖**

Run: `npm install --save-dev @vue/test-utils@2.4.6 jsdom@26.1.0`

Expected: 只修改 `devDependencies` 和 lockfile，不增加 `dependencies`。

- [ ] **Step 2: 写真实挂载失败测试**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

test('mounted work summary panel generates, receives progress and opens canonical report', async () => {
  const startCalls = []
  let summaryProgressListener = () => {}
  const request = {
    periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai',
    partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet'
  }
  const queuedReport = {
    id: 'r1', version: 1, status: 'queued', runPhase: 'preparing',
    executionMode: 'interactive-cli', markdown: null, sessionId: 'session-1'
  }
  const completedReport = {
    ...queuedReport, status: 'completed', runPhase: 'completed',
    markdown: '# 摘要\n\nversion one marker'
  }
  window.ucli = {
    listSummaryReports: async () => [],
    getSummaryReport: async () => completedReport,
    startInteractiveSummary: async value => {
      startCalls.push(value)
      return { report: queuedReport, sessionId: 'session-1' }
    },
    onSummaryProgress: listener => {
      summaryProgressListener = listener
      return () => { summaryProgressListener = () => {} }
    }
  }
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  const { default: WorkSummaryPanel } = await vite.ssrLoadModule('/src/components/summaries/WorkSummaryPanel.vue')
  const GenerateDialogStub = defineComponent({
    name: 'SummaryGenerateDialog', emits: ['submit'],
    setup: () => ({ request }),
    template: '<button data-testid="summary-generate" @click="$emit(\'submit\', request)">生成</button>'
  })
  const ReportViewStub = defineComponent({
    name: 'SummaryReportView', props: { markdown: String }, template: '<article>{{ markdown }}</article>'
  })
  const wrapper = shallowMount(WorkSummaryPanel, {
    global: {
      plugins: [createPinia()],
      stubs: { SummaryGenerateDialog: GenerateDialogStub, SummaryReportView: ReportViewStub }
    }
  })

  await wrapper.get('[data-testid="summary-generate"]').trigger('click')
  summaryProgressListener({ reportId: 'r1', phase: 'running', status: 'running', completed: 0, total: 1, text: '正在生成总结' })
  summaryProgressListener({ reportId: 'r1', phase: 'completed', status: 'completed', text: '总结已生成' })
  await flushPromises()

  assert.equal(startCalls.length, 1)
  assert.match(wrapper.text(), /总结已生成/)
  assert.match(wrapper.text(), /# 摘要/)
  await vite.close()
})
```

jsdom 中固定 `window.ucli` fake；Vite middleware 加载真实 `.vue`；测试还覆盖失败重试、取消、v1/v2 切换、旧数据库报告显示、按 report session 打开对话。不得用源码字符串存在代替这些行为断言。

- [ ] **Step 3: 运行 mounted test 并确认旧 UI 失败**

Run: `node --test test/summary-view-mounted.test.mjs`

Expected: FAIL，旧组件调用 `prepareSummary/createSession/startAdapter/sendTurn` 或依赖 `summaryTasks`。

- [ ] **Step 4: 将 store 改为报告仓库投影**

```js
async generateInteractive(request) {
  const { report, sessionId } = await ipc.startInteractiveSummary(request)
  this.upsertReport({ ...report, sessionId })
  this.selectedReportId = report.id
  return report
},
applyProgress(progress) {
  const report = this.reports.find(item => item.id === progress.reportId)
  if (report) Object.assign(report, {
    status: progress.status, runPhase: progress.phase, progressText: progress.text
  })
}
```

store 初始化只调用 `listSummaryReports` 并订阅 `summary:progress`；不得读取 sessions taskNote、workLogs 文件名或 mtime。

- [ ] **Step 5: 简化生成对话框并重建 panel**

`SummaryGenerateDialog` 只 emit `{ periodType,start,endExclusive,timezone,partial,executorId,profileId,model }`。`WorkSummaryPanel` 显示报告状态列表、版本历史、当前报告预览、失败原因安全文案、取消/重试/设为当前/删除/导出；重试创建新 version，不复用 session。

- [ ] **Step 6: 按 report 绑定对话历史**

`SummaryConversationDrawer` 接收 `{ reportId, sessionId }`；`sessionId` 为空（旧 headless/import 报告）时显示“此报告没有关联的交互会话”，不得回退查找同周期共享会话。

- [ ] **Step 7: 运行 view/store 回归并提交 UI 迁移**

Run: `node --test test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/stats-view.test.mjs`

Expected: PASS；源码契约明确不存在 `prepareSummary`、`summaryTasks.addTask`、`reportProducedByRun`、renderer `setInterval`。

```powershell
git add package.json package-lock.json src/stores/summaries.js src/components/summaries test/summary-view-mounted.test.mjs test/summary-view.test.mjs test/stats-view.test.mjs
git commit -m "feat: unify work summary report UI"
```

---

### Task 9: 统一预览/导出并删除旧任务与 CLI 转换路径

**Files:**
- Modify: `electron/summaries/reportExportService.js`
- Modify: `electron/orchestrator.js`
- Modify: `electron/preload.js`
- Modify: `src/ipc.js`
- Modify: `src/components/summaries/WorkSummaryPanel.vue`
- Modify: `src/components/summaries/SummaryHtmlStyleDialog.vue`
- Modify: `test/summary-export.test.mjs`
- Modify: `test/summary-ipc.test.mjs`
- Modify: `test/summary-view.test.mjs`
- Delete: `src/stores/summaryTasks.js`
- Delete: `src/components/summaries/summaryTaskNote.js`
- Delete: `src/components/summaries/summaryTaskStatus.js`
- Delete: `src/components/summaries/SummaryTaskCard.vue`
- Delete: `src/components/summaries/SummaryTaskDetail.vue`

**Interfaces:**
- Consumes: completed report 的 `markdown` 和现有 `summaryThemeRenderer`/HTML safety validation。
- Produces: 只接受 `{ reportId, destination/style }` 的 Markdown/HTML 导出；无 format-conversion session。

- [ ] **Step 1: 写旧目标存在也必须重写的导出测试**

```js
test('HTML export derives from the selected report even when destination exists', async () => {
  await writeFile(destination, '<html>stale</html>')
  const result = await service.exportHtml({ reportId: 'r2', destination, style: { mode: 'light' } })
  const html = await readFile(destination, 'utf8')
  assert.equal(result.reportId, 'r2')
  assert.match(html, /version two marker/)
  assert.doesNotMatch(html, /stale/)
})
```

增加断言：queued/failed 报告不可导出；renderer 不能传 markdown/html 原文；导出取消不改变 report status；自定义 HTML 仍经过现有安全校验。

- [ ] **Step 2: 运行导出测试并确认旧转换路径不满足断言**

Run: `node --test test/summary-export.test.mjs test/summary-view.test.mjs`

Expected: FAIL，旧 UI 仍启动 CLI 转换或按目标文件是否存在判成功。

- [ ] **Step 3: 将预览和导出统一到规范 Markdown**

```js
async exportHtml({ reportId, destination, style }) {
  const report = requireCompletedReport(reportId)
  const html = await renderer.render({ markdown: report.markdown, style })
  await validateAndWriteHtml(destination, html)
  return { reportId, destination, bytes: Buffer.byteLength(html) }
}
```

写入继续使用现有安全保存对话框和原子文件替换；目标已存在时由用户在保存对话框确认覆盖，完成判定来自 write 成功，不检查旧文件存在性。

- [ ] **Step 4: 删除公共 workLogs/转换 IPC 和 renderer orchestration**

移除 `summary:prepare`、`summary:list-worklogs`、`summary:read-worklog` 及 preload/src IPC wrappers；legacy importer 保留 main-process 内部读取。删除 `onSummaryOpen`、`waitForReady`、`sendWhenIdle`、`pollTasks`、`startConversion` 和 conversion session 创建逻辑。

- [ ] **Step 5: 删除旧 taskNote 状态投影文件并修正 import**

删除本任务 Files 中列出的五个文件；全仓搜索不得再出现 `useSummaryTasksStore`、`summaryTaskNote`、`summaryTaskStatus`、`suggestedFileName` 作为任务完成依据。

- [ ] **Step 6: 运行导出/IPC/UI 回归并提交清理**

Run: `node --test test/summary-export.test.mjs test/summary-ipc.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs`

Expected: PASS；现有报告样式和 HTML 安全测试保持通过。

```powershell
git add electron/summaries/reportExportService.js electron/orchestrator.js electron/preload.js src/ipc.js src/components/summaries test/summary-export.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs
git add -u src/stores/summaryTasks.js src/components/summaries
git commit -m "refactor: remove split summary task workflow"
```

---

### Task 10: 建立零失败门禁、四 CLI 验收和版本收口

**Files:**
- Create: `test/helpers/fsCapabilities.mjs`
- Create: `docs/qa/2026-08-24-work-summary-closure-acceptance.md`
- Modify: `scripts/package-dsh-bridge.mjs`
- Modify: `test/dsh-bridge-package.test.mjs`
- Modify: `test/skills-audit.test.mjs`
- Modify: `test/skills-service.test.mjs`
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `scripts/verify-release.mjs`

**Interfaces:**
- Consumes: Tasks 1-9 的完整业务链路。
- Produces: 可重复的 `npm test`/build/release gate，版本 `0.11.6`，四 CLI 验收记录。

- [ ] **Step 1: 隔离 DSH 打包测试产物**

`scripts/package-dsh-bridge.mjs` 从 `process.env.UCLI_DSH_BRIDGE_OUTPUT_ROOT` 读取可选输出根；未设置时保持生产 `resources/deepseek-harness`。测试创建独立 temp root 并传入环境变量，测试结束只清理该 temp root，不 unlink 正在被 dev/build 使用的生产 tgz。

```js
const outputRoot = process.env.UCLI_DSH_BRIDGE_OUTPUT_ROOT
  ? path.resolve(process.env.UCLI_DSH_BRIDGE_OUTPUT_ROOT)
  : path.join(root, 'resources', 'deepseek-harness')
```

- [ ] **Step 2: 统一 Windows symlink 能力探测**

```js
export function symlinkOrSkip(t, target, link, type) {
  try {
    symlinkSync(target, link, type)
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip(`Windows ${type} capability unavailable`)
      return false
    }
    throw error
  }
}
```

只在“创建能力不可用”时 skip；创建成功后的业务断言失败仍必须 fail。具备 Developer Mode/管理员权限的 Windows 发布环境必须执行这些测试，不能依靠 skip 作为发布证据。

- [ ] **Step 3: 运行 summary 聚焦测试集**

Run:

```powershell
node --test test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs test/legacy-worklogs-import.test.mjs test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/summary-export.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs
```

Expected: exit 0；0 fail；除明确平台能力外 0 skip；进程结束后无 active handle/timer warning。

- [ ] **Step 4: 运行项目全量自动化门禁**

Run:

```powershell
npm test
npm run build
npm run verify:release
git diff --check
```

Expected: 四条命令全部 exit 0；`npm test` 0 fail；build 的 main/preload/renderer 三目标成功；release verifier 识别 `0.11.6` 和正确 DSH bridge artifact；diff 无 whitespace error。

- [ ] **Step 5: 在受控环境执行四 CLI 相同验收脚本**

对 Claude、Codex、OpenCode、U-Code 分别执行以下固定流程并在 QA 文档记录 CLI 版本、profile/model、reportId、sessionId、开始/完成时间和 PASS/FAIL：

1. 新建周总结，观察一次 `turn_started`，生成并打开 Markdown。
2. 同周期改 profile/model 重跑，确认 v2、独立 session、v1 内容不变。
3. 并发启动日总结，确认 workspace/报告互不覆盖。
4. 中断一个 run，确认数据库为 interrupted，重启后不永久 running、不自动重放。
5. 导出 HTML 到已存在目标，确认新内容来自所选 report。
6. 重启应用，确认当前报告、版本、会话历史仍可打开，scheduler 不重复提醒。

任一 CLI 未出现可确认的 `turn_started`、任一报告不可恢复或任一历史被覆盖，验收结果为 FAIL，禁止进入版本提交。

- [ ] **Step 6: 构建安装包并做安装态验收**

Run: `npm run dist:win`

Expected: exit 0，安装包版本为 `0.11.6`。安装后重复 Claude 与 Codex 的步骤 1、5、6，并确认数据库从旧版升级、旧 workLogs 只导入一次、原文件仍存在。

- [ ] **Step 7: 同步文档和版本事实**

`README.md` 说明“每次生成独立会话、Markdown 规范、HTML 本地导出”；`CONTEXT.md` 增加“工作总结报告/run/workspace/session”术语和所有权；`CHANGELOG.md` 的 `0.11.6` 记录双真相源、覆盖、投递、状态卡死、历史绑定和测试门禁修复；package/lock version 同步为 `0.11.6`。QA 文档附上述命令 exit code 和四 CLI 结果，不写 prompt/transcript/绝对路径。

- [ ] **Step 8: 最终检查并提交版本收口**

Run:

```powershell
git status --short
git diff --stat
git diff --check
```

Expected: 只包含本计划文件范围内的变更和既有用户变更；无意外产物、数据库、workLogs 或凭据进入 git。

```powershell
git add scripts/package-dsh-bridge.mjs test/helpers/fsCapabilities.mjs test/dsh-bridge-package.test.mjs test/skills-audit.test.mjs test/skills-service.test.mjs README.md CONTEXT.md CHANGELOG.md package.json package-lock.json docs/qa/2026-08-24-work-summary-closure-acceptance.md
git add -u test
git commit -m "release: close work summary workflow in 0.11.6"
```

---

## 执行顺序与评审门禁

1. Tasks 1-2 是数据契约门禁；评审通过前不允许迁移 UI。
2. Tasks 3-5 是运行闭环门禁；fake adapter 的所有终态测试通过前不装配 renderer。
3. Tasks 6-7 是集成与迁移门禁；必须先证明旧报告/旧文件不丢失，再切换 UI。
4. Tasks 8-9 是用户路径切换；mounted test 通过后才删除旧 task 投影。
5. Task 10 是发布门禁；自动化和四 CLI 人工验收必须同时通过。

## 回滚策略

- 数据库迁移只加列和索引，不删除旧列；回滚应用版本时旧程序会忽略新增列。
- legacy import 不设 current、不删除文件；若 UI 回滚，旧 workLogs 仍可由旧版本读取。
- 每个 task 单独 commit；若某门禁失败，只 revert 该 task 及其后续依赖 commit，不 reset 用户工作树。
- 切换 UI 前保留旧代码到 Task 9；若 Task 8 现场验收失败，可回滚 Task 8，主进程新报告仍保存在数据库。
- 已 completed 的 Markdown 永不因 workspace 清理丢失；数据库是恢复依据，workspace 只保留派生/诊断产物。

## 完成定义

- 同周期重跑生成单调 version，v1/v2 的 Markdown、session/profile/model 均一一对应且不可互相覆盖。
- 并发 day/week run 的输入、输出、状态和取消互不影响。
- ready、投递、执行、产物、退出、取消、关闭应用的每条路径都在有限时间进入数据库终态。
- completed 只可能来自稳定、结构有效的规范 Markdown 原子提交。
- 旧数据库报告和旧 workLogs 导入报告统一可见；重复启动不产生重复导入。
- scheduler 对任一规范 completed 报告正确去重提醒。
- 预览、Markdown 导出、HTML 导出均读取所选 `reportId` 的数据库 Markdown。
- renderer 切页、销毁或重载不会中断主进程 run，也不会制造永久 running。
- `npm test`、`npm run build`、`npm run verify:release`、`git diff --check` 全部 exit 0。
- Claude、Codex、OpenCode、U-Code 和 Windows 安装态验收记录全部为 PASS。
