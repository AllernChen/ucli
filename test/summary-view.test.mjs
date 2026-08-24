import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { openSummaryReportLink } from '../src/summaryLinks.js'

let progressHandler = null
let subscriptions = 0
let unsubscriptions = 0
let listCalls = 0
let getCalls = 0
let generatedPayloads = []
const progressListeners = new Set()

globalThis.window = {
  ucli: {
    getSummarySettings: async () => ({ autoEnabled: false, defaultExecutorId: 'codex' }),
    listSummaryReports: async () => { listCalls += 1; return [] },
    getSummaryReport: async reportId => {
      getCalls += 1
      return { id: reportId, status: 'completed', markdown: '# 摘要', version: 1 }
    },
    startInteractiveSummary: async payload => {
      generatedPayloads.push(payload)
      return { report: { id: 'report-1', status: 'queued', version: 1 }, sessionId: 'session-1' }
    },
    cancelSummary: async () => true,
    setCurrentSummary: async reportId => ({ id: reportId, status: 'completed', isCurrent: true }),
    deleteSummaryReport: async reportId => ({ deletedReportId: reportId, currentReportId: null }),
    exportSummaryMarkdown: async () => ({ canceled: false }),
    exportSummaryHtml: async () => ({ canceled: false }),
    onSummaryProgress: handler => {
      subscriptions += 1
      progressHandler = handler
      progressListeners.add(handler)
      return () => { unsubscriptions += 1; progressListeners.delete(handler); if (progressHandler === handler) progressHandler = null }
    },
    log: () => {}
  }
}

const { useSummariesStore } = await import('../src/stores/summaries.js')

function freshStore() {
  setActivePinia(createPinia())
  return useSummariesStore()
}

function emitProgress(payload) {
  for (const listener of progressListeners) listener(payload)
}

