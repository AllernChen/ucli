import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSummaryMaintenance } from '../electron/startupLifecycle.js'
import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const { deleteSummaryReportAndWorkspace, normalizeSummaryStorageStats, registerSummaryIpc, summaryProgressPayload } = await import(`../electron/orchestrator.js?summary-ipc=${Date.now()}`)

const CHANNELS = [
  'summary:get-settings', 'summary:set-settings', 'summary:list-reports',
  'summary:get-report', 'summary:generate', 'summary:list-worklogs', 'summary:read-worklog',
  'summary:cancel',
  'summary:set-current', 'summary:delete', 'summary:export-markdown', 'summary:export-html',
  'summary:cache-stats', 'summary:cache-clear'
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
  assert.match(source, /SUMMARY_EXECUTOR_AUTH_UNAVAILABLE/)
  assert.match(source, /profileProvidesSummaryAuthentication/)
  assert.match(source, /SUMMARY_EXECUTOR_UNSAFE/)
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

test('summary IPC preserves the safe concurrent-confirmation error', async () => {
  const handlers = new Map()
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: {
      generate() {
        throw Object.assign(new Error('private confirmation detail'), {
          code: 'SUMMARY_CONFIRMATION_IN_PROGRESS'
        })
      }
    }
  })

  const response = await handlers.get('summary:generate')({}, {
    reportId: 'report-1', confirm: true, confirmationCallLimit: 24
  })
  assert.deepEqual(response, {
    ok: false,
    error: {
      code: 'SUMMARY_CONFIRMATION_IN_PROGRESS',
      message: 'Summary confirmation is already in progress'
    }
  })
  assert.doesNotMatch(JSON.stringify(response), /private|detail/i)
})

test('report deletion keeps database success when best-effort workspace cleanup fails', async () => {
  const events = []
  const result = await deleteSummaryReportAndWorkspace('report-1', {
    repository: { delete: async () => ({ deletedReportId: 'report-1', currentReportId: null }) },
    jobService: { isActive: () => false },
    workspaceService: { remove: async () => { throw new Error('C:\\private\\prompt') } },
    onEvent: event => events.push(event)
  })
  assert.deepEqual(result, { deletedReportId: 'report-1', currentReportId: null })
  assert.deepEqual(events, [{ phase: 'workspace-delete', code: 'SUMMARY_WORKSPACE_DELETE_FAILED' }])
  assert.doesNotMatch(JSON.stringify(events), /private|prompt/i)
})

test('maintenance reclaims a deleted report workspace after immediate cleanup fails even below quota', async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucli-summary-orphan-test-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const workspaceService = createSummaryWorkspaceService({ root: join(temporaryRoot, 'summary') })
  const workspace = await workspaceService.create('report-deleted-orphan')
  await workspaceService.complete(workspace.id, { markdown: 'derived copy' })
  let firstRemoval = true
  const cleanupFacade = {
    async remove(reportId) {
      if (firstRemoval) {
        firstRemoval = false
        throw Object.assign(new Error('locked'), { code: 'SUMMARY_WORKSPACE_DELETE_FAILED' })
      }
      return workspaceService.remove(reportId)
    }
  }

  await deleteSummaryReportAndWorkspace(workspace.id, {
    repository: { delete: async () => ({ deletedReportId: workspace.id, currentReportId: null }) },
    jobService: { isActive: () => false },
    workspaceService: cleanupFacade
  })
  assert.equal(existsSync(workspace.path), true)

  await runSummaryMaintenance({
    quotaBytes: 1024 * 1024,
    pruneExpiredWorkspaces: () => workspaceService.pruneExpired(),
    pruneOrphanWorkspaces: () => workspaceService.pruneOrphans({
      isProtected: () => false,
      isRetained: async () => false
    }),
    getWorkspaceUsage: () => workspaceService.usage(),
    pruneCache: async () => ({ removed: 0, bytes: 0 }),
    getCacheUsage: async () => ({ bytes: 0 }),
    pruneCompletedWorkspaces: maxBytes => workspaceService.pruneCompleted({ maxBytes })
  })

  assert.equal(existsSync(workspace.path), false)
})

