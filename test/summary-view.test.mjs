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

test('task editing updates report and version projections without changing selection', async () => {
  const originalUpdate = window.ucli.updateSummaryTask
  const store = freshStore()
  try {
    store.reports = [{ id: 'report-1', title: '旧名称', taskNote: '', version: 1 }]
    store.versions = [{ id: 'report-1', title: '旧名称', taskNote: '', version: 1 }]
    store.selectedReportId = 'report-1'
    window.ucli.updateSummaryTask = async value => ({
      id: value.reportId, title: value.title, taskNote: value.taskNote, version: 1
    })

    const report = await store.updateTask('report-1', {
      title: '新名称', taskNote: '备注'
    })
    assert.equal(report.title, '新名称')
    assert.equal(store.reports[0].taskNote, '备注')
    assert.equal(store.versions[0].title, '新名称')
    assert.equal(store.selectedReportId, 'report-1')
  } finally {
    window.ucli.updateSummaryTask = originalUpdate
    store.dispose()
  }
})

test('a stale refresh response cannot overwrite a newer task edit', async () => {
  const originalGet = window.ucli.getSummaryReport
  const originalUpdate = window.ucli.updateSummaryTask
  let resolveRefresh
  const staleReport = new Promise(resolve => { resolveRefresh = resolve })
  const store = freshStore()
  try {
    store.reports = [{ id: 'report-1', title: '旧名称', taskNote: '', version: 1 }]
    store.versions = [{ id: 'report-1', title: '旧名称', taskNote: '', version: 1 }]
    store.selectedReportId = 'report-1'
    window.ucli.getSummaryReport = () => staleReport
    window.ucli.updateSummaryTask = async value => ({
      id: value.reportId, title: value.title, taskNote: value.taskNote, version: 1
    })

    const refreshing = store.refreshReport('report-1')
    await store.updateTask('report-1', { title: '新名称', taskNote: '新备注' })
    resolveRefresh({ id: 'report-1', title: '旧名称', taskNote: '', version: 1 })
    await refreshing

    assert.equal(store.reports[0].title, '新名称')
    assert.equal(store.versions[0].taskNote, '新备注')
    assert.equal(store.selectedReportId, 'report-1')
    assert.equal(store.selectedReport.title, '新名称')
  } finally {
    window.ucli.getSummaryReport = originalGet
    window.ucli.updateSummaryTask = originalUpdate
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
  assert.doesNotMatch(
    readFileSync(new URL('../src/components/summaries/WorkSummaryPanel.vue', import.meta.url), 'utf8'),
    new RegExp(['prepare' + 'Summary', 'summaryTasks\\.addTask', 'reportProduced' + 'ByRun', 'setInterval'].join('|'))
  )
})

test('summary renderer and focused tests contain no legacy task workflow identifiers', () => {
  const files = [
    '../src/ipc.js', '../electron/preload.js', '../electron/orchestrator.js',
    '../test/summary-export.test.mjs', '../test/summary-ipc.test.mjs',
    '../test/summary-view.test.mjs', '../test/summary-view-mounted.test.mjs'
  ]
  const legacy = new RegExp([
    'useSummary' + 'TasksStore', 'summaryTask' + 'Note', 'summaryTask' + 'Status',
    'listSummary' + 'WorkLogs', 'readSummary' + 'WorkLog', 'suggestedFile' + 'Name',
    'reportProduced' + 'ByRun', '\\bm' + 'time\\b'
  ].join('|'))
  for (const file of files) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), legacy, file)
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
