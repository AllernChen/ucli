import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { claudeDescriptor } from '../electron/adapters/claudeAdapter.js'
import { codexDescriptor } from '../electron/adapters/codexAdapter.js'
import { openCodeDescriptor } from '../electron/adapters/openCodeAdapter.js'
import { ucodeDescriptor } from '../electron/adapters/ucodeAdapter.js'
import {
  removeCodexProfileFile,
  writeCodexProfileFileAtomic
} from '../electron/aiCliProfiles/codexProfileFile.js'
import { getDb } from '../electron/persistence/db.js'
import { runSummaryMaintenance } from '../electron/startupLifecycle.js'
import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const {
  cancelActiveSummary,
  createOrchestrator,
  deleteSummaryReportAndWorkspace,
  normalizeSummaryStorageStats,
  registerSummaryIpc,
  summaryProgressPayload
} = await import(`../electron/orchestrator.js?summary-ipc=${Date.now()}`)

const PERIOD_START = Date.UTC(2026, 7, 10)
const PERIOD_END = Date.UTC(2026, 7, 17)

function interactiveRequest(overrides = {}) {
  return {
    periodType: 'week', start: PERIOD_START, endExclusive: PERIOD_END,
    timezone: 'Asia/Shanghai', partial: false, executorId: 'opencode',
    profileId: null, model: 'provider/model', ...overrides
  }
}