test('report deletion never removes a workspace while its job is active', async () => {
  let removals = 0
  const result = await deleteSummaryReportAndWorkspace('report-active', {
    repository: { delete: async () => ({ deletedReportId: 'report-active', currentReportId: null }) },
    jobService: { isActive: () => true },
    workspaceService: { remove: async () => { removals += 1 } }
  })
  assert.equal(result.deletedReportId, 'report-active')
  assert.equal(removals, 0)
})

test('successful report deletion removes its inactive derived workspace', async () => {
  const removals = []
  const result = await deleteSummaryReportAndWorkspace('report-completed', {
    repository: { delete: async () => ({ deletedReportId: 'report-completed', currentReportId: 'report-old' }) },
    jobService: { isActive: () => false },
    workspaceService: { remove: async reportId => { removals.push(reportId) } }
  })
  assert.deepEqual(result, { deletedReportId: 'report-completed', currentReportId: 'report-old' })
  assert.deepEqual(removals, ['report-completed'])
})

test('HTML runner failures remain actionable without exposing provider output', async () => {
  const handlers = new Map()
  const unavailable = () => { throw Object.assign(new Error('unused'), { code: 'SUMMARY_SERVICE_UNAVAILABLE' }) }
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: {
      getSettings: unavailable, setSettings: unavailable, listReports: unavailable,
      getReport: unavailable, generate: unavailable, cancel: unavailable,
      setCurrent: unavailable, deleteReport: unavailable, exportMarkdown: unavailable,
      exportHtml() {
        throw Object.assign(new Error('provider stderr contains C:\\secret\\token.txt'), {
          code: 'SUMMARY_HTML_GENERATION_FAILED', stderr: 'Bearer private-secret'
        })
      }
    }
  })

  const response = await handlers.get('summary:export-html')({}, {
    reportId: 'report-1', style: { mode: 'light' }
  })
  assert.deepEqual(response, {
    ok: false,
    error: {
      code: 'SUMMARY_HTML_GENERATION_FAILED',
      message: 'AI CLI failed while generating HTML'
    }
  })
  assert.doesNotMatch(JSON.stringify(response), /secret|Bearer|stderr/i)
})

test('HTML export IPC accepts the strict theme and AI custom unions plus legacy presets', async () => {
  const handlers = new Map()
  const calls = []
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: { exportHtml: value => { calls.push(value); return value.style } }
  })
  const invoke = style => handlers.get('summary:export-html')({}, { reportId: 'report-1', style })
  for (const style of [
    { mode: 'theme', themeId: 'dashboard' },
    { mode: 'ai-custom', requirement: 'Swiss layout' },
    { mode: 'light' },
    { mode: 'dark' },
    { mode: 'custom', requirement: 'legacy layout' }
  ]) assert.equal((await invoke(style)).ok, true)

  for (const style of [
    { mode: 'theme', themeId: 'unknown' },
    { mode: 'theme', themeId: 'executive', requirement: 'extra' },
    { mode: 'theme', themeId: 'executive', path: 'C:\\secret' },
    { mode: 'ai-custom', requirement: '' },
    { mode: 'ai-custom', requirement: 'clean', themeId: 'print' },
    { mode: 'light', requirement: 'extra' }
  ]) {
    const response = await invoke(style)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_SUMMARY_IPC')
    assert.doesNotMatch(JSON.stringify(response), /secret/i)
  }
  assert.equal(calls.length, 5)
})

test('cache-check progress is a narrow localized payload without cache metadata', () => {
  assert.deepEqual(summaryProgressPayload({ id: 'report-1', status: 'running' }, null, {
    phase: 'cache-check', completed: 0, total: 1,
    cacheKey: 'sha256:secret', path: 'C:\\private', providerOutput: 'secret'
  }), {
    reportId: 'report-1', phase: 'cache-check', completed: 0, total: 1,
    text: '正在检查缓存'
  })
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
  await api.listSummaryWorkLogs()
  await api.readSummaryWorkLog('2026-W33-summary.md')
  await api.cancelSummary('r1')
  await api.setCurrentSummary('r1')
  await api.deleteSummaryReport('r1')
  await api.exportSummaryMarkdown({ reportId: 'r1' })
  await api.exportSummaryHtml({ reportId: 'r1', style: { mode: 'light' } })
  await api.getSummaryCacheStats()
  await api.clearSummaryCache({ includeFailedWorkspaces: true })
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
  assert.deepEqual(invocations[6], ['summary:list-worklogs'])
  assert.deepEqual(invocations[7], ['summary:read-worklog', '2026-W33-summary.md'])
  assert.deepEqual(progress, [{ reportId: 'r1', phase: 'mapping' }])
  assert.equal(listeners.has('summary:progress'), false)
})

