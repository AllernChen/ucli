import assert from 'node:assert/strict'
import test from 'node:test'

import { createReportRepository } from '../electron/summaries/reportRepository.js'
import { createSummaryJobService } from '../electron/summaries/summaryJobService.js'

class MemoryDb {
  constructor() {
    this.rows = []
  }

  createSummaryReport(report) {
    this.rows.push(structuredClone(report))
    return structuredClone(report)
  }

  updateSummaryReport(id, patch) {
    const row = this.rows.find(item => item.id === id)
    Object.assign(row, structuredClone(patch))
    return structuredClone(row)
  }

  getSummaryReport(id) {
    const row = this.rows.find(item => item.id === id)
    return row ? structuredClone(row) : null
  }

  listSummaryReports(filters = {}) {
    return this.rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
      .map(row => structuredClone(row))
  }

  async setCurrentSummaryReport(id) {
    const target = this.rows.find(item => item.id === id)
    for (const row of this.rows) {
      if (row.periodType === target.periodType && row.periodStart === target.periodStart &&
        row.periodEndExclusive === target.periodEndExclusive && row.timezone === target.timezone) {
        row.isCurrent = row.id === id
      }
    }
    return structuredClone(target)
  }
}

function request(overrides = {}) {
  return {
    periodType: 'week',
    start: 100,
    endExclusive: 200,
    timezone: 'Asia/Shanghai',
    partial: false,
    executorId: 'claude',
    profileId: null,
    model: 'sonnet',
    generatedBy: 'manual',
    ...overrides
  }
}

test('report repository assigns monotonic versions per logical key and validates JSON fields', () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({ db, now: () => 1000, idFactory: () => `r${++id}` })

  const first = repository.createQueued(request())
  const second = repository.createQueued(request())
  const otherZone = repository.createQueued(request({ timezone: 'UTC' }))
  assert.deepEqual([first.version, second.version, otherZone.version], [1, 2, 1])
  assert.deepEqual(first.usageSnapshot, {})
  assert.deepEqual(first.coverage, {})
  assert.deepEqual(first.generationUsage, {})

  db.rows[0].coverage = '{"sessionsIncluded":2}'
  assert.deepEqual(repository.get(first.id).coverage, { sessionsIncluded: 2 })
  db.rows[0].generationUsage = '[]'
  assert.throws(
    () => repository.get(first.id),
    error => error.code === 'INVALID_SUMMARY_REPORT_JSON'
  )
  assert.throws(
    () => repository.update(second.id, { usageSnapshot: [] }),
    error => error.code === 'INVALID_SUMMARY_REPORT_JSON'
  )
  assert.throws(
    () => repository.update(second.id, { providerRawOutput: 'secret' }),
    error => error.code === 'SUMMARY_REPORT_FIELD_FORBIDDEN'
  )
  assert.throws(
    () => repository.createQueued(request({ periodType: 'hour' })),
    error => error.code === 'INVALID_SUMMARY_REPORT'
  )
  assert.throws(
    () => repository.update(second.id, { coverage: { evidence: 'raw transcript' } }),
    error => error.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN'
  )
  assert.throws(
    () => repository.update(second.id, { status: 'done' }),
    error => error.code === 'INVALID_SUMMARY_REPORT'
  )
  assert.equal(db.getSummaryReport(second.id).status, 'queued')
})

function evidence(text = 'work') {
  return {
    blocks: [{ id: 'evidence:s1', projectPath: '/work/a', text }],
    coverage: { sessionsIncluded: 1 }
  }
}

function pipelineResult(markdown = '## 摘要\n完成') {
  return {
    value: { executiveSummary: '完成' },
    markdown,
    generationUsage: { inputTokens: 10, outputTokens: 2, costUsd: null }
  }
}

