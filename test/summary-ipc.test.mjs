import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const CHANNELS = [
  'summary:get-settings', 'summary:set-settings', 'summary:list-reports',
  'summary:get-report', 'summary:generate', 'summary:cancel',
  'summary:set-current', 'summary:export-markdown', 'summary:export-html'
]

test('main summary IPC registers the exact surface and validates every payload', async () => {
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  for (const channel of CHANNELS) assert.match(source, new RegExp(`['"]${channel}['"]`))
  assert.match(source, /export function registerSummaryIpc/)
  assert.match(source, /SUMMARY_SETTINGS_FIELDS/)
  assert.match(source, /SUMMARY_REPORT_FILTER_FIELDS/)
  assert.match(source, /SUMMARY_GENERATE_FIELDS/)
  assert.match(source, /validateSummaryId/)
  assert.match(source, /validateSummaryGenerate/)
  assert.match(source, /SUMMARY_CONFIRM_FIELDS/)
  assert.match(source, /confirmationCallLimit/)
  assert.match(source, /summaryJobService\.confirm/)
  assert.match(source, /completedPeriod/)
  assert.match(source, /manualPeriod/)
  assert.match(source, /inspectCliTools\(\)/)
  assert.match(source, /profileService\?\.listProfiles/)
  assert.match(source, /validateSummarySettings[\s\S]{0,1800}automaticCallLimit/)
  assert.match(source, /validateSummaryExport/)
  assert.match(source, /SUMMARY_EXPORT_FIELDS/)
  assert.match(source, /custom.*requirement/s)
  assert.match(source, /safeSummaryEnvelope/)
  assert.match(source, /createReportExportService/)
  assert.match(source, /summaryExportService\s*=\s*createReportExportService/)
  assert.match(source, /SUMMARY_HTML_INVALID/)
  assert.match(source, /validationErrors/)
})

test('preload preserves safe HTML validation codes without exposing raw output', async () => {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  let api
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: async () => ({
        ok: false,
        error: {
          code: 'SUMMARY_HTML_INVALID',
          message: 'Generated HTML failed safety validation',
          validationErrors: [{ code: 'FORBIDDEN_ELEMENT' }]
        }
      }),
      on() {},
      removeListener() {}
    }
  )
  await assert.rejects(
    api.exportSummaryHtml({ reportId: 'r1', style: { mode: 'light' } }),
    error => error.code === 'SUMMARY_HTML_INVALID' &&
      error.validationErrors?.[0]?.code === 'FORBIDDEN_ELEMENT' &&
      !JSON.stringify(error).includes('raw')
  )
})

test('summary IPC returns typed safe errors without provider output', async () => {
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /SUMMARY_SERVICE_UNAVAILABLE:\s*'Summary service is unavailable'/)
  assert.match(source, /SUMMARY_EXPORT_UNAVAILABLE:\s*'Summary export is unavailable'/)
  assert.doesNotMatch(source, /safeSummaryError[\s\S]{0,800}error\.message/)
})

test('preload exposes named summary calls and one removable progress listener', async () => {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const invocations = []
  const listeners = new Map()
  let api
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: (channel, ...args) => { invocations.push([channel, ...args]); return Promise.resolve({ ok: true, value: channel }) },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel) }
    }
  )

  await api.getSummarySettings()
  await api.setSummarySettings({ autoEnabled: false })
  await api.listSummaryReports({ periodType: 'week' })
  await api.getSummaryReport('r1')
  await api.generateSummary({ periodType: 'week' })
  await api.confirmSummary('r1', 24)
  await api.cancelSummary('r1')
  await api.setCurrentSummary('r1')
  await api.exportSummaryMarkdown({ reportId: 'r1' })
  await api.exportSummaryHtml({ reportId: 'r1', style: { mode: 'light' } })
  const progress = []
  const dispose = api.onSummaryProgress(value => progress.push(value))
  listeners.get('summary:progress')({}, { reportId: 'r1', phase: 'mapping' })
  dispose()

  assert.deepEqual(invocations.map(call => call[0]), [
    ...CHANNELS.slice(0, 5), 'summary:generate', ...CHANNELS.slice(5)
  ])
  assert.deepEqual(invocations[5], ['summary:generate', {
    reportId: 'r1', confirm: true, confirmationCallLimit: 24
  }])
  assert.deepEqual(progress, [{ reportId: 'r1', phase: 'mapping' }])
  assert.equal(listeners.has('summary:progress'), false)
})
