import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { startMainWindowLifecycle } from '../electron/startupLifecycle.js'
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

test('summary recovery happens after persistence and before scheduler catch-up', () => {
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const jobs = readFileSync(
    new URL('../electron/summaries/summaryJobService.js', import.meta.url),
    'utf8'
  )
  const persistence = orchestrator.indexOf('const db = await openDb(dbPath')
  const initializeAutomation = orchestrator.indexOf('await initSummaryAutomation(db)', persistence)
  const automationFactory = orchestrator.indexOf('async function initSummaryAutomation(db)')
  const jobService = orchestrator.indexOf('summaryJobService = createSummaryJobService')
  const scheduler = orchestrator.indexOf('summaryScheduler = createSummaryScheduler')
  const catchUp = orchestrator.indexOf('await summaryScheduler.start()')
  const interrupt = jobs.indexOf('repository.interruptStale()')
  const generate = jobs.indexOf('generate(input)')

  assert.ok(persistence >= 0 && initializeAutomation > persistence)
  assert.ok(automationFactory >= 0 && jobService > automationFactory)
  assert.ok(scheduler > jobService && catchUp > scheduler)
  assert.ok(interrupt >= 0 && generate > interrupt)
})

test('orchestrator stops summary catch-up before gateway and database shutdown', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const shutdown = source.indexOf('function shutdown()')
  const schedulerStop = source.indexOf('await summaryScheduler?.stop()', shutdown)
  const gatewayStop = source.indexOf('await gatewayManager?.shutdown()', shutdown)
  const databaseFlush = source.indexOf('db.flush()', gatewayStop)

  assert.ok(shutdown >= 0 && schedulerStop > shutdown)
  assert.ok(gatewayStop > schedulerStop && databaseFlush > gatewayStop)
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