function createHarness(overrides = {}) {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({ db, now: () => 1000 + id, idFactory: () => `r${++id}` })
  const service = createSummaryJobService({
    repository,
    evidenceCollector: { async collect() { return evidence() } },
    snapshotUsage: async () => ({ totals: { inputTokens: 30, outputTokens: 5 } }),
    pipeline: { async run() { return pipelineResult() } },
    listSessions: () => [{ id: 's1' }],
    defaultTimezone: 'Asia/Shanghai',
    ...overrides
  })
  return { db, repository, service }
}

test('jobs persist queued and running transitions while executing only one pipeline at a time', async () => {
  let active = 0
  let maxActive = 0
  const transitions = []
  const { service, repository } = createHarness({
    pipeline: {
      async run() {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active -= 1
        return pipelineResult()
      }
    }
  })
  service.subscribe(report => transitions.push(`${report.id}:${report.status}`))

  const first = service.generate(request())
  const second = service.generate(request())
  const [firstResult, secondResult] = await Promise.all([first.completion, second.completion])

  assert.equal(maxActive, 1)
  assert.deepEqual([firstResult.version, secondResult.version], [1, 2])
  assert.deepEqual([firstResult.status, secondResult.status], ['completed', 'completed'])
  assert.equal(repository.get(first.reportId).isCurrent, false)
  assert.equal(repository.get(second.reportId).isCurrent, true)
  assert.deepEqual(transitions, [
    'r1:queued', 'r2:queued', 'r1:running', 'r1:completed', 'r2:running', 'r2:completed'
  ])
})

test('pipeline progress is forwarded ephemerally without changing persisted report fields', async () => {
  const events = []
  const { service, repository } = createHarness({
    pipeline: {
      async run({ onProgress }) {
        onProgress({ phase: 'mapping', current: 2, total: 4, evidence: 'must not escape' })
        onProgress({ phase: 'reducing' })
        return pipelineResult()
      }
    }
  })
  service.subscribe((report, progress) => {
    if (progress) events.push({ reportId: report.id, ...progress })
  })

  const job = service.generate(request())
  await job.completion
  assert.deepEqual(events, [
    { reportId: job.reportId, phase: 'mapping', completed: 2, total: 4 },
    { reportId: job.reportId, phase: 'reducing', completed: 0, total: 1 }
  ])
  assert.equal('progress' in repository.get(job.reportId), false)
})

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition was not reached')
}

test('cancelling an active job aborts the pipeline and preserves a cancelled audit row', async () => {
  let observedSignal = null
  const { service, repository } = createHarness({
    pipeline: {
      run({ signal }) {
        observedSignal = signal
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('raw prompt secret'), {
            code: 'SUMMARY_RUNNER_ABORTED',
            rawOutput: 'provider secret'
          })), { once: true })
        })
      }
    }
  })
  const job = service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'running')
  assert.equal(service.cancel(job.reportId), true)
  const report = await job.completion

  assert.equal(observedSignal.aborted, true)
  assert.equal(report.status, 'cancelled')
  assert.equal(repository.get(job.reportId).errorText, 'SUMMARY_CANCELLED')
  assert.doesNotMatch(JSON.stringify(repository.get(job.reportId)), /raw prompt|provider secret/)
})

test('cancellation wins if requested as the pipeline result is resolving', async () => {
  let resolvePipeline
  const pending = new Promise(resolve => { resolvePipeline = resolve })
  const { service, repository } = createHarness({
    pipeline: { run() { return pending } }
  })
  const job = service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'running')
  resolvePipeline(pipelineResult())
  service.cancel(job.reportId)
  const report = await job.completion
  assert.equal(report.status, 'cancelled')
  assert.equal(report.isCurrent, false)
})

test('cancellation wins while usage snapshot is resolving on an empty report', async () => {
  let resolveUsage
  const pendingUsage = new Promise(resolve => { resolveUsage = resolve })
  const { service, repository } = createHarness({
    evidenceCollector: {
      async collect() { return { blocks: [], coverage: { sessionsIncluded: 0 } } }
    },
    snapshotUsage: () => pendingUsage
  })
  const job = service.generate(request())
  await waitFor(() => repository.get(job.reportId).sourceHash !== null)

  service.cancel(job.reportId)
  resolveUsage({ totals: { inputTokens: 0 } })
  const report = await job.completion

  assert.equal(report.status, 'cancelled')
  assert.equal(report.isCurrent, false)
})

