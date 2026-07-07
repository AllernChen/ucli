# UCLI 代码审查整改计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审查发现的 8 个问题，恢复 PTY 终端模式下的核心功能（resume、历史回放、权限拦截、统计）。

**Architecture:** 逐个修复 claudeAdapter / orchestrator / sessions store 中的 bug，每个修复独立可测。修复顺序按严重程度：正确性 bug 优先，清理项在后。

**Tech Stack:** Electron 32 + Vue 3 + node-pty + sql.js + xterm.js

## Global Constraints

- 平台：Windows 10，PowerShell 作为 claude 的启动 shell
- 不要改动 IPC 通道签名（preload.js / ipc.js 的方法名保持不变）
- 每个修复后运行 `npm run build` 确认编译通过
- 不要引入新的 npm 依赖

---

## 文件结构

| 文件 | 职责 | 本次改动 |
|------|------|----------|
| `electron/adapters/claudeAdapter.js` | PTY 终端适配器 | 修复 #1 #3 #4，提取 transcript 路径辅助函数 |
| `electron/adapters/cliAdapter.js` | BaseAdapter 基类 | 不改动 |
| `electron/orchestrator.js` | 会话生命周期 + IPC | 修复 #2 #5 #7 #8，提取共享扫描函数 |
| `src/stores/sessions.js` | Pinia 会话 store | 修复 #6，过滤 terminal 事件 |
| `src/views/SessionDetail.vue` | 终端详情页 | 不改动（修复在后端） |

---

### Task 1: 修复 resume() 后事件被丢弃（_disposed 未重置）

**Files:**
- Modify: `electron/adapters/claudeAdapter.js` — `start()` 方法（~line 247）和 `dispose()` 方法（~line 335）

**Interfaces:**
- Produces: `start()` 在开头重置 `this._disposed = false`；`dispose()` 清理 `_statsTimer`

**问题：** `dispose()` 设置 `this._disposed = true`，但 `start()` 从不重置为 `false`。`resume()` 调用 `dispose()` 再 `start()`，导致 `emitEvent` 静默丢弃所有事件，会话变黑洞。

- [ ] **Step 1: 在 start() 开头重置 _disposed**

修改 `electron/adapters/claudeAdapter.js` 的 `start()` 方法，在第一行（`if (!pty)` 之前）加入：

```js
async start() {
  this._disposed = false
  if (!pty) {
```

- [ ] **Step 2: 在 dispose() 中清理 _statsTimer**

修改 `dispose()` 方法，在 `this._disposed = true` 之后加入清理定时器：

```js
async dispose() {
  this._disposed = true
  if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }
  if (this.ptyProc) {
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译通过，无报错

- [ ] **Step 4: 手动验证 resume 功能**

Run: `npm run dev`
1. 新建一个 Claude 会话，发一条消息
2. 点「停止」→ 会话变离线
3. 点「重新启动」
4. Expected: 终端显示历史记录 + claude 恢复，能继续输入

- [ ] **Step 5: Commit**

```bash
git add electron/adapters/claudeAdapter.js
git commit -m "fix: reset _disposed in start() and clear _statsTimer in dispose()

Fixes #1 and #4 from code review: resume() left _disposed=true causing
all events to be silently dropped; _statsTimer was not cleared on dispose
causing a resource leak and potential stale stats."
```

---

### Task 2: 修复历史回放事件在渲染进程订阅前发出

**Files:**
- Modify: `electron/orchestrator.js` — `session:create` IPC handler（~line 388）

**Interfaces:**
- Produces: `session:create` 在启动 adapter 前发一个 `session:created` 事件，渲染进程收到后再 start

**问题：** `hookReady.then(() => adapter.start())` 微任务在 IPC 响应返回前运行，`_replayHistory()` 发出的 `session:terminal-output` 事件被丢弃——渲染进程还没注册监听器。

- [ ] **Step 1: 改为延迟启动——等渲染进程确认就绪**

修改 `electron/orchestrator.js` 的 `session:create` handler：

```js
ipcMain.handle('session:create', (_e, config) => {
  const { sessionId } = createSession(config)
  return { sessionId }
})