async function waitUntil(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for orchestrator behavior')
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function holdHookReady() {
  const reached = deferred()
  const release = deferred()
  let observed = false
  return {
    reached: reached.promise,
    release: release.resolve,
    get observed() { return observed },
    then(onFulfilled, onRejected) {
      observed = true
      reached.resolve()
      return release.promise.then(onFulfilled, onRejected)
    }
  }
}

class FakeInteractiveAdapter extends EventEmitter {
  constructor(options) {
    super()
    this.session = options.session
    this.settings = options.settings
    this.sent = []
    this.throwOnDispose = false
    this.disposeCalls = 0
    this.disposed = false
    this.disposeGate = null
  }

  async start() {
    this.startCalls = (this.startCalls || 0) + 1
    this.emit('event', {
      type: 'ready', sessionId: this.session.id, ts: Date.now()
    })
    return true
  }

  async sendTurn(text) {
    this.sent.push(text)
    this.emit('gateway-event', {
      type: 'turn_started', sessionId: this.session.id,
      turnId: 'summary-turn-1', occurredAt: Date.now()
    })
    return true
  }

  setProfileLaunch(profileLaunch) {
    this.settings.profileLaunch = profileLaunch
  }

  setProfileEnvironment(profileEnvironment) {
    this.settings.profileEnvironment = profileEnvironment
  }

  async dispose() {
    this.disposeCalls += 1
    if (this.disposeGate) await this.disposeGate
    if (this.throwOnDispose) throw new Error('private adapter disposal failure')
    this.disposed = true
  }
}

async function withInteractiveOrchestrator(t, {
  summaryStartup,
  onAdapterCreated,
  hookReady
} = {}, callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucli-summary-orchestrator-'))
  const userData = join(temporaryRoot, 'user-data')
  const localAppData = join(temporaryRoot, 'local-app-data')
  const codexHome = join(temporaryRoot, 'codex-home')
  await mkdir(userData, { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  const previousLocalAppData = process.env.LOCALAPPDATA
  const previousCodexHome = process.env.CODEX_HOME
  process.env.UCLI_TEST_USER_DATA = userData
  process.env.LOCALAPPDATA = localAppData
  process.env.CODEX_HOME = codexHome
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const instances = []
  const descriptors = [claudeDescriptor, codexDescriptor, openCodeDescriptor, ucodeDescriptor]
  const originalCreates = new Map(descriptors.map(descriptor => [descriptor, descriptor.create]))
  for (const descriptor of descriptors) {
    descriptor.create = options => {
      const adapter = new FakeInteractiveAdapter(options)
      instances.push(adapter)
      onAdapterCreated?.({ adapter, config: options, instances, codexHome })
      return adapter
    }
  }
  let orchestrator
  try {
    orchestrator = createOrchestrator({ summaryStartup, hookReady })
    await orchestrator.initPersistence()
    orchestrator.registerIpc()
    await callback({ handlers, instances, orchestrator, codexHome })
  } finally {
    for (const descriptor of descriptors) descriptor.create = originalCreates.get(descriptor)
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function createBoundProfile(handlers, executorId) {
  const draft = executorId === 'claude'
    ? {
        adapterId: 'claude', name: 'Summary Claude Profile',
        connectionMode: 'subscription', model: 'claude-3-7-sonnet'
      }
    : {
        adapterId: 'codex', name: 'Summary Codex Profile', kind: 'reference',
        providerId: 'openai', model: 'gpt-5.4'
      }
  return handlers.get('ai-cli-profiles:create')({}, draft)
}

function mutateBoundProfile({ profile, executorId, codexHome }) {
  const db = getDb()
  const updatedAt = Number(profile.updatedAt) + 1
  const model = executorId === 'claude' ? 'claude-3-7-haiku' : 'gpt-5.5'
  if (executorId === 'codex') {
    const stored = db.getAiCliProfile(profile.id)
    const written = writeCodexProfileFileAtomic({
      codexHome,
      profile: { ...stored, model },
      expectedSha256: stored.fileSha256
    })
    db.updateAiCliProfile(profile.id, { model, fileSha256: written.sha256, updatedAt })
    return model
  }
  db.updateAiCliProfile(profile.id, { model, updatedAt })
  return model
}

function makeBoundProfileUnavailable({ profile, executorId, codexHome }) {
  const db = getDb()
  if (executorId === 'codex') {
    const stored = db.getAiCliProfile(profile.id)
    removeCodexProfileFile({
      codexHome,
      profile: stored,
      expectedSha256: stored.fileSha256
    })
    return
  }
  db.deleteAiCliProfile(profile.id)
}

const CHANNELS = [
  'summary:get-settings', 'summary:set-settings', 'summary:list-reports',
  'summary:get-report', 'summary:generate', 'summary:start-interactive',
  'summary:list-worklogs', 'summary:read-worklog',
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

test('interactive summary IPC returns only report and session identifiers', async () => {
  const handlers = new Map()
  const calls = []
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: {
      async startInteractive(value) {
        calls.push(value)
        return {
          report: { id: 'report-1', status: 'queued' },
          sessionId: 'session-1',
          done: Promise.resolve(),
          workspace: 'C:\\private\\summary',
          prompt: 'credential prompt',
          transcript: 'raw transcript'
        }
      }
    }
  })
  const request = {
    periodType: 'week', start: PERIOD_START, endExclusive: PERIOD_END, timezone: 'Asia/Shanghai',
    partial: false, executorId: 'claude', profileId: 'p1', model: 'sonnet'
  }

  const result = await handlers.get('summary:start-interactive')({}, request)

  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.value).sort(), ['report', 'sessionId'])
  assert.deepEqual(result.value, {
    report: { id: 'report-1', status: 'queued' },
    sessionId: 'session-1'
  })
  assert.doesNotMatch(JSON.stringify(result), /workspace|prompt|transcript|done|private|credential/i)
  assert.deepEqual(calls, [{ ...request, profileId: 'p1', model: 'sonnet' }])
})

test('interactive summary IPC rejects renderer-owned lifecycle and output fields', async () => {
  const handlers = new Map()
  let starts = 0
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: { startInteractive: async () => { starts += 1; return {} } }
  })
  const valid = {
    periodType: 'week', start: PERIOD_START, endExclusive: PERIOD_END, timezone: 'UTC',
    partial: false, executorId: 'claude', profileId: null, model: null
  }
  for (const invalidField of [
    ['reportId', 'renderer-report'],
    ['sessionId', 'renderer-session'],
    ['cwd', 'C:\\private'],
    ['output', 'C:\\private\\report.md'],
    ['outputPath', 'C:\\private\\report.md'],
    ['generatedBy', 'automatic'],
    ['unknown', true]
  ]) {
    const response = await handlers.get('summary:start-interactive')({}, {
      ...valid,
      [invalidField[0]]: invalidField[1]
    })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_SUMMARY_IPC')
    assert.doesNotMatch(JSON.stringify(response), /private|renderer-report|renderer-session/i)
  }
  assert.equal(starts, 0)
})