test('service startup marks stale queued, running, and awaiting reports interrupted', () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({ db, idFactory: () => `stale-${++id}` })
  const queued = repository.createQueued(request())
  const running = repository.createQueued(request())
  repository.update(running.id, { status: 'running' })
  const awaiting = repository.createQueued(request())
  repository.update(awaiting.id, { status: 'awaiting_confirmation' })

  createSummaryJobService({
    repository,
    evidenceCollector: { async collect() { return evidence() } },
    snapshotUsage: async () => ({}),
    pipeline: { async run() { return pipelineResult() } }
  })

  assert.equal(repository.get(queued.id).status, 'interrupted')
  assert.equal(repository.get(running.id).status, 'interrupted')
  assert.equal(repository.get(awaiting.id).status, 'interrupted')
  assert.equal(repository.get(running.id).errorText, 'SUMMARY_PROCESS_RESTARTED')
})

test('empty evidence snapshots usage but becomes skipped_empty without AI calls', async () => {
  let usageCalls = 0
  let aiCalls = 0
  const { service, repository } = createHarness({
    evidenceCollector: {
      async collect() { return { blocks: [], coverage: { sessionsIncluded: 0 } } }
    },
    snapshotUsage: async () => { usageCalls += 1; return { totals: { inputTokens: 0 } } },
    pipeline: { async run() { aiCalls += 1; return pipelineResult() } }
  })
  const job = service.generate(request())
  const result = await job.completion

  assert.equal(result.status, 'skipped_empty')
  assert.equal(usageCalls, 1)
  assert.equal(aiCalls, 0)
  assert.deepEqual(repository.get(job.reportId).coverage, { sessionsIncluded: 0 })
  assert.deepEqual(repository.get(job.reportId).usageSnapshot, { totals: { inputTokens: 0 } })
})

test('a failed regeneration leaves the previous completed version current and stores no raw error', async () => {
  let calls = 0
  const { service, repository } = createHarness({
    pipeline: {
      async run() {
        calls += 1
        if (calls === 1) return pipelineResult('version one')
        throw Object.assign(new Error('prompt and provider raw secret'), {
          code: 'SUMMARY_PROVIDER_FAILED',
          rawOutput: 'secret output'
        })
      }
    }
  })
  const first = service.generate(request())
  const firstResult = await first.completion
  const second = service.generate(request())
  const secondResult = await second.completion

  assert.equal(firstResult.isCurrent, true)
  assert.equal(secondResult.version, 2)
  assert.equal(secondResult.status, 'failed')
  assert.equal(secondResult.isCurrent, false)
  assert.equal(repository.get(first.reportId).isCurrent, true)
  assert.equal(secondResult.errorText, 'SUMMARY_PROVIDER_FAILED')
  assert.doesNotMatch(JSON.stringify(secondResult), /prompt and provider|secret output/)
})

test('a regenerated version becomes current only after its pipeline succeeds', async () => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { service, repository } = createHarness({
    pipeline: {
      async run() {
        calls += 1
        if (calls === 2) await gate
        return pipelineResult(`version ${calls}`)
      }
    }
  })
  const first = service.generate(request())
  await first.completion
  const second = service.generate(request())
  await waitFor(() => repository.get(second.reportId).status === 'running')
  assert.equal(repository.get(first.reportId).isCurrent, true)
  assert.equal(repository.get(second.reportId).isCurrent, false)
  release()
  const completed = await second.completion
  assert.equal(completed.isCurrent, true)
  assert.equal(repository.get(first.reportId).isCurrent, false)
})