// Renderer calls this after it has registered the terminal-output listener
ipcMain.handle('session:start-adapter', (_e, sessionId) => {
  const e = sessions.get(sessionId)
  if (!e || !e.adapter) return false
  hookReady.then(() => {
    e.adapter.hookPort = hookPort
    return e.adapter.start()
  })
  return true
})
```

- [ ] **Step 2: 在 preload.js 添加 start-adapter 桥接**

在 `electron/preload.js` 的 session lifecycle 区块添加：

```js
startAdapter: (sessionId) => ipcRenderer.invoke('session:start-adapter', sessionId),
```

放在 `createSession` 行之后。

- [ ] **Step 3: 在 ipc.js 添加封装**

在 `src/ipc.js` 的 sessions 区块添加：

```js
startAdapter: (sessionId) => u.startAdapter(sessionId),
```

放在 `createSession` 行之后。

- [ ] **Step 4: 渲染进程在订阅后调用 startAdapter**

修改 `src/stores/sessions.js` 的 `createSession` action，在 push summary 之后调用 start：

```js
async createSession(config) {
  const { sessionId } = await ipc.createSession(config)
  // ... existing summary push code ...
  this.activities[sessionId] = []
  this.pendingApprovals[sessionId] = []
  // Start the adapter AFTER the store is ready — the renderer's
  // terminal-output listener (registered in SessionDetail onMounted)
  // will catch the replayed history.
  ipc.startAdapter(sessionId)
  return sessionId
}
```

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 6: 手动验证历史回放**

Run: `npm run dev`
1. 新建会话，选一个有历史的目录
2. 进入详情页
3. Expected: 终端显示「━━━ 历史记录 ━━━」和之前的对话

- [ ] **Step 7: Commit**

```bash
git add electron/orchestrator.js electron/preload.js src/ipc.js src/stores/sessions.js
git commit -m "fix: defer adapter.start() until renderer subscribes to terminal-output