test('cache IPC accepts no stats payload and only the failed-workspace boolean for clear', async () => {
  const handlers = new Map()
  const calls = []
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: {
      getCacheStats: (...args) => { calls.push(['stats', ...args]); return { totalBytes: 0 } },
      clearCache: value => { calls.push(['clear', value]); return { removed: 0 } }
    }
  })

  assert.equal((await handlers.get('summary:cache-stats')({})).ok, true)
  assert.equal((await handlers.get('summary:cache-stats')({}, { path: 'C:\\secret' })).ok, false)
  assert.equal((await handlers.get('summary:cache-clear')({}, {
    includeFailedWorkspaces: true
  })).ok, true)
  for (const invalid of [{}, { includeFailedWorkspaces: 1 }, {
    includeFailedWorkspaces: false, path: 'C:\\secret'
  }]) {
    const response = await handlers.get('summary:cache-clear')({}, invalid)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_SUMMARY_IPC')
    assert.doesNotMatch(JSON.stringify(response), /secret/)
  }
  assert.deepEqual(calls, [
    ['stats'],
    ['clear', { includeFailedWorkspaces: true }]
  ])
})

test('worklog IPC lists reports and maps invalid or missing reads to safe codes', async () => {
  const handlers = new Map()
  const calls = []
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: {
      listWorkLogs: () => { calls.push('list'); return [] },
      readWorkLog: fileName => {
        calls.push(`read:${fileName}`)
        if (fileName === 'missing.md') {
          throw Object.assign(new Error('C:\\private\\missing.md'), { code: 'SUMMARY_WORKLOG_NOT_FOUND' })
        }
        return { name: fileName, kind: 'markdown', content: '# 周报' }
      }
    }
  })

  const list = await handlers.get('summary:list-worklogs')({})
  assert.equal(list.ok, true)
  assert.deepEqual(list.value, [])

  const read = await handlers.get('summary:read-worklog')({}, '2026-W33-summary.md')
  assert.equal(read.ok, true)
  assert.equal(read.value.content, '# 周报')

  const missing = await handlers.get('summary:read-worklog')({}, 'missing.md')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'SUMMARY_WORKLOG_NOT_FOUND')
  assert.doesNotMatch(JSON.stringify(missing), /private|missing\.md/)

  for (const invalid of ['', 0, null, {}, 'x'.repeat(129)]) {
    const response = await handlers.get('summary:read-worklog')({}, invalid)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_SUMMARY_IPC')
  }
  assert.deepEqual(calls, ['list', 'read:2026-W33-summary.md', 'read:missing.md'])
})

test('cache stats expose bounded nonnegative counters without paths or extra metadata', () => {
  assert.deepEqual(normalizeSummaryStorageStats({
    cacheBytes: 12,
    quotaBytes: 268435456,
    entries: 2,
    workspaceBytes: 8,
    failedWorkspaces: 1,
    lastPrunedAt: 123,
    path: 'C:\\secret',
    totalBytes: 999
  }), {
    totalBytes: 20,
    quotaBytes: 268435456,
    cacheBytes: 12,
    workspaceBytes: 8,
    entries: 2,
    failedWorkspaces: 1,
    lastPrunedAt: 123
  })
  assert.deepEqual(normalizeSummaryStorageStats({
    cacheBytes: -1, quotaBytes: Infinity, entries: 1.5,
    workspaceBytes: Number.MAX_SAFE_INTEGER,
    failedWorkspaces: -2, lastPrunedAt: -1
  }), {
    totalBytes: Number.MAX_SAFE_INTEGER,
    quotaBytes: 0,
    cacheBytes: 0,
    workspaceBytes: Number.MAX_SAFE_INTEGER,
    entries: 0,
    failedWorkspaces: 0,
    lastPrunedAt: null
  })
})
