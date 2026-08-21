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

globalThis.window = {
  ucli: {
    getSummarySettings: async () => ({ autoEnabled: false, defaultExecutorId: 'codex' }),
    listSummaryReports: async () => { listCalls += 1; return [] },
    getSummaryReport: async reportId => {
      getCalls += 1
      return { id: reportId, status: 'completed', markdown: '# 摘要', version: 1 }
    },
    generateSummary: async payload => { generatedPayloads.push(payload); return { reportId: 'report-1' } },
    confirmSummary: async (reportId, confirmationCallLimit) => {
      generatedPayloads.push({ reportId, confirm: true, confirmationCallLimit })
      return { reportId }
    },
    cancelSummary: async () => true,
    setCurrentSummary: async reportId => ({ id: reportId, status: 'completed', isCurrent: true }),
    deleteSummaryReport: async reportId => ({ deletedReportId: reportId, currentReportId: null }),
    exportSummaryMarkdown: async () => ({ canceled: false }),
    exportSummaryHtml: async () => ({ canceled: false }),
    onSummaryProgress: handler => {
      subscriptions += 1
      progressHandler = handler
      return () => { unsubscriptions += 1; progressHandler = null }
    },
    // summaryTasks store surface
    listSessions: async () => [],
    listSummaryWorkLogs: async () => [],
    updateSessionNote: async () => true,
    on: () => () => {},
    log: () => {}
  }
}

const { useSummariesStore } = await import('../src/stores/summaries.js')
const { useSummaryTasksStore } = await import('../src/stores/summaryTasks.js')

