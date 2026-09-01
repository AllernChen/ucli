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

test('summary lifecycle interrupts stale jobs before recovery, legacy import, maintenance, and catch-up', async () => {
  const events = []
  const errors = []
  await runSummaryStartupLifecycle({
    recoverWorkspaces: async () => { events.push('workspace-recover'); return { interrupted: 1, removed: 2 } },
    importLegacyWorkLogs: async () => { events.push('legacy-import'); return { scanned: 1, imported: 1, existing: 0, rejected: 0 } },
    maintainCache: async () => { events.push('cache-prune'); return { removed: 3, bytes: 64 } },
    interruptStaleJobs: async () => { events.push('job-interrupt'); return { interrupted: 1 } },
    startScheduler: async () => { events.push('scheduler') },
    onEvent: event => errors.push(event)
  })
  assert.deepEqual(events, ['job-interrupt', 'workspace-recover', 'legacy-import', 'cache-prune', 'scheduler'])
  assert.deepEqual(errors, [])
})

test('legacy work log import failure is safe and does not bypass critical recovery or scheduler', async () => {
  const events = []
  const logs = []
  const result = await runSummaryStartupLifecycle({
    interruptStaleJobs: async () => { events.push('interrupt') },
    recoverWorkspaces: async () => { events.push('workspace') },
    importLegacyWorkLogs: async () => {
      events.push('legacy-import')
      throw Object.assign(new Error('C:\\private\\workLogs\\report.md'), {
        code: 'SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED'
      })
    },
    maintainCache: async () => { events.push('cache') },
    startScheduler: async () => { events.push('scheduler') },
    onEvent: event => logs.push(event)
  })
  assert.deepEqual(result, { ready: true })
  assert.deepEqual(events, ['interrupt', 'workspace', 'legacy-import', 'cache', 'scheduler'])
  assert.deepEqual(logs, [{ phase: 'legacy-worklog-import', code: 'SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED' }])
  assert.doesNotMatch(JSON.stringify(logs), /private|workLogs|report\.md/i)
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
  assert.deepEqual(events, ['interrupt', 'workspace', 'cache', 'scheduler'])
  assert.deepEqual(logs, [{ phase: 'cache-maintenance', code: 'SUMMARY_CACHE_ENTRY_INVALID' }])
  assert.doesNotMatch(JSON.stringify(logs), /private|cache key|prompt|secret/i)
})