test('interactive summary IPC rejects unsafe epochs and unbounded periods before queueing', async () => {
  const handlers = new Map()
  let starts = 0
  registerSummaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: { startInteractive: async () => { starts += 1; return {} } }
  })
  for (const request of [
    interactiveRequest({ start: Number.MAX_SAFE_INTEGER + 1 }),
    interactiveRequest({ start: Date.UTC(1999, 11, 31) }),
    interactiveRequest({ endExclusive: Date.now() + 3 * 24 * 60 * 60 * 1000 }),
    interactiveRequest({ start: Date.UTC(2024, 0, 1), endExclusive: Date.UTC(2026, 0, 2) })
  ]) {
    const response = await handlers.get('summary:start-interactive')({}, request)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_SUMMARY_IPC')
  }
  assert.equal(starts, 0)
})

test('createOrchestrator routes interactive summary delivery through the runtime facade to the adapter', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    const response = await handlers.get('summary:start-interactive')({}, interactiveRequest())
    assert.equal(response.ok, true)
    assert.deepEqual(Object.keys(response.value).sort(), ['report', 'sessionId'])
    const adapter = await waitUntil(() => instances[0])
    await waitUntil(() => adapter.sent.length === 1)
    assert.equal(adapter.session.model, 'provider/model')
    assert.equal(adapter.session.profileId ?? null, null)
    assert.match(adapter.sent[0], /只写入 \.\.\/output\/report\.md/)
    const persisted = await handlers.get('summary:get-report')({}, response.value.report.id)
    assert.equal(persisted.ok, true)
    assert.equal(persisted.value.model, 'provider/model')
    assert.equal(persisted.value.profileId, null)
    assert.equal(persisted.value.model, adapter.session.model)
    assert.equal(persisted.value.profileId, adapter.session.profileId ?? null)
  })
})

test('interactive summary resolves or rejects requested profiles for every executor before persistence', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    for (const executorId of ['claude', 'codex', 'opencode', 'ucode']) {
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId,
        profileId: 'profile-that-executor-cannot-apply'
      }))
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'SUMMARY_PROFILE_UNAVAILABLE')
    }
    const reports = await handlers.get('summary:list-reports')({}, {})
    assert.deepEqual(reports.value, [])
    assert.equal(instances.length, 0)
  })
})

test('interactive summary rejects unsafe model selections for every executor before persistence', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    for (const executorId of ['claude', 'codex', 'opencode', 'ucode']) {
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId,
        model: 'unsafe model\n--permission-bypass'
      }))
      assert.equal(response.ok, false, executorId)
      assert.equal(response.error.code, 'INVALID_SUMMARY_IPC', executorId)
    }
    const reports = await handlers.get('summary:list-reports')({}, {})
    assert.deepEqual(reports.value, [])
    assert.equal(instances.length, 0)
  })
})

test('critical summary recovery failure keeps the app usable but gates scheduler and new runs', async t => {
  for (const failedPhase of ['interrupt', 'recover']) {
    let schedulerStarts = 0
    await withInteractiveOrchestrator(t, {
      summaryStartup: {
        interruptStaleJobs: async () => {
          if (failedPhase === 'interrupt') throw new Error('private stale-row failure')
        },
        recoverWorkspaces: async () => {
          if (failedPhase === 'recover') throw new Error('private workspace failure')
        },
        startScheduler: async () => { schedulerStarts += 1 }
      }
    }, async ({ handlers, instances }) => {
      assert.equal(schedulerStarts, 0)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest())
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'SUMMARY_SERVICE_UNAVAILABLE')
      const headless = await handlers.get('summary:generate')({}, interactiveRequest({ model: null }))
      assert.equal(headless.ok, false)
      assert.equal(headless.error.code, 'SUMMARY_SERVICE_UNAVAILABLE')
      const confirmation = await handlers.get('summary:generate')({}, {
        confirm: true, reportId: '550e8400-e29b-41d4-a716-446655440000', confirmationCallLimit: 1
      })
      assert.equal(confirmation.ok, false)
      assert.equal(confirmation.error.code, 'SUMMARY_SERVICE_UNAVAILABLE')
      const reports = await handlers.get('summary:list-reports')({}, {})
      assert.deepEqual(reports.value, [])
      assert.equal(instances.length, 0)
    })
  }
})