test('automatic generation deduplicates identical source while manual generation creates a new version', async () => {
  let aiCalls = 0
  let collections = 0
  const { service, repository } = createHarness({
    evidenceCollector: {
      async collect() {
        collections += 1
        const blocks = [
          { id: 'evidence:a', projectPath: '/work/a', text: 'alpha' },
          { id: 'evidence:b', projectPath: '/work/b', text: 'beta' }
        ]
        return { blocks: collections % 2 ? blocks : [...blocks].reverse(), coverage: {} }
      }
    },
    pipeline: { async run() { aiCalls += 1; return pipelineResult(`call ${aiCalls}`) } }
  })
  const first = service.generate(request())
  await first.completion

  const automatic = service.generate(request({ generatedBy: 'automatic' }))
  const automaticResult = await automatic.completion
  assert.equal(automaticResult.status, 'skipped_empty')
  assert.match(automaticResult.errorText, /^SUMMARY_AUTOMATIC_DUPLICATE:/)
  assert.equal(aiCalls, 1)
  assert.equal(repository.get(first.reportId).isCurrent, true)

  const manual = service.generate(request({ generatedBy: 'manual' }))
  const manualResult = await manual.completion
  assert.equal(manualResult.version, 3)
  assert.equal(manualResult.status, 'completed')
  assert.equal(aiCalls, 2)
  assert.equal(manualResult.isCurrent, true)
})

test('manual preflight persists awaiting_confirmation and resumes only through explicit confirmation', async () => {
  const calls = []
  const { service, repository } = createHarness({
    pipeline: {
      async run(options) {
        calls.push(options)
        if (!options.confirmed) {
          return {
            requiresConfirmation: true,
            estimatedCalls: 24,
            callLimit: 20,
            confirmationCallLimit: 24
          }
        }
        assert.equal(options.confirmedCallLimit, 24)
        return pipelineResult()
      }
    }
  })
  const job = service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'awaiting_confirmation')
  assert.equal(calls.length, 1)
  assert.equal(repository.get(job.reportId).errorText, 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED')
  assert.equal(service.getConfirmationCallLimit(job.reportId), 24)

  const resumed = service.confirm(job.reportId)
  assert.equal(resumed.completion, job.completion)
  const completed = await resumed.completion
  assert.equal(calls.length, 2)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.isCurrent, true)
  assert.equal(service.getConfirmationCallLimit(job.reportId), null)
})

test('a dynamic confirmation error fails safely instead of pretending a costly restart is continuation', async () => {
  let calls = 0
  const { service, repository } = createHarness({
    pipeline: {
      async run() {
        calls += 1
        throw Object.assign(new Error('additional calls required'), {
          code: 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED',
          requiresConfirmation: true,
          confirmationCallLimit: 21
        })
      }
    }
  })
  const job = service.generate(request())
  const report = await job.completion
  assert.equal(report.status, 'failed')
  assert.equal(report.errorText, 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED')
  assert.equal(calls, 1)
  assert.throws(
    () => service.confirm(job.reportId),
    error => error.code === 'SUMMARY_CONFIRMATION_CONTEXT_MISSING'
  )
  assert.equal(repository.get(job.reportId).status, 'failed')
})

test('job order is queued persistence, evidence coverage, usage snapshot, pipeline, then current', async () => {
  const order = []
  const db = new MemoryDb()
  const originalCreate = db.createSummaryReport.bind(db)
  db.createSummaryReport = report => { order.push('queued'); return originalCreate(report) }
  const originalCurrent = db.setCurrentSummaryReport.bind(db)
  db.setCurrentSummaryReport = async id => { order.push('current'); return originalCurrent(id) }
  const repository = createReportRepository({ db, idFactory: () => 'ordered' })
  const service = createSummaryJobService({
    repository,
    evidenceCollector: { async collect() { order.push('collect'); return evidence() } },
    snapshotUsage: async () => { order.push('usage'); return { totals: {} } },
    pipeline: { async run() { order.push('pipeline'); return pipelineResult() } }
  })
  const job = service.generate(request())
  await job.completion
  assert.deepEqual(order, ['queued', 'collect', 'usage', 'pipeline', 'current'])
})