test('critical summary recovery failures skip maintenance and scheduler and report not-ready', async () => {
  for (const failedPhase of ['interrupt', 'workspace']) {
    const calls = []
    const errors = []
    const result = await runSummaryStartupLifecycle({
      interruptStaleJobs: async () => {
        calls.push('interrupt')
        if (failedPhase === 'interrupt') throw new Error('private database path')
      },
      recoverWorkspaces: async () => {
        calls.push('workspace')
        if (failedPhase === 'workspace') throw new Error('private workspace path')
      },
      maintainCache: async () => { calls.push('maintenance') },
      startScheduler: async () => { calls.push('scheduler') },
      onEvent: event => errors.push(event)
    })
    assert.deepEqual(result, { ready: false })
    assert.deepEqual(calls, failedPhase === 'interrupt'
      ? ['interrupt']
      : ['interrupt', 'workspace'])
    assert.equal(errors.length, 1)
    assert.doesNotMatch(JSON.stringify(errors), /private|path/i)
  }
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

test('shared quota maintenance prunes expired workspaces, cache, then completed workspaces', async () => {
  const calls = []
  let workspaceBytes = 80
  let cacheBytes = 50
  const result = await runSummaryMaintenance({
    quotaBytes: 100,
    pruneExpiredWorkspaces: async () => { calls.push('expired'); workspaceBytes = 70; return { removed: 1, bytes: 10 } },
    pruneOrphanWorkspaces: async () => { calls.push('orphans'); return { checked: 2, removed: 1, bytes: 5 } },
    getWorkspaceUsage: async () => ({ bytes: workspaceBytes }),
    pruneCache: async maxBytes => { calls.push(`cache:${maxBytes}`); cacheBytes = 30; return { removed: 2, bytes: cacheBytes } },
    getCacheUsage: async () => ({ bytes: cacheBytes }),
    pruneCompletedWorkspaces: async maxBytes => { calls.push(`completed:${maxBytes}`); workspaceBytes = 60; return { removed: 1, bytes: workspaceBytes } }
  })
  assert.deepEqual(calls, ['expired', 'orphans', 'cache:30', 'completed:70'])
  assert.deepEqual(result.orphans, { checked: 2, removed: 1, bytes: 5 })
  assert.deepEqual(result.total, { bytes: 90, quotaBytes: 100, overQuotaBytes: 0 })
})

test('summary stale interruption and recovery happen before scheduler catch-up accepts work', () => {
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const persistence = orchestrator.indexOf('const db = await openDb(dbPath')
  const initializeAutomation = orchestrator.indexOf('await initSummaryAutomation(db)', persistence)
  const automationFactory = orchestrator.indexOf('async function initSummaryAutomation(db)')
  const jobService = orchestrator.indexOf('interactiveSummaryJobService = createInteractiveSummaryJobService')
  const scheduler = orchestrator.indexOf('summaryScheduler = createSummaryScheduler')
  const lifecycle = orchestrator.indexOf('await runSummaryStartupLifecycle({', scheduler)
  const interrupt = orchestrator.indexOf('interruptStaleJobs:', lifecycle)
  const workspaceRecovery = orchestrator.indexOf('recoverWorkspaces:', interrupt)
  const cacheMaintenance = orchestrator.indexOf('maintainCache:', workspaceRecovery)
  const legacyImport = orchestrator.indexOf('importLegacyWorkLogs:', workspaceRecovery)
  const catchUp = orchestrator.indexOf('startScheduler:', cacheMaintenance)

  assert.ok(persistence >= 0 && initializeAutomation > persistence)
  assert.ok(automationFactory >= 0 && jobService > automationFactory)
  assert.ok(scheduler > jobService && lifecycle > scheduler)
  assert.ok(interrupt > lifecycle && workspaceRecovery > interrupt)
  assert.ok(legacyImport > workspaceRecovery && cacheMaintenance > legacyImport && catchUp > cacheMaintenance)
})

test('summary cache fingerprints fall back to server connection revisions', () => {
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  assert.match(
    orchestrator,
    /profile\?\.updatedAt \|\| profile\?\.runtimeRevision \|\| profile\?\.connectionRevision \|\| null/
  )
})

test('orchestrator stops summary catch-up before gateway and database shutdown', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const shutdown = source.indexOf('function shutdown()')
  const schedulerStop = source.indexOf('await summaryScheduler?.stop()', shutdown)
  const interactiveStop = source.indexOf("await interactiveSummaryJobService?.interruptAll('SUMMARY_APP_SHUTDOWN')", schedulerStop)
  const jobsStop = source.indexOf('await summaryJobService?.shutdown()', interactiveStop)
  const compactWorkspaces = source.indexOf('await summaryWorkspaceService?.recover()', jobsStop)
  const gatewayStop = source.indexOf('await gatewayManager?.shutdown()', compactWorkspaces)
  const databaseFlush = source.indexOf('db.flush()', gatewayStop)

  assert.ok(shutdown >= 0 && schedulerStop > shutdown)
  assert.ok(interactiveStop > schedulerStop && jobsStop > interactiveStop)
  assert.ok(compactWorkspaces > jobsStop)
  assert.ok(gatewayStop > compactWorkspaces && databaseFlush > gatewayStop)
})

test('orchestrator closes Skills batch admission, shuts down the catalog, and drains batches before discarding either', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const shutdown = source.indexOf('function shutdown()')
  const closeBatch = source.indexOf('const skillsBatchDrain = skillsBatchCoordinator?.shutdown()', shutdown)
  const closeCatalog = source.indexOf('await serverSkillsCatalog?.shutdown()', closeBatch)
  const drainBatch = source.indexOf('await skillsBatchDrain', closeCatalog)
  const clearBatch = source.indexOf('skillsBatchCoordinator = null', drainBatch)
  const clearCatalog = source.indexOf('serverSkillsCatalog = null', clearBatch)

  assert.ok(shutdown >= 0 && closeBatch > shutdown)
  assert.ok(closeCatalog > closeBatch && drainBatch > closeCatalog)
  assert.ok(clearBatch > drainBatch && clearCatalog > clearBatch)
})

test('main stops update timers before asynchronous application shutdown', () => {
  const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  const shutdown = source.indexOf("app.on('before-quit'")
  const stopUpdates = source.indexOf('updateService?.stop()', shutdown)
  const stopOrchestrator = source.indexOf('await orchestrator?.shutdown()', shutdown)

  assert.ok(shutdown >= 0 && stopUpdates > shutdown)
  assert.ok(stopOrchestrator > stopUpdates)
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