test('interactive summaries persist the effective identity of valid bound Claude and Codex profiles', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    for (const executorId of ['claude', 'codex']) {
      const profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      assert.equal(response.ok, true, executorId)
      const adapter = await waitUntil(() => instances.find(candidate =>
        candidate.session.id === response.value.sessionId
      ))
      await waitUntil(() => adapter.sent.length === 1)
      assert.equal(response.value.report.profileId, profile.id, executorId)
      assert.equal(response.value.report.model, profile.model, executorId)
      assert.equal(adapter.session.profileId, profile.id, executorId)
      assert.equal(adapter.session.model, profile.model, executorId)
    }
  })
})

test('interactive summary rejects a bound profile changed during session construction', async t => {
  for (const executorId of ['claude', 'codex']) {
    let profile = null
    await withInteractiveOrchestrator(t, {
      onAdapterCreated: ({ codexHome }) => {
        if (profile) {
          mutateBoundProfile({ profile, executorId, codexHome })
        }
      }
    }, async ({ handlers }) => {
      profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      assert.equal(response.ok, false, executorId)
      assert.equal(response.error.code, 'SUMMARY_PROFILE_UNAVAILABLE', executorId)
    })
  }
})

test('interactive summary awaits construction cleanup before reporting a bound-profile failure', async t => {
  for (const executorId of ['claude', 'codex']) {
    let profile = null
    const cleanup = deferred()
    await withInteractiveOrchestrator(t, {
      onAdapterCreated: ({ adapter, codexHome }) => {
        if (!profile) return
        mutateBoundProfile({ profile, executorId, codexHome })
        adapter.disposeGate = cleanup.promise
      }
    }, async ({ handlers, instances }) => {
      profile = await createBoundProfile(handlers, executorId)
      const pending = handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      const adapter = await waitUntil(() => instances[0])
      await waitUntil(() => adapter.disposeCalls === 1)
      let settled = false
      pending.finally(() => { settled = true })
      try {
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(settled, false, executorId)
      } finally {
        cleanup.resolve()
      }
      const response = await pending
      assert.equal(response.ok, false, executorId)
      assert.equal(response.error.code, 'SUMMARY_PROFILE_UNAVAILABLE', executorId)
      assert.equal(adapter.disposed, true, executorId)
    })
  }
})

test('interactive summary fails closed when a bound profile changes before adapter startup', async t => {
  for (const executorId of ['claude', 'codex']) {
    let profile = null
    await withInteractiveOrchestrator(t, {
      onAdapterCreated: ({ codexHome }) => {
        if (profile) queueMicrotask(() => mutateBoundProfile({ profile, executorId, codexHome }))
      }
    }, async ({ handlers, instances }) => {
      profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      assert.equal(response.ok, true, executorId)
      const adapter = await waitUntil(() => instances.find(candidate =>
        candidate.session.id === response.value.sessionId
      ))
      const persisted = await waitUntil(async () => {
        const result = await handlers.get('summary:get-report')({}, response.value.report.id)
        return result.value?.status === 'failed' ? result.value : null
      })
      assert.equal(persisted.model, profile.model, executorId)
      assert.equal(adapter.startCalls || 0, 0, executorId)
      assert.equal(adapter.sent.length, 0, executorId)
    })
  }
})