Fixes #2: history replay events were emitted before the renderer
registered its session:terminal-output listener, so the replayed
transcript was silently dropped on session creation."
```

---

### Task 3: 修复 PowerShell -Command 在路径含空格时破坏参数

**Files:**
- Modify: `electron/adapters/claudeAdapter.js` — PTY spawn 参数构造（~line 279）

**Interfaces:**
- Produces: Windows 上用 `-Command` + 单引号包裹每个参数，避免空格截断

**问题：** `powershell.exe -NoProfile -Command claude --settings C:\Users\John Doe\...` 中，PowerShell 的 `-Command` 把后续参数拼接成字符串重新解析，路径含空格时 `--settings` 被截断，导致 claude 找不到 settings 文件，权限 hook 未注册，三档权限引擎被绕过。

- [ ] **Step 1: 用单引号包裹 PowerShell 参数**

修改 `electron/adapters/claudeAdapter.js` 的 PTY spawn 部分（~line 276-282）：

```js
try {
  // node-pty needs a real executable. `claude` on Windows is a .ps1 shim,
  // so we spawn it through powershell. We must single-quote each arg
  // because PowerShell's -Command joins all args into one string and
  // re-parses — bare paths with spaces (e.g. "John Doe") get split.
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'claude'
  const shellArgs = process.platform === 'win32'
    ? ['-NoProfile', '-Command', '& claude ' + args.map(a => `'${a.replace(/'/g, "''")}'`).join(' ')]
    : args
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: 手动验证权限拦截（需要用户名含空格的场景）**

Run: `npm run dev`
1. 新建会话，安全规则模式
2. 发一条让 claude 执行 `rm` 的消息
3. Expected: 弹出审批面板（如果路径含空格，之前会绕过）

> 注意：当前用户名 `Radar-001` 不含空格，此修复是预防性的。验证时确认正常场景不受影响即可。

- [ ] **Step 4: Commit**

```bash
git add electron/adapters/claudeAdapter.js
git commit -m "fix: single-quote PowerShell args to handle spaces in --settings path

Fixes #3: PowerShell's -Command joins args into one string and re-parses,
splitting paths with spaces (e.g. 'John Doe'). This broke --settings
loading and silently bypassed the permission hook for affected users."
```

---

### Task 4: 修复审批统计管道断裂

**Files:**
- Modify: `electron/orchestrator.js` — `onDecision` 回调（~line 148）和 `handleAdapterEvent` 的 `stats_update` case

**Interfaces:**
- Produces: `onDecision` 直接更新 `entry.stats.approvals`，不再走 `_dirtyStats`

**问题：** `onDecision` 累加到 `s._dirtyStats`，但 `_dirtyStats` 从未被读取；`e.stats.approvals` 初始化为 0 后从不更新；统计页审批分布永远显示 0。

- [ ] **Step 1: 简化 onDecision——直接更新 stats.approvals**

修改 `electron/orchestrator.js` 的 `onDecision` 回调（~line 148-156）：

```js
onDecision(d) {
  const s = sessions.get(d.sessionId)
  if (!s) return
  const key = d.asked
    ? (d.verdict === 'allow' ? 'confirmed' : 'denied')
    : (d.verdict === 'allow' ? 'autoAllowed' : 'denied')
  s.stats.approvals[key] = (s.stats.approvals[key] || 0) + 1
  scheduleFlush()
}
```

- [ ] **Step 2: 在 stats:get 中持久化审批统计到 DB**

修改 `stats:get` handler（Task 5 会清理 diag，这里先加持久化），在 return 前加入：

```js
// Persist approval stats to DB
const db = getDb()
if (db) {
  for (const [id, e] of sessions) {
    db.upsertStats(id, {
      inputTokens: 0, outputTokens: 0, costUsd: 0, turnsDelta: 0,
      autoAllowed: e.stats.approvals.autoAllowed,
      confirmed: e.stats.approvals.confirmed,
      denied: e.stats.approvals.denied
    })
  }
}
```

放在 `const result = { ... }` 之前。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 4: 手动验证审批统计**

Run: `npm run dev`
1. 新建会话，安全规则模式
2. 发消息触发高危操作（如 `rm something`）
3. 在审批面板点允许或拒绝
4. 切到统计页
5. Expected: 审批分布卡片显示非零数字

- [ ] **Step 5: Commit**

```bash
git add electron/orchestrator.js
git commit -m "fix: connect approval-counting pipeline to stats.approvals

Fixes #5: onDecision accumulated into _dirtyStats which was never read,
so approval stats always showed 0. Now updates e.stats.approvals directly
and persists to DB."
```

---

### Task 5: 移除调试代码 stats-diag.json

**Files:**
- Modify: `electron/orchestrator.js` — `stats:get` handler（~line 486-503）
- Modify: `electron/orchestrator.js` — import 行（~line 3）

**问题：** 每次 `stats:get` 调用都 `writeFileSync` 写 `stats-diag.json` 到 userData，阻塞主进程，是遗留调试代码。

- [ ] **Step 1: 删除 diag 相关代码**

修改 `electron/orchestrator.js` 的 `stats:get` handler，删除 diag 数组构建和文件写入：

```js
ipcMain.handle('stats:get', () => {
  const perSession = {}
  let total = { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
  for (const [id, e] of sessions) {
    const row = { adapterId: e.session.adapterId, model: e.session.model, cwd: e.session.cwd, status: e.status, ...e.stats }
    perSession[id] = row
    total.input += e.stats.tokens.input
    total.output += e.stats.tokens.output
    total.costUsd += e.stats.costUsd
    total.turns += e.stats.turns
    for (const k of Object.keys(total.approvals)) total.approvals[k] += e.stats.approvals[k] || 0
  }
  const result = { total, perSession, modelStats: getDb()?.getModelStats() || [] }
  return result
})
```

- [ ] **Step 2: 移除不再需要的 writeFileSync import**

修改 `electron/orchestrator.js` 第 3 行，如果 `writeFileSync` 不再被其他代码使用，从 import 中移除：

```js
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'fs'
```

> 注意：Task 4 在 stats:get 中加了 `db.upsertStats` 调用，不使用 writeFileSync。如果其他地方仍用 writeFileSync，保留 import。用 Grep 确认。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 4: 确认 diag 文件不再生成**

Run: `npm run dev`，切到统计页，然后检查：
```bash
ls "$env:APPDATA/ucli/stats-diag.json"
```
Expected: 文件不存在（或删除后不再重新生成）

- [ ] **Step 5: Commit**

```bash
git add electron/orchestrator.js
git commit -m "chore: remove debug stats-diag.json write from stats:get

Fixes #7: leftover debug code wrote a diagnostic JSON file on every
stats:get call, blocking the main process and leaking session data."
```

---

### Task 6: 过滤活动流中的 terminal 事件

**Files:**
- Modify: `src/stores/sessions.js` — `_onEvent` / `_appendActivity`（~line 136, 158）

**问题：** `_onEvent` 对每个事件调用 `_appendActivity`，orchestrator 把 `terminal` 事件同时发到 `session:event`。PTY 数据块几秒内填满 200 条上限，TaskSummary 搜索不到 message/tool_call，任务总结永远空白。

- [ ] **Step 1: 在 _appendActivity 中过滤 terminal 事件**

修改 `src/stores/sessions.js` 的 `_appendActivity` 方法，在开头加入过滤：

```js
_appendActivity(evt) {
  // Don't log raw terminal data — it floods the activity list and
  // pushes out structured events (message, tool_call) that TaskSummary needs.
  // Terminal output goes directly to xterm.js via session:terminal-output.
  if (evt.type === 'terminal' || evt.type === 'cli_raw') return
  const list = this.activities[evt.sessionId] || (this.activities[evt.sessionId] = [])
  list.push({ id: newActId(), ...evt })
  if (list.length > MAX_ACTIVITIES) list.splice(0, list.length - MAX_ACTIVITIES)
},
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: 手动验证 TaskSummary**

Run: `npm run dev`
1. 新建会话，发几条消息
2. 进入详情页
3. Expected: TaskSummary 面板显示任务总结（不再被 terminal 噪声淹没）

- [ ] **Step 4: Commit**

```bash
git add src/stores/sessions.js
git commit -m "fix: filter terminal events from activity log

Fixes #6: raw PTY data flooded the activities array (200-item cap),
pushing out structured events. TaskSummary couldn't find message/
tool_call types, so the summary panel was permanently empty."
```

---

### Task 7: 提取共享的 ~/.claude/sessions 扫描函数

**Files:**
- Modify: `electron/orchestrator.js` — `findClaudeSessionIndex`（~line 279）和 `session:scan-claude` handler（~line 357）

**问题：** `findClaudeSessionIndex` 和 `session:scan-claude` handler 各自实现了相同的 HOME 解析、路径规范化、*.json 遍历、JSON.parse、cwd 匹配逻辑（~50 行重复）。

- [ ] **Step 1: 提取共享辅助函数**

在 `electron/orchestrator.js` 中 `findClaudeSessionIndex` 之前加入共享函数：

```js
/** Shared: scan ~/.claude/sessions/*.json for sessions matching cwd.
 *  Returns array of { sessionId, name, startedAt, cwd }. */
function listClaudeSessionsByCwd(cwd) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const sessionsDir = join(home, '.claude', 'sessions')
    if (!existsSync(sessionsDir)) return []
    const normCwd = (cwd || '').replace(/\\/g, '/').toLowerCase()
    const found = []
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
        const rawCwd = (raw.cwd || '').replace(/\\/g, '/').toLowerCase()
        if (rawCwd === normCwd) {
          found.push({ sessionId: raw.sessionId, name: raw.name, startedAt: raw.startedAt })
        }
      } catch { /* skip corrupted files */ }
    }
    return found
  } catch { return [] }
}
```

- [ ] **Step 2: 重写 findClaudeSessionIndex 使用共享函数**

```js
function findClaudeSessionIndex(cwd, nearTs) {
  const found = listClaudeSessionsByCwd(cwd)
  if (!found.length) return null
  if (!nearTs) return found[0]
  let best = null, bestDist = Infinity
  for (const s of found) {
    const dist = Math.abs((s.startedAt || 0) - nearTs)
    if (dist < bestDist) { bestDist = dist; best = s }
  }
  return best
}
```

- [ ] **Step 3: 重写 session:scan-claude handler 使用共享函数**

```js
ipcMain.handle('session:scan-claude', (_e, cwd) => {
  const found = listClaudeSessionsByCwd(cwd)
  // Exclude already-imported sessions
  const imported = new Set()
  for (const e of sessions.values()) {
    if (e.session.cliSessionId) imported.add(e.session.cliSessionId)
  }
  return found
    .filter(s => !imported.has(s.sessionId))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 30)
})
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 5: 手动验证历史导入列表**