function freshStore() {
  setActivePinia(createPinia())
  return useSummariesStore()
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

test('awaiting confirmation retains the actual call estimate and resumes the same report', async () => {
  generatedPayloads = []
  const store = freshStore()
  await store.init()
  store.activeJobs = { 'report-1': true }

  progressHandler({
    reportId: 'report-1', phase: 'awaiting_confirmation', completed: 0,
    total: 5, text: '预计调用 5 次，等待确认'
  })
  assert.equal(store.progress['report-1'].total, 5)
  await store.confirm('report-1')

  assert.deepEqual(generatedPayloads, [{
    reportId: 'report-1', confirm: true, confirmationCallLimit: 5
  }])
  assert.equal(store.activeJobs['report-1'], true)
  store.dispose()
})

test('deleting the selected report clears stale state and selects the promoted version', async () => {
  const originalDelete = window.ucli.deleteSummaryReport
  const originalList = window.ucli.listSummaryReports
  const originalGet = window.ucli.getSummaryReport
  const store = freshStore()
  try {
    store.initialized = true
    store.reports = [
      { id: 'report-v2', status: 'completed', version: 2 },
      { id: 'report-v1', status: 'completed', version: 1 }
    ]
    store.selectedReport = { id: 'report-v2', status: 'completed', version: 2, markdown: '# v2' }
    store.versions = [...store.reports]
    store.activeJobs = { 'report-v2': true }
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
    assert.equal(store.activeJobs['report-v2'], undefined)
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
    store.selectedReport = { id: 'deleted-report', status: 'completed', version: 1, markdown: '# old' }
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
    store.selectedReport = { id: 'late-report', status: 'completed', version: 1, markdown: '# old' }
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

test('summary workspace components cover generation, safe reading, history, retry, and export', () => {
  const files = [
    '../src/components/SessionTerminal.vue',
    '../src/components/summaries/SummaryGenerateDialog.vue',
    '../src/components/summaries/SummaryReportView.vue',
    '../src/components/summaries/SummaryHistory.vue',
    '../src/components/summaries/WorkSummaryPanel.vue',
    '../src/components/summaries/SummaryHtmlStyleDialog.vue',
    '../src/components/summaries/WorkLogReportView.vue',
    '../src/components/summaries/SummaryTaskCard.vue',
    '../src/components/summaries/SummaryTaskDetail.vue',
    '../src/components/summaries/SummaryConversationDrawer.vue',
    // The conversation drawer reuses the existing history pane for its
    // 「历史记录」tab; its getSessionHistory contract is covered here.
    '../src/components/PaneHistory.vue'
  ]
  const jsFiles = [
    '../src/stores/summaryTasks.js',
    '../src/components/summaries/summaryTaskStatus.js'
  ]
  const sources = files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(parseSfc(source).errors, [], files[index])
  }
  const all = sources.concat(
    jsFiles.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  ).join('\n')
  for (const text of [
    'periodType', 'partial', 'executorId', 'profileId', 'model',
    'coverage', '可能产生费用', '设为当前版本', 'workLogs', 'briefPrompt',
    '取消生成', '确认继续', '打开总结 CLI', '可能产生费用',
    '复制 Markdown', '导出 Markdown', '导出 HTML', '删除总结', '确认删除', '重试',
    '工作日志', '历史报告', 'listSummaryWorkLogs', 'readSummaryWorkLog',
    '在浏览器中打开', 'open-html', 'openWorkLogHtml',
    // Embedded CLI lives in the conversation drawer: SessionTerminal + auto-send.
    'SessionTerminal', 'startAdapter', 'sendTurn', 'session:terminal-output',
    // Task dashboard: cards, detail, and the right-hand conversation drawer.
    'SummaryTaskCard', 'SummaryTaskDetail', 'SummaryConversationDrawer', 'summaryTaskStatus',
    'attachTerminal', 'refit', 'getSessionHistory', 'updateSessionNote',
    'suggestedFileName', 'summaryTasks.addTask', 'setStatus',
    '正在准备材料并启动 CLI', 'AI 正在分析并撰写总结',
    // HTML work logs preview inline in a sandboxed srcdoc iframe.
    'srcdoc', 'sandbox', 'USE_PROFILES'
  ]) assert.match(all, new RegExp(text))
  assert.match(all, /exportingHtml\.value\s*=\s*true/)
  assert.match(all, /exportingHtml\.value\s*=\s*false/)
  assert.match(all, /HTML\s*已导出/)
  for (const themeId of ['executive', 'engineering', 'timeline', 'dashboard', 'print']) {
    assert.match(all, new RegExp(themeId))
  }
  assert.match(all, /SUMMARY_THEMES/)
  assert.match(all, /mode:\s*['"]theme['"]/)
  assert.match(all, /mode:\s*['"]ai-custom['"]/)
  for (const text of ['AI 自定义', '较慢', '产生 AI 用量', '即时生成']) {
    assert.match(all, new RegExp(text))
  }
  assert.match(all, /:confirm-loading="exportingHtml"/)
  assert.match(all, /if\s*\(exportingHtml\.value\)\s*return/)
  assert.match(all, /themeId:\s*['"]executive['"]/)
  assert.match(all, /@confirm="\$emit\('delete-report', report\.id\)"/)
  assert.match(all, /summaries\.deleteReport/)
  assert.match(all, /MarkdownIt\(\{\s*html:\s*false/)
  assert.match(all, /DOMPurify\.sanitize/)
  assert.match(all, /failed|interrupted/)
  // The generate dialog hands the session off instead of navigating away.
  assert.doesNotMatch(all, /pendingAssign|router\.push/)
  // The embedded terminal forwards input and output over the session IPC surface.
  assert.match(all, /ipc\.sendTerminalInput\s*\(props\.sessionId,\s*data\)/)
  assert.match(all, /evt\.sessionId\s*===\s*props\.sessionId/)
  assert.match(all, /ipc\.terminalResize\s*\(props\.sessionId/)
  // The summary page waits for adapter readiness before auto-sending the brief.
  assert.match(all, /await\s+ipc\.startAdapter\(sessionId\)/)
  assert.match(all, /await\s+ipc\.sendTurn\(sessionId,\s*briefPrompt\)/)
  assert.match(all, /@open="onSummaryOpen"/)
})

test('summaryTasks store reconstructs tasks from persisted sessions and drives the state machine', async () => {
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
  window.ucli.listSessions = async () => [
    { id: 's-completed', name: '工作总结（每周）', adapterId: 'claude', cwd: 'C:/work',
      taskNote: '2026-08-14-summary.md', status: 'exited', createdAt: 2000, updatedAt: 2100,
      lastActivity: '进程退出 (0)' },
    { id: 's-running', name: '工作总结（每月）', adapterId: 'codex', cwd: 'C:/work',
      taskNote: null, status: 'running', createdAt: 1000, updatedAt: 1100, lastActivity: '运行中' },
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
    assert.equal(store.selectedTaskId, 's-completed')
    const completed = store.tasks.find(task => task.sessionId === 's-completed')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.periodLabel, '每周')
    assert.equal(completed.suggestedFileName, '2026-08-14-summary.md')
    assert.equal(store.tasks.find(task => task.sessionId === 's-running').status, 'running')
    assert.equal(store.tasks.find(task => task.sessionId === 's-interrupted').status, 'interrupted')

    // addTask → starting；setStatus → running；setError → failed。
    store.addTask({ sessionId: 's-new', adapterId: 'codex', periodLabel: '每日',
      periodType: 'day', suggestedFileName: '2026-08-21-summary.md', workLogsDir: 'C:/work' })
    assert.equal(store.tasks[0].sessionId, 's-new')
    assert.equal(store.tasks[0].status, 'starting')
    store.setStatus('s-new', 'running')
    assert.equal(store.tasks[0].status, 'running')
    store.setError('s-new', new Error('CLI 启动失败'))
    assert.equal(store.tasks[0].status, 'failed')
    assert.equal(store.tasks[0].lastActivity, 'CLI 启动失败')

    // session:event 事件驱动 lastActivity 与 token 统计。
    store._onEvent({ sessionId: 's-new', type: 'ready', ts: 3000 })
    assert.equal(store.tasks[0].lastActivity, '已就绪')
    store._onEvent({ sessionId: 's-new', type: 'stats_update', ts: 3001,
      usage: { inputTokens: 10, outputTokens: 20 }, costUsd: 0.5 })
    assert.deepEqual(store.tasks[0].tokens, { input: 10, output: 20 })
    assert.equal(store.tasks[0].costUsd, 0.5)

    // removeTask 重选下一任务；addTask 对已存在 sessionId 就地更新（不产生重复卡）。
    store.selectTask('s-new')
    store.removeTask('s-new')
    assert.equal(store.selectedTaskId, 's-completed')
    store.addTask({ sessionId: 's-completed', adapterId: 'claude', periodLabel: '每周',
      periodType: 'week', suggestedFileName: '2026-08-14-summary.md', workLogsDir: 'C:/work' })
    assert.equal(store.tasks.filter(task => task.sessionId === 's-completed').length, 1)
    assert.equal(store.tasks.find(task => task.sessionId === 's-completed').status, 'starting')

    // 第二次 init 被 unsub 守卫跳过（不重复订阅），事件仍派发到同一 handler。
    assert.equal(subscribeCount, 1)
    await store.init()
    assert.equal(subscribeCount, 1)
    assert.equal(store.tasks.filter(task => task.sessionId === 's-completed').length, 1)
    eventHandler({ sessionId: 's-running', type: 'exit', code: 0, ts: 4000 })
    assert.equal(store.tasks.find(task => task.sessionId === 's-running').lastActivity, '进程退出 (0)')
  } finally {
    store.dispose()
    window.ucli.listSessions = originalListSessions
    window.ucli.listSummaryWorkLogs = originalListWorkLogs
    window.ucli.on = originalOn
  }
})

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
    reportId: 'report-cache', phase: 'cache-check', completed: 0, total: 1,
    text: '正在检查缓存'
  })
  assert.deepEqual(store.progress['report-cache'], {
    reportId: 'report-cache', phase: 'cache-check', completed: 0, total: 1,
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
  const workLogView = readFileSync(
    new URL('../src/components/summaries/WorkLogReportView.vue', import.meta.url),
    'utf8'
  )
  const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  for (const source of [reportView, workLogView]) {
    assert.match(source, /@click="handleReportLink"/)
    assert.match(source, /openSummaryReportLink\(event, ipc\.openExternal\)/)
  }
  assert.match(preload, /openExternal:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\('shell:open-external', url\)/)
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
