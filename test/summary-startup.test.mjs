import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  runSummaryMaintenance,
  runSummaryStartupLifecycle,
  startMainWindowLifecycle
} from '../electron/startupLifecycle.js'
import {
  createSummaryOperationalLogEntry,
  safeSummaryErrorCode
} from '../electron/summaries/operationalLog.js'

test('summary startup failure is typed and never blocks the main window', async () => {
  const events = []
  const errors = []
  await startMainWindowLifecycle({
    orchestrator: {
      async initPersistence() {
        events.push('persistence')
        throw Object.assign(new Error('prompt transcript credential'), {
          code: 'SUMMARY_STARTUP_FAILED'
        })
      },
      async startGateway() { events.push('gateway') },
      registerIpc() { events.push('ipc') }
    },
    beforeWindow() { events.push('before-window') },
    openWindow() { events.push('window') },
    onError(error) { errors.push(error) }
  })

  assert.deepEqual(events, [
    'persistence', 'gateway', 'ipc', 'before-window', 'window'
  ])
  assert.deepEqual(errors, [{ phase: 'persistence', code: 'SUMMARY_STARTUP_FAILED' }])
  assert.doesNotMatch(JSON.stringify(errors), /prompt|transcript|credential/)
})

test('summary lifecycle orders recovery, cache maintenance, stale interruption, and catch-up', async () => {
  const events = []
  const errors = []
  await runSummaryStartupLifecycle({
    recoverWorkspaces: async () => { events.push('workspace-recover'); return { interrupted: 1, removed: 2 } },
    maintainCache: async () => { events.push('cache-prune'); return { removed: 3, bytes: 64 } },
    interruptStaleJobs: async () => { events.push('job-interrupt'); return { interrupted: 1 } },
    startScheduler: async () => { events.push('scheduler') },
    onEvent: event => errors.push(event)
  })
  assert.deepEqual(events, ['workspace-recover', 'cache-prune', 'job-interrupt', 'scheduler'])
  assert.deepEqual(errors, [])
})

test('summary startup maintenance failures are typed and never block scheduler or expose details', async () => {
  const events = []
  const logs = []
  await runSummaryStartupLifecycle({
    recoverWorkspaces: async () => { events.push('workspace') },
    maintainCache: async () => {
      events.push('cache')
      throw Object.assign(new Error('C:\\private cache key prompt'), {
        code: 'SUMMARY_CACHE_ENTRY_INVALID', cacheKey: 'secret'
      })
    },
    interruptStaleJobs: async () => { events.push('interrupt') },
    startScheduler: async () => { events.push('scheduler') },
    onEvent: event => logs.push(event)
  })
  assert.deepEqual(events, ['workspace', 'cache', 'interrupt', 'scheduler'])
  assert.deepEqual(logs, [{ phase: 'cache-maintenance', code: 'SUMMARY_CACHE_ENTRY_INVALID' }])
  assert.doesNotMatch(JSON.stringify(logs), /private|cache key|prompt|secret/i)
})

test('daily maintenance isolates workspace and cache phases and exposes only safe counters', async () => {
  const events = []
  const result = await runSummaryMaintenance({
    pruneExpiredWorkspaces: async () => {
      throw Object.assign(new Error('C:\\private prompt'), { code: 'SUMMARY_WORKSPACE_PRUNE_FAILED' })
    },
    pruneCache: async () => ({ removed: 3, bytes: 64, key: 'secret', path: 'C:\\private' }),
    onEvent: event => events.push(event)
  })
  assert.deepEqual(result, {
    workspaces: null,
    cache: { removed: 3, bytes: 64 }
  })
  assert.deepEqual(events, [{
    phase: 'workspace-prune', code: 'SUMMARY_WORKSPACE_PRUNE_FAILED'
  }])
  assert.doesNotMatch(JSON.stringify([result, events]), /private|prompt|secret|key|path/i)
})

test('summary recovery happens after persistence and before scheduler catch-up', () => {
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const persistence = orchestrator.indexOf('const db = await openDb(dbPath')
  const initializeAutomation = orchestrator.indexOf('await initSummaryAutomation(db)', persistence)
  const automationFactory = orchestrator.indexOf('async function initSummaryAutomation(db)')
  const jobService = orchestrator.indexOf('summaryJobService = createSummaryJobService')
  const scheduler = orchestrator.indexOf('summaryScheduler = createSummaryScheduler')
  const lifecycle = orchestrator.indexOf('await runSummaryStartupLifecycle({', scheduler)
  const workspaceRecovery = orchestrator.indexOf('recoverWorkspaces:', lifecycle)
  const cacheMaintenance = orchestrator.indexOf('maintainCache:', workspaceRecovery)
  const interrupt = orchestrator.indexOf('interruptStaleJobs:', cacheMaintenance)
  const catchUp = orchestrator.indexOf('startScheduler:', interrupt)

  assert.ok(persistence >= 0 && initializeAutomation > persistence)
  assert.ok(automationFactory >= 0 && jobService > automationFactory)
  assert.ok(scheduler > jobService && lifecycle > scheduler)
  assert.ok(workspaceRecovery > lifecycle && cacheMaintenance > workspaceRecovery)
  assert.ok(interrupt > cacheMaintenance && catchUp > interrupt)
})

test('orchestrator stops summary catch-up before gateway and database shutdown', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const shutdown = source.indexOf('function shutdown()')
  const schedulerStop = source.indexOf('await summaryScheduler?.stop()', shutdown)
  const jobsStop = source.indexOf('await summaryJobService?.shutdown()', schedulerStop)
  const compactWorkspaces = source.indexOf('await summaryWorkspaceService?.recover()', jobsStop)
  const gatewayStop = source.indexOf('await gatewayManager?.shutdown()', compactWorkspaces)
  const databaseFlush = source.indexOf('db.flush()', gatewayStop)

  assert.ok(shutdown >= 0 && schedulerStop > shutdown)
  assert.ok(jobsStop > schedulerStop && compactWorkspaces > jobsStop)
  assert.ok(gatewayStop > compactWorkspaces && databaseFlush > gatewayStop)
})

test('summary operational logs expose only bounded lifecycle metadata', () => {
  const report = {
    id: 'report-1',
    status: 'running',
    periodType: 'week',
    executorId: 'codex',
    createdAt: 100,
    markdown: 'credential markdown secret',
    prompt: 'raw prompt',
    transcript: 'raw transcript',
    rawOutput: 'raw CLI output'
  }
  const progress = createSummaryOperationalLogEntry(report, {
    phase: 'mapping', completed: 2, total: 5,
    text: 'secret display text'
  }, { now: () => 600 })

  assert.deepEqual(progress, {
    reportId: 'report-1',
    phase: 'mapping',
    cadence: 'week',
    executor: 'codex',
    elapsedMs: 500,
    completedChunks: 2,
    totalChunks: 5,
    code: null
  })
  const failed = createSummaryOperationalLogEntry({
    ...report,
    status: 'failed',
    errorText: 'SUMMARY_PROVIDER_FAILED:raw-sensitive-detail'
  }, null, { now: () => 700 })
  assert.equal(failed.code, 'SUMMARY_PROVIDER_FAILED')
  assert.doesNotMatch(
    JSON.stringify([progress, failed]),
    /credential|markdown|prompt|transcript|raw CLI|sensitive-detail|display text/
  )
  assert.equal(
    safeSummaryErrorCode('secret credential text', 'SUMMARY_SCHEDULER_START_FAILED'),
    'SUMMARY_SCHEDULER_START_FAILED'
  )
})