Run: `npm run dev`
1. 新建会话，选一个有历史的目录
2. Expected: 导入下拉列表显示历史会话

- [ ] **Step 6: Commit**

```bash
git add electron/orchestrator.js
git commit -m "refactor: extract shared listClaudeSessionsByCwd helper

Fixes #8: findClaudeSessionIndex and session:scan-claude duplicated
~50 lines of HOME/path/JSON/cwd-matching logic. Now both call a
single shared function."
```

---

### Task 8: 提取 claudeAdapter 的 transcript 路径辅助函数

**Files:**
- Modify: `electron/adapters/claudeAdapter.js` — `_findTranscript`（~line 56）和 `_findLatestTranscript`（~line 70）

**问题：** `_findTranscript` 和 `_findLatestTranscript` 包含逐字节相同的 cwd→hash 表达式和相同的 home/projects/existsSync/循环 前置逻辑。

- [ ] **Step 1: 提取 _projectDir 共享方法**

在 `electron/adapters/claudeAdapter.js` 的 `_findTranscript` 之前加入：

```js
/** Shared: return the matched ~/.claude/projects/<hash> directory, or null. */
_projectDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const projDir = join(home, '.claude', 'projects')
  if (!existsSync(projDir)) return null
  const hash = (this.session.cwd || '').toLowerCase().replace(/:/g, '-').replace(/\\/g, '-').replace(/\s/g, '-').replace(/\/+/g, '-')
  for (const dir of readdirSync(projDir)) {
    if (dir.toLowerCase() === hash) return join(projDir, dir)
  }
  return null
}
```

