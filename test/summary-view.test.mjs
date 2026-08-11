import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { parse as parseSfc } from '@vue/compiler-sfc'

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

test('summary workspace components cover generation, safe reading, history, retry, and export', () => {
  const files = [
    '../src/components/summaries/SummaryGenerateDialog.vue',
    '../src/components/summaries/SummaryReportView.vue',
    '../src/components/summaries/SummaryHistory.vue',
    '../src/components/summaries/WorkSummaryPanel.vue'
  ]
  const sources = files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(parseSfc(source).errors, [], files[index])
  }
  const all = sources.join('\n')
  for (const text of [
    'periodType', 'partial', 'executorId', 'profileId', 'model',
    'estimatedCalls', 'coverage', '可能产生费用', '设为当前版本',
    '取消生成', '确认继续', '预计调用', '可能产生费用',
    '复制 Markdown', '导出 Markdown', '导出 HTML', '重试'
  ]) assert.match(all, new RegExp(text))
  assert.match(all, /MarkdownIt\(\{\s*html:\s*false/)
  assert.match(all, /DOMPurify\.sanitize/)
  assert.match(all, /mode:\s*['"]light['"]/)
  assert.match(all, /failed|interrupted/)
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