test('summary store subscribes once and completion refreshes only the affected report', async () => {
  subscriptions = 0
  unsubscriptions = 0
  listCalls = 0
  getCalls = 0
  const store = freshStore()

  await Promise.all([store.init(), store.init()])
  assert.equal(subscriptions, 1)
  assert.equal(listCalls, 1)

  progressHandler({ reportId: 'report-1', phase: 'completed', completed: 1, total: 1, text: '总结已生成' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(getCalls, 1)
  assert.equal(listCalls, 1)
  assert.equal(store.progress['report-1'].phase, 'completed')

  store.dispose()
  assert.equal(unsubscriptions, 1)
})

test('terminal progress refreshes the matching report in version history', async () => {
  const store = freshStore()
  await store.init()
  store.reports = [{ id: 'report-1', status: 'running', version: 2 }]
  store.versions = [{ id: 'report-1', status: 'running', version: 2 }]
  progressHandler({ reportId: 'report-1', status: 'completed', phase: 'completed', completed: 1, total: 1, text: '总结已生成' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.versions[0].status, 'completed')
  assert.equal(store.versions[0].markdown, undefined)
  store.dispose()
})

test('interactive generation creates and selects the canonical queued report', async () => {
  generatedPayloads = []
  const store = freshStore()
  await store.init()
  const request = { periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai', partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet' }
  const report = await store.generateInteractive(request)
  assert.deepEqual(generatedPayloads, [request])
  assert.equal(report.sessionId, 'session-1')
  assert.equal(store.selectedReportId, 'report-1')
  store.dispose()
})

test('init preserves the list failure for callers while keeping a safe error message', async () => {
  const originalList = window.ucli.listSummaryReports
  const store = freshStore()
  try {
    window.ucli.listSummaryReports = async () => { throw new Error('database unavailable') }
    await assert.rejects(store.init(), /database unavailable/)
    assert.equal(store.error.message, '无法读取总结报告')
  } finally {
    window.ucli.listSummaryReports = originalList
    store.dispose()
  }
})

test('each Pinia store owns its progress listener and disposing one leaves the other live', async () => {
  const piniaA = createPinia()
  const piniaB = createPinia()
  setActivePinia(piniaA)
  const storeA = useSummariesStore()
  setActivePinia(piniaB)
  const storeB = useSummariesStore()
  await Promise.all([storeA.init(), storeB.init()])
  storeA.dispose()
  emitProgress({ reportId: 'still-live', status: 'running', phase: 'running', completed: 0, total: 1, text: '仍在生成' })
  assert.equal(storeA.progress['still-live'], undefined)
  assert.equal(storeB.progress['still-live'].text, '仍在生成')
  storeB.dispose()
})

test('terminal progress cannot be regressed by a late nonterminal progress event', () => {
  const store = freshStore()
  store.reports = [{ id: 'r1', status: 'running', version: 1 }]
  store.applyProgress({ reportId: 'r1', status: 'completed', phase: 'completed', completed: 1, total: 1, text: '完成' })
  store.applyProgress({ reportId: 'r1', status: 'running', phase: 'running', completed: 0, total: 1, text: '迟到的运行中' })
  assert.equal(store.progress.r1.phase, 'completed')
  assert.equal(store.reports[0].status, 'completed')
  store.dispose()
})

test('a slower earlier selection cannot replace the latest selected report or its versions', async () => {
  const originalGet = window.ucli.getSummaryReport
  const originalList = window.ucli.listSummaryReports
  let resolveA
  const reportA = new Promise(resolve => { resolveA = resolve })
  const store = freshStore()
  try {
    window.ucli.getSummaryReport = id => id === 'a' ? reportA : Promise.resolve({ id: 'b', periodType: 'week', periodStart: 3, periodEndExclusive: 4, timezone: 'Asia/Shanghai', version: 2 })
    window.ucli.listSummaryReports = async filters => [{ id: filters.periodStart === 3 ? 'b' : 'a', version: filters.periodStart === 3 ? 2 : 1 }]
    const selectingA = store.selectReport('a')
    await store.selectReport('b')
    resolveA({ id: 'a', periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai', version: 1 })
    await selectingA
    assert.equal(store.selectedReportId, 'b')
    assert.deepEqual(store.versions.map(report => report.id), ['b'])
  } finally {
    window.ucli.getSummaryReport = originalGet
    window.ucli.listSummaryReports = originalList
    store.dispose()
  }
})

test('new interactive reports are immediately included in the selected period history', async () => {
  const originalStart = window.ucli.startInteractiveSummary
  const originalList = window.ucli.listSummaryReports
  const store = freshStore()
  try {
    const report = { id: 'r3', version: 3, periodType: 'week', periodStart: 1, periodEndExclusive: 2, timezone: 'Asia/Shanghai', status: 'queued' }
    window.ucli.startInteractiveSummary = async () => ({ report, sessionId: 'session-3' })
    window.ucli.listSummaryReports = async () => [report, { id: 'r2', version: 2 }]
    await store.generateInteractive({ periodType: 'week', start: 1, endExclusive: 2, timezone: 'Asia/Shanghai', partial: false, executorId: 'claude', profileId: null, model: null })
    assert.equal(store.selectedReportId, 'r3')
    assert.deepEqual(store.versions.map(item => item.id), ['r3', 'r2'])
  } finally {
    window.ucli.startInteractiveSummary = originalStart
    window.ucli.listSummaryReports = originalList
    store.dispose()
  }
})

test('deleting the selected report clears stale state and selects the promoted version', async () => {
  const originalDelete = window.ucli.deleteSummaryReport
  const originalList = window.ucli.listSummaryReports
  const originalGet = window.ucli.getSummaryReport
  const store = freshStore()
  try {
    store.initialized = true
    store.reports = [
      { id: 'report-v2', status: 'completed', version: 2, markdown: '# v2' },
      { id: 'report-v1', status: 'completed', version: 1 }
    ]
    store.selectedReportId = 'report-v2'
    store.versions = [...store.reports]
    store.progress = { 'report-v2': { phase: 'completed' } }

    window.ucli.deleteSummaryReport = async reportId => ({
      deletedReportId: reportId, currentReportId: 'report-v1'
    })
    window.ucli.listSummaryReports = async filters => filters?.periodType
      ? [{ id: 'report-v1', status: 'completed', version: 1, isCurrent: true }]
      : [{ id: 'report-v1', status: 'completed', version: 1, isCurrent: true }]
    window.ucli.getSummaryReport = async reportId => ({
      id: reportId, periodType: 'week', periodStart: 100, periodEndExclusive: 200,
      timezone: 'Asia/Shanghai', status: 'completed', version: 1, isCurrent: true,
      markdown: '# v1'
    })

    assert.deepEqual(await store.deleteReport('report-v2'), {
      deletedReportId: 'report-v2', currentReportId: 'report-v1'
    })
    assert.equal(store.selectedReport.id, 'report-v1')
    assert.equal(store.progress['report-v2'], undefined)
    assert.deepEqual(store.reports.map(report => report.id), ['report-v1'])
  } finally {
    window.ucli.deleteSummaryReport = originalDelete
    window.ucli.listSummaryReports = originalList
    window.ucli.getSummaryReport = originalGet
    store.dispose()
  }
})

test('a stale terminal refresh cannot resurrect a report after deletion', async () => {
  const originalDelete = window.ucli.deleteSummaryReport
  const originalList = window.ucli.listSummaryReports
  const originalGet = window.ucli.getSummaryReport
  let releaseStale
  let getCallsForDeleted = 0
  const stale = new Promise(resolve => { releaseStale = resolve })
  const store = freshStore()
  try {
    await store.init()
    store.reports = [{ id: 'deleted-report', status: 'completed', version: 1 }]
    store.selectedReportId = 'deleted-report'
    window.ucli.getSummaryReport = async reportId => {
      if (reportId === 'deleted-report' && getCallsForDeleted++ === 0) return stale
      return { id: reportId, status: 'completed', version: 1, markdown: '# next' }
    }
    window.ucli.deleteSummaryReport = async reportId => ({
      deletedReportId: reportId, currentReportId: null
    })
    window.ucli.listSummaryReports = async () => []

    progressHandler({
      reportId: 'deleted-report', phase: 'completed', completed: 1, total: 1, text: '完成'
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await store.deleteReport('deleted-report')
    releaseStale({ id: 'deleted-report', status: 'completed', version: 1, markdown: '# stale' })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.deepEqual(store.reports, [])
    assert.equal(store.selectedReport, null)
    assert.equal(store.error, null)
  } finally {
    window.ucli.deleteSummaryReport = originalDelete
    window.ucli.listSummaryReports = originalList
    window.ucli.getSummaryReport = originalGet
    store.dispose()
  }
})

test('a terminal event arriving after deletion does not surface a not-found error', async () => {
  const originalDelete = window.ucli.deleteSummaryReport
  const originalList = window.ucli.listSummaryReports
  const originalGet = window.ucli.getSummaryReport
  const store = freshStore()
  try {
    await store.init()
    store.reports = [{ id: 'late-report', status: 'completed', version: 1 }]
    store.selectedReportId = 'late-report'
    window.ucli.deleteSummaryReport = async reportId => ({
      deletedReportId: reportId, currentReportId: null
    })
    window.ucli.listSummaryReports = async () => []
    window.ucli.getSummaryReport = async () => {
      throw Object.assign(new Error('not found'), { code: 'SUMMARY_REPORT_NOT_FOUND' })
    }

    await store.deleteReport('late-report')
    progressHandler({
      reportId: 'late-report', phase: 'completed', completed: 1, total: 1, text: '完成'
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(store.error, null)
    assert.deepEqual(store.reports, [])
  } finally {
    window.ucli.deleteSummaryReport = originalDelete
    window.ucli.listSummaryReports = originalList
    window.ucli.getSummaryReport = originalGet
    store.dispose()
  }
})

test('an externally deleted terminal report is removed without surfacing a refresh error', async () => {
  const originalGet = window.ucli.getSummaryReport
  const store = freshStore()
  try {
    store.reports = [{ id: 'externally-deleted', status: 'running', version: 1 }]
    store.versions = [{ id: 'externally-deleted', status: 'running', version: 1 }]
    store.selectedReportId = 'externally-deleted'
    window.ucli.getSummaryReport = async () => { throw Object.assign(new Error('not found'), { code: 'SUMMARY_REPORT_NOT_FOUND' }) }
    store.applyProgress({ reportId: 'externally-deleted', status: 'completed', phase: 'completed', completed: 1, total: 1, text: '完成' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(store.reports, [])
    assert.deepEqual(store.versions, [])
    assert.equal(store.error, null)
  } finally {
    window.ucli.getSummaryReport = originalGet
    store.dispose()
  }
})

test('summary workspace components cover generation, safe reading, history, retry, and export', () => {
  const files = [
    '../src/components/SessionTerminal.vue',
    '../src/components/summaries/SummaryGenerateDialog.vue',
    '../src/components/summaries/SummaryReportView.vue',
    '../src/components/summaries/SummaryHistory.vue',
    '../src/components/summaries/WorkSummaryPanel.vue',
    '../src/components/summaries/SummaryHtmlStyleDialog.vue',
    '../src/components/summaries/SummaryConversationDrawer.vue',
    // The conversation drawer reuses the existing history pane for its
    // 「历史记录」tab; its getSessionHistory contract is covered here.
    '../src/components/PaneHistory.vue'
  ]
  const sources = files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(parseSfc(source).errors, [], files[index])
  }
  const all = sources.join('\n')
  for (const text of [
    'periodType', 'partial', 'executorId', 'profileId', 'model',
    '可能产生费用', '设为当前版本', '取消生成',
    '复制 Markdown', '导出 Markdown', '导出 HTML', '删除总结', '确认删除', '重试（新版本）',
    'SummaryConversationDrawer', 'attachTerminal', 'refit', 'getSessionHistory',
    '此报告没有关联的交互会话', 'SessionTerminal'
  ]) assert.match(all, new RegExp(text))
  for (const themeId of ['executive', 'engineering', 'timeline', 'dashboard', 'print']) {
    assert.match(all, new RegExp(themeId))
  }
  assert.match(all, /SUMMARY_THEMES/)
  assert.match(all, /mode:\s*['"]theme['"]/)
  assert.match(all, /mode:\s*['"]ai-custom['"]/)
  for (const text of ['AI 自定义', '较慢', '产生 AI 用量', '即时生成']) {
    assert.match(all, new RegExp(text))
  }
  assert.match(all, /themeId:\s*['"]executive['"]/)
  assert.match(all, /@confirm="\$emit\('delete-report', report\.id\)"/)
  assert.match(all, /MarkdownIt\(\{\s*html:\s*false/)
  assert.match(all, /DOMPurify\.sanitize/)
  assert.match(all, /failed|interrupted/)
  // The generate dialog hands the session off instead of navigating away.
  assert.doesNotMatch(all, /pendingAssign|router\.push/)
  // The embedded terminal forwards input and output over the session IPC surface.
  assert.match(all, /ipc\.sendTerminalInput\s*\(props\.sessionId,\s*data\)/)
  assert.match(all, /evt\.sessionId\s*===\s*props\.sessionId/)
  assert.match(all, /ipc\.terminalResize\s*\(props\.sessionId/)
  assert.doesNotMatch(readFileSync(new URL('../src/components/summaries/WorkSummaryPanel.vue', import.meta.url), 'utf8'), /prepareSummary|summaryTasks\.addTask|reportProducedByRun|setInterval/)
})

/* Removed legacy conversion/task-projection coverage. The canonical report-store
 * behavior is covered above and by the mounted panel tests. */
/*
  assert.equal(convertTargetFileName('2026-08-21-summary.md'), '2026-08-21-summary.html')
  assert.equal(convertTargetFileName('2026-08-21-summary.html'), '2026-08-21-summary.md')
  assert.equal(convertTargetFileName('data.json'), null)
  assert.equal(dirnameOf('C:\\UCLI\\summary\\workLogs\\x.md'), 'C:\\UCLI\\summary\\workLogs')
  const prompt = buildConversionPrompt('x.md', 'x.html')
  assert.match(prompt, /x\.html/)
  assert.match(prompt, /不可信数据/)
})

test.skip('summary taskNote serializes shared-session generation records and stays legacy-compatible', () => {
  // 旧格式：单文件名字符串 → 一张卡（t=0）；空 / 非法 → 无记录。
  assert.deepEqual(parseTaskNote('2026-08-14-summary.md'), [
    { t: 0, f: '2026-08-14-summary.md' }
  ])
  assert.deepEqual(parseTaskNote(null), [])
  assert.deepEqual(parseTaskNote(''), [])
  assert.deepEqual(parseTaskNote('[not json'), [])
  // 新格式：JSON 数组；非法元素被过滤，缺省字段补空。
  assert.deepEqual(parseTaskNote('[{"t":1000,"f":"a.md","pt":"week","a":"claude"}]'), [
    { t: 1000, f: 'a.md', pt: 'week', a: 'claude' }
  ])
  assert.deepEqual(parseTaskNote('[{"t":1,"f":"ok.md"},{"x":1}]'), [
    { t: 1, f: 'ok.md', pt: null, a: null }
  ])

  // append 追加并保留历史。
  let note = appendGeneration(null, { t: 100, f: 'a.md', pt: 'week', a: 'codex' })
  note = appendGeneration(note, { t: 200, f: 'b.md' })
  assert.deepEqual(parseTaskNote(note).map(g => g.t), [100, 200])

  // drop 摘除后保留其余；全部移除 → ''（清空 taskNote）。
  note = dropGeneration(note, 's:100')
  assert.deepEqual(parseTaskNote(note).map(g => g.t), [200])
  note = dropGeneration(note, 's:200')
  assert.equal(note, '')

  // serializeTaskNote 透传序列化（规范化由 append/parse 负责）。
  assert.equal(serializeTaskNote([{ t: 7, f: 'x.md', pt: 'week', a: 'codex' }]),
    '[{"t":7,"f":"x.md","pt":"week","a":"codex"}]')

  // 卡片命名：工作总结（周期）生成时间。
  assert.equal(
    buildCardName('每周', new Date(2026, 7, 21, 15, 30).getTime()),
    '工作总结（每周）2026-08-21 15:30'
  )
  assert.equal(buildCardName('每周', 0), '工作总结（每周）')
  assert.equal(buildCardName('每周', null), '工作总结（每周）')

  // 完成判定只认「本次运行实际写出的」文件：同周期重新生成时磁盘上的同名旧报告
  // mtime 早于本次生成时间，不得据此误判完成；CLI 真正覆盖后才算。
  const gen = { suggestedFileName: '2026-W33-summary.md', createdAt: 1787296202855 }
  assert.equal(
    reportProducedByRun(
      [{ name: '2026-W33-summary.md', mtime: 1787242791000 }], // 旧文件：00:19 < 15:10
      gen),
    false)
  assert.equal(
    reportProducedByRun(
      [{ name: '2026-W33-summary.md', mtime: 1787296800000 }], // 覆盖后：晚于生成时间
      gen),
    true)
  // HTML 孪生文件同样按 mtime 判定。
  assert.equal(
    reportProducedByRun(
      [{ name: '2026-W33-summary.html', mtime: 1787296800000 }],
      gen),
    true)
  // 文件不存在 / 缺建议文件名 → false。
  assert.equal(reportProducedByRun([{ name: 'other.md', mtime: 9999999999999 }], gen), false)
  assert.equal(reportProducedByRun([{ name: 'x.md', mtime: 9999999999999 }], { createdAt: 1 }), false)
})

test.skip('summaryTasks store reconstructs tasks from persisted sessions and drives the state machine', async () => {
  const originalListSessions = window.ucli.listSessions
  const originalListWorkLogs = window.ucli.listSummaryWorkLogs
  const originalOn = window.ucli.on
  let eventHandler = null
  let subscribeCount = 0
  window.ucli.on = (channel, handler) => {
    if (channel === 'session:event') {
      eventHandler = handler
      subscribeCount += 1
    }
    return () => { if (eventHandler === handler) eventHandler = null }
  }
  // 一次生成 = 一张卡（genId = sessionId:生成时间戳），生成记录持久化在 taskNote
  // JSON 数组；旧格式单文件名字符串仍按一张卡解析（t=0 → 回落 session.createdAt）。
  window.ucli.listSessions = async () => [
    { id: 's-completed', name: '工作总结（每周）', adapterId: 'claude', cwd: 'C:/work',
      taskNote: '2026-08-14-summary.md', status: 'exited', createdAt: 2000, updatedAt: 2100,
      lastActivity: '进程退出 (0)' },
    { id: 's-running', name: '工作总结（每月）', adapterId: 'codex', cwd: 'C:/work',
      taskNote: JSON.stringify([{ t: 1000, f: '2026-08-21-summary.md', pt: 'month', a: 'codex' }]),
      status: 'running', createdAt: 1000, updatedAt: 1100, lastActivity: '运行中' },
    { id: 's-interrupted', name: '工作总结（每日）', adapterId: 'opencode', cwd: 'C:/work',
      taskNote: '2026-08-21-summary.md', status: 'exited', createdAt: 500, updatedAt: 600,
      lastActivity: '进程退出 (1)' },
    // 非总结会话必须被排除。
    { id: 's-normal', name: '修复登录 bug', adapterId: 'claude', cwd: 'C:/app',
      taskNote: null, status: 'exited', createdAt: 300, updatedAt: 400, lastActivity: '' }
  ]
  window.ucli.listSummaryWorkLogs = async () => [
    { name: '2026-08-14-summary.md', path: 'C:/work/2026-08-14-summary.md', kind: 'markdown', mtime: 2100 },
    { name: '2026-08-14-summary.html', path: 'C:/work/2026-08-14-summary.html', kind: 'html', mtime: 2100 }
  ]
  setActivePinia(createPinia())
  const store = useSummaryTasksStore()
  try {
    await store.init()
    assert.deepEqual(store.tasks.map(task => task.sessionId),
      ['s-completed', 's-running', 's-interrupted'])
    assert.equal(store.selectedTaskId, 's-completed:0')
    const completed = store.tasks.find(task => task.genId === 's-completed:0')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.periodLabel, '每周')
    assert.equal(completed.suggestedFileName, '2026-08-14-summary.md')
    assert.match(completed.displayName, /^工作总结（每周）/)
    assert.equal(store.tasks.find(task => task.genId === 's-running:1000').status, 'running')
    assert.equal(store.tasks.find(task => task.genId === 's-interrupted:0').status, 'interrupted')

    // addTask → starting；setStatus → running；setError → failed（按 genId 键控）。
    store.addTask({ genId: 's-new:9000', sessionId: 's-new', adapterId: 'codex', periodLabel: '每日',
      periodType: 'day', suggestedFileName: '2026-08-21-summary.md', workLogsDir: 'C:/work', createdAt: 9000 })
    assert.equal(store.tasks[0].sessionId, 's-new')
    assert.equal(store.tasks[0].genId, 's-new:9000')
    assert.equal(store.tasks[0].status, 'starting')
    store.setStatus('s-new:9000', 'running')
    assert.equal(store.tasks[0].status, 'running')
    store.setError('s-new:9000', new Error('CLI 启动失败'))
    assert.equal(store.tasks[0].status, 'failed')
    assert.equal(store.tasks[0].lastActivity, 'CLI 启动失败')

    // session:event 事件路由到该会话的活动卡；无活动卡时回落到候选第一张。
    store._onEvent({ sessionId: 's-new', type: 'ready', ts: 3000 })
    assert.equal(store.tasks[0].lastActivity, '已就绪')
    store._onEvent({ sessionId: 's-new', type: 'stats_update', ts: 3001,
      usage: { inputTokens: 10, outputTokens: 20 }, costUsd: 0.5 })
    assert.deepEqual(store.tasks[0].tokens, { input: 10, output: 20 })
    assert.equal(store.tasks[0].costUsd, 0.5)

    // removeTask 重选下一任务；addTask 对已存在 genId 就地更新（不产生重复卡）。
    store.selectTask('s-new:9000')
    await store.removeTask('s-new:9000')
    assert.equal(store.selectedTaskId, 's-completed:0')
    store.addTask({ genId: 's-completed:0', sessionId: 's-completed', adapterId: 'claude', periodLabel: '每周',
      periodType: 'week', suggestedFileName: '2026-08-14-summary.md', workLogsDir: 'C:/work' })
    assert.equal(store.tasks.filter(task => task.sessionId === 's-completed').length, 1)
    assert.equal(store.tasks.find(task => task.sessionId === 's-completed').status, 'starting')

    // 第二次 init 被 unsub 守卫跳过（不重复订阅），事件仍派发到同一 handler。
    assert.equal(subscribeCount, 1)
    await store.init()
    assert.equal(subscribeCount, 1)
    assert.equal(store.tasks.filter(task => task.sessionId === 's-completed').length, 1)
    eventHandler({ sessionId: 's-running', type: 'exit', code: 0, ts: 4000 })
    assert.equal(store.tasks.find(task => task.genId === 's-running:1000').lastActivity, '进程退出 (0)')
  } finally {
    store.dispose()
    window.ucli.listSessions = originalListSessions
    window.ucli.listSummaryWorkLogs = originalListWorkLogs
    window.ucli.on = originalOn
  }
})

test.skip('repeated mount cycles (tab switches) do not duplicate reconstructed tasks', async () => {
  const originalListSessions = window.ucli.listSessions
  const originalListWorkLogs = window.ucli.listSummaryWorkLogs
  const originalOn = window.ucli.on
  window.ucli.on = () => () => {}
  // 共享会话模型：一个会话（taskNote = 生成记录 JSON 数组）还原出多张卡。
  window.ucli.listSessions = async () => [
    { id: 'a', name: '工作总结（每周）', adapterId: 'claude', cwd: 'C:/work',
      taskNote: JSON.stringify([
        { t: 1000, f: '2026-W33-summary.md', pt: 'week', a: 'claude' },
        { t: 2000, f: '2026-W33-2-summary.md', pt: 'week', a: 'claude' }
      ]), status: 'exited', createdAt: 1000, updatedAt: 1100, lastActivity: '' }
  ]
  window.ucli.listSummaryWorkLogs = async () => []
  setActivePinia(createPinia())
  const store = useSummaryTasksStore()
  try {
    await store.init()
    assert.equal(store.tasks.length, 2)
    assert.equal(store.tasks.filter(task => task.sessionId === 'a').length, 2)
    store.selectTask('a:2000')
    // 面板在 tab 切换时卸载/重挂：dispose 重置订阅后 init 会重建。
    // init 必须先清空旧列表，否则每切换一次任务卡就翻倍。
    store.dispose()
    await store.init()
    assert.equal(store.tasks.length, 2)
    assert.equal(store.selectedTaskId, 'a:2000')
    store.dispose()
    await store.init()
    assert.equal(store.tasks.length, 2)
  } finally {
    store.dispose()
    window.ucli.listSessions = originalListSessions
    window.ucli.listSummaryWorkLogs = originalListWorkLogs
    window.ucli.on = originalOn
  }
})
*/

test('completed reports show bounded generation performance without renderer-sensitive fields', () => {
  const reportView = readFileSync(
    new URL('../src/components/summaries/SummaryReportView.vue', import.meta.url),
    'utf8'
  )
  for (const text of ['生成性能', 'AI 调用', '缓存命中', '耗时', '并发']) {
    assert.match(reportView, new RegExp(text))
  }
  assert.match(reportView, /report\?\.status\s*===\s*['"]completed['"]/)
  assert.match(reportView, /generationMetrics/)
  assert.match(reportView, /direct|map-reduce/)
  assert.doesNotMatch(reportView, /cacheKey|providerOutput|rawPrompt|workspaceDirectory/)
})

test('summary store preserves cache-check progress until the existing terminal refresh', async () => {
  getCalls = 0
  const store = freshStore()
  await store.init()
  progressHandler({
    reportId: 'report-cache', status: 'running', phase: 'cache-check', completed: 0, total: 1,
    text: '正在检查缓存'
  })
  assert.deepEqual(store.progress['report-cache'], {
    reportId: 'report-cache', status: 'running', phase: 'cache-check', completed: 0, total: 1,
    text: '正在检查缓存'
  })
  assert.equal(getCalls, 0)
  store.dispose()
})

test('AI-authored report links cannot navigate the renderer and use only narrow external IPC', () => {
  const opened = []
  let prevented = 0
  const anchor = { getAttribute: () => 'https://attacker.example/from-ai-markdown' }
  const handled = openSummaryReportLink({
    target: { closest: selector => selector === 'a[href]' ? anchor : null },
    preventDefault() { prevented += 1 }
  }, url => { opened.push(url) })

  assert.equal(handled, true)
  assert.equal(prevented, 1)
  assert.deepEqual(opened, ['https://attacker.example/from-ai-markdown'])

  const reportView = readFileSync(
    new URL('../src/components/summaries/SummaryReportView.vue', import.meta.url),
    'utf8'
  )
  const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  for (const source of [reportView]) {
    assert.match(source, /@click="handleReportLink"/)
    assert.match(source, /openSummaryReportLink\(event, ipc\.openExternal\)/)
  }
  assert.match(preload, /openExternal:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\('shell:open-external', url\)/)
  assert.match(preload, /showItemInFolder/)
  assert.doesNotMatch(preload, /(?:navigate|loadURL)\s*:/)
})

test('Stats replaces the summary placeholder without regressing the cumulative usage tab', () => {
  const source = readFileSync(new URL('../src/views/Stats.vue', import.meta.url), 'utf8')
  assert.deepEqual(parseSfc(source).errors, [])
  assert.match(source, /UsageTrendsPanel/)
  assert.match(source, /WorkSummaryPanel/)
  assert.match(source, /key="usage"/)
  assert.match(source, /key="summary"/)
  assert.doesNotMatch(source, /工作总结将在后续任务中启用/)
})