- [ ] **Step 2: 重写 _findTranscript 使用 _projectDir**

```js
_findTranscript(cliSessionId) {
  const dir = this._projectDir()
  if (!dir) return null
  const exact = join(dir, cliSessionId + '.jsonl')
  return existsSync(exact) ? exact : null
}
```

- [ ] **Step 3: 重写 _findLatestTranscript 使用 _projectDir**

```js
_findLatestTranscript() {
  const dir = this._projectDir()
  if (!dir) return null
  let newest = null, newestMtime = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    try {
      const full = join(dir, f)
      const stat = statSync(full)
      if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = full }
    } catch {}
  }
  return newest
}
```

- [ ] **Step 4: 确保 statSync 已 import**

检查 `electron/adapters/claudeAdapter.js` 第 2 行的 import，确保包含 `statSync`：

```js
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
```

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 6: 手动验证历史回放和统计**

Run: `npm run dev`
1. 新建会话，选有历史的目录
2. Expected: 终端显示历史记录 + 统计页有 token 数据

- [ ] **Step 7: Commit**

```bash
git add electron/adapters/claudeAdapter.js
git commit -m "refactor: extract _projectDir helper in claudeAdapter

Fixes #8 (adapter side): _findTranscript and _findLatestTranscript
duplicated the cwd->hash + project-dir lookup. Now both share
_projectDir(), diverging only on what they do with the result."
```

---

## Self-Review

**Spec coverage:** 8 个审查发现 → 8 个 task，全覆盖。

**Placeholder scan:** 无 TBD/TODO，每个 step 有具体代码或命令。

**Type consistency:** `_projectDir()` 在 Task 8 定义后被 `_findTranscript` 和 `_findLatestTranscript` 使用；`listClaudeSessionsByCwd` 在 Task 7 定义后被 `findClaudeSessionIndex` 和 `scan-claude` 使用；`startAdapter` 在 Task 2 的 preload/ipc/store 三处签名一致。

**依赖顺序：** Task 1-2 修复 resume 和历史回放（核心功能），Task 3 修复权限绕过，Task 4-5 修复统计和清理调试代码，Task 6 修复活动流，Task 7-8 是重构（最后做，不影响功能）。Task 4 和 Task 5 都改 stats:get handler，Task 5 在 Task 4 之后执行避免冲突。