test('interactive summary aborts bound Claude and Codex startup when profiles become unavailable while hook readiness is pending', async t => {
  for (const executorId of ['claude', 'codex']) {
    const hookReady = holdHookReady()
    await withInteractiveOrchestrator(t, { hookReady }, async ({ handlers, instances, codexHome }) => {
      const profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      const adapter = await waitUntil(() => instances.find(candidate =>
        candidate.session.id === response.value.sessionId
      ))
      await waitUntil(() => hookReady.observed, { timeoutMs: 500 })
      makeBoundProfileUnavailable({ profile, executorId, codexHome })
      hookReady.release()
      const persisted = await waitUntil(async () => {
        const result = await handlers.get('summary:get-report')({}, response.value.report.id)
        return result.value?.status === 'failed' ? result.value : null
      })
      assert.equal(persisted.model, profile.model, executorId)
      assert.equal(adapter.startCalls || 0, 0, executorId)
      assert.equal(adapter.sent.length, 0, executorId)
      await waitUntil(() => adapter.disposed)
      assert.equal(adapter.disposeCalls, 1, executorId)
    })
  }
})

test('interactive summary consumes its pinned profile capability after a successful start and terminal cleanup', async t => {
  for (const executorId of ['claude', 'codex']) {
    await withInteractiveOrchestrator(t, {}, async ({ handlers, instances, codexHome }) => {
      const profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      const adapter = await waitUntil(() => instances.find(candidate =>
        candidate.session.id === response.value.sessionId
      ))
      await waitUntil(() => adapter.sent.length === 1)
      await handlers.get('summary:cancel')({}, response.value.report.id)
      await waitUntil(() => adapter.disposed)

      const updatedModel = mutateBoundProfile({ profile, executorId, codexHome })
      await handlers.get('session:restart')({}, response.value.sessionId)
      const restarted = await waitUntil(() => instances.find(candidate =>
        candidate !== adapter && candidate.session.id === response.value.sessionId
      ))
      assert.equal(restarted.session.model, updatedModel, executorId)
      assert.equal(restarted.startCalls, 1, executorId)
      assert.equal(
        await handlers.get('session:start-adapter')({}, response.value.sessionId),
        true,
        executorId
      )
      assert.equal(restarted.startCalls, 2, executorId)
    })
  }
})

test('interactive summary rejects changed-but-ready profiles held at hook readiness without retaining capability', async t => {
  for (const executorId of ['claude', 'codex']) {
    const hookReady = holdHookReady()
    await withInteractiveOrchestrator(t, { hookReady }, async ({ handlers, instances, codexHome }) => {
      const profile = await createBoundProfile(handlers, executorId)
      const response = await handlers.get('summary:start-interactive')({}, interactiveRequest({
        executorId, profileId: profile.id, model: null
      }))
      const adapter = await waitUntil(() => instances.find(candidate =>
        candidate.session.id === response.value.sessionId
      ))
      await waitUntil(() => hookReady.observed, { timeoutMs: 500 })
      const updatedModel = mutateBoundProfile({ profile, executorId, codexHome })
      hookReady.release()
      await waitUntil(async () => {
        const result = await handlers.get('summary:get-report')({}, response.value.report.id)
        return result.value?.status === 'failed'
      })
      assert.equal(adapter.startCalls || 0, 0, executorId)
      assert.equal(adapter.sent.length, 0, executorId)
      await waitUntil(() => adapter.disposed)
      assert.equal(adapter.disposeCalls, 1, executorId)

      await handlers.get('session:restart')({}, response.value.sessionId)
      const restarted = await waitUntil(() => instances.find(candidate =>
        candidate !== adapter && candidate.session.id === response.value.sessionId
      ))
      assert.equal(restarted.session.model, updatedModel, executorId)
      assert.equal(restarted.startCalls, 1, executorId)
      assert.equal(
        await handlers.get('session:start-adapter')({}, response.value.sessionId),
        true,
        executorId
      )
      assert.equal(restarted.startCalls, 2, executorId)
    })
  }
})

test('public session creation rejects forged interactive profile capabilities', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    assert.throws(
      () => handlers.get('session:create')({}, {
        adapterId: 'claude',
        cwd: process.cwd(),
        profileId: 'renderer-profile-id',
        interactiveProfileSnapshot: {
          adapterId: 'claude',
          profileId: 'renderer-profile-id',
          runtimeRevision: 'forged',
          profileEnvironment: { API_KEY: 'renderer-secret' },
          profileLaunch: { args: ['--dangerous-renderer-arg'], env: { TOKEN: 'renderer-secret' } }
        }
      }),
      /interactive profile capability/i
    )
    assert.throws(
      () => handlers.get('session:create')({}, {
        adapterId: 'claude',
        cwd: process.cwd(),
        profileId: 'renderer-profile-id',
        interactiveProfileToken: 'forged-renderer-token'
      }),
      /interactive profile capability/i
    )
    assert.equal(instances.length, 0)
  })
})

