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
    }
  }
}

const { useSummariesStore } = await import('../src/stores/summaries.js')

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
    '../src/components/summaries/WorkLogReportView.vue'
  ]
  const sources = files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(parseSfc(source).errors, [], files[index])
  }
  const all = sources.join('\n')
  for (const text of [
    'periodType', 'partial', 'executorId', 'profileId', 'model',
    'coverage', '可能产生费用', '设为当前版本', 'workLogs', 'briefPrompt',
    '取消生成', '确认继续', '打开总结 CLI', '可能产生费用',
    '复制 Markdown', '导出 Markdown', '导出 HTML', '删除总结', '确认删除', '重试',
    '工作日志', '历史报告', 'listSummaryWorkLogs', 'readSummaryWorkLog',
    '在浏览器中打开', 'open-html', 'openWorkLogHtml',
    // Embedded CLI: the summary page renders SessionTerminal and auto-sends the brief.
    'SessionTerminal', 'startAdapter', 'sendTurn', 'session:terminal-output',
    'activeSummarySessionId', 'summaryTerminal',
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