test('session deletion clears ownership even when adapter disposal rejects', async t => {
  await withInteractiveOrchestrator(t, {}, async ({ handlers, instances }) => {
    const response = await handlers.get('summary:start-interactive')({}, interactiveRequest())
    assert.equal(response.ok, true)
    const adapter = await waitUntil(() => instances[0])
    await waitUntil(() => adapter.sent.length === 1)
    adapter.throwOnDispose = true
    await assert.rejects(
      handlers.get('session:delete')({}, response.value.sessionId),
      /private adapter disposal failure/
    )
    assert.equal(
      handlers.get('session:list')().some(session => session.id === response.value.sessionId),
      false
    )
  })
})

test('summary cancellation prefers interactive jobs, falls back to headless, and types inactivity', async () => {
  const calls = []
  const interactiveJobService = {
    isActive: reportId => reportId === 'interactive',
    async cancel(reportId) { calls.push(`interactive:${reportId}`); return true }
  }
  const headlessJobService = {
    async cancel(reportId) {
      calls.push(`headless:${reportId}`)
      return reportId === 'headless'
    }
  }

  assert.equal(await cancelActiveSummary('interactive', {
    interactiveJobService, headlessJobService
  }), true)
  assert.deepEqual(calls, ['interactive:interactive'])

  assert.equal(await cancelActiveSummary('headless', {
    interactiveJobService, headlessJobService
  }), true)
  assert.deepEqual(calls.slice(1), ['headless:headless'])

  await assert.rejects(
    cancelActiveSummary('missing', { interactiveJobService, headlessJobService }),
    error => error.code === 'SUMMARY_JOB_NOT_ACTIVE'
  )
  assert.deepEqual(calls.slice(2), ['headless:missing'])
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
    reportId: 'report-1', status: 'running', phase: 'cache-check', completed: 0, total: 1,
    text: '正在检查缓存'
  })
})

test('interactive progress exposes only the fixed safe recoverable fields', () => {
  const payload = summaryProgressPayload({
    id: 'report-1', status: 'running', runPhase: 'awaiting-delivery',
    sessionId: 'session-secret', workspace: 'C:\\private', prompt: 'raw prompt',
    transcript: 'raw transcript', errorText: 'raw error'
  })
  assert.deepEqual(Object.keys(payload).sort(), [
    'completed', 'phase', 'reportId', 'status', 'text', 'total'
  ].sort())
  assert.deepEqual(payload, {
    reportId: 'report-1', status: 'running', phase: 'awaiting-delivery',
    completed: 0, total: 1, text: '正在投递生成指令'
  })
  assert.doesNotMatch(JSON.stringify(payload), /session-secret|private|prompt|transcript|raw error/i)
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
  await api.startInteractiveSummary({ periodType: 'week' })
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
    ...CHANNELS.slice(0, 6), 'summary:generate', ...CHANNELS.slice(6)
  ])
  assert.deepEqual(invocations[6], ['summary:generate', {
    reportId: 'r1', confirm: true, confirmationCallLimit: 24
  }])
  assert.deepEqual(invocations[5], ['summary:start-interactive', { periodType: 'week' }])
  assert.deepEqual(invocations[7], ['summary:list-worklogs'])
  assert.deepEqual(invocations[8], ['summary:read-worklog', '2026-W33-summary.md'])
  assert.deepEqual(progress, [{ reportId: 'r1', phase: 'mapping' }])
  assert.equal(listeners.has('summary:progress'), false)

  const rendererIpc = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
  assert.match(rendererIpc, /startInteractiveSummary:\s*\(value\)\s*=>\s*u\.startInteractiveSummary\(value\)/)
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
