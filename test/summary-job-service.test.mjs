import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { createReportRepository } from '../electron/summaries/reportRepository.js'
import { createSummaryJobService } from '../electron/summaries/summaryJobService.js'
import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`

function artifactMetadata(markdown) {
  return {
    canonical: 'markdown',
    bytes: Buffer.byteLength(markdown),
    sha256: `sha256:${createHash('sha256').update(markdown).digest('hex')}`
  }
}

class MemoryDb {
  constructor() {
    this.rows = []
  }

  createSummaryReport(report) {
    this.rows.push(structuredClone(report))
    return structuredClone(report)
  }

  createQueuedSummaryReport(report) {
    const version = this.rows
      .filter(item => item.periodType === report.periodType &&
        item.periodStart === report.periodStart &&
        item.periodEndExclusive === report.periodEndExclusive &&
        item.timezone === report.timezone)
      .reduce((max, item) => Math.max(max, item.version), 0) + 1
    return this.createSummaryReport({ ...report, version })
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

  async completeSummaryReport(id, patch) {
    const target = this.rows.find(item => item.id === id)
    if (!target || target.status !== 'running') {
      throw Object.assign(new Error('not running'), { code: 'SUMMARY_REPORT_NOT_RUNNING' })
    }
    for (const row of this.rows) {
      if (row.periodType === target.periodType && row.periodStart === target.periodStart &&
        row.periodEndExclusive === target.periodEndExclusive && row.timezone === target.timezone) {
        row.isCurrent = false
      }
    }
    Object.assign(target, structuredClone(patch), { isCurrent: true })
    return structuredClone(target)
  }

  async importCompletedSummaryReport(report) {
    const existing = this.rows.find(item => item.legacyImportKey === report.legacyImportKey)
    if (existing) return { report: structuredClone(existing), imported: false }
    const version = this.rows
      .filter(item => item.periodType === report.periodType &&
        item.periodStart === report.periodStart &&
        item.periodEndExclusive === report.periodEndExclusive &&
        item.timezone === report.timezone)
      .reduce((max, item) => Math.max(max, item.version), 0) + 1
    const created = { ...structuredClone(report), version }
    this.rows.push(created)
    return { report: structuredClone(created), imported: true }
  }

  async deleteSummaryReport(id) {
    const index = this.rows.findIndex(item => item.id === id)
    if (index < 0) throw Object.assign(new Error('missing'), { code: 'SUMMARY_REPORT_NOT_FOUND' })
    const [target] = this.rows.splice(index, 1)
    return { deletedReportId: target.id, currentReportId: null }
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

test('report repository assigns monotonic versions per logical key and validates JSON fields', async () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({ db, now: () => 1000, idFactory: () => `r${++id}` })

  const first = await repository.createQueued(request())
  const second = await repository.createQueued(request())
  const otherZone = await repository.createQueued(request({ timezone: 'UTC' }))
  assert.deepEqual([first.version, second.version, otherZone.version], [1, 2, 1])
  assert.deepEqual(first.usageSnapshot, {})
  assert.deepEqual(first.coverage, {})
  assert.deepEqual(first.generationUsage, {})
  assert.deepEqual(first.generationMetrics, {})

  db.rows[0].coverage = '{"sessionsIncluded":2}'
  assert.deepEqual(repository.get(first.id).coverage, { sessionsIncluded: 2 })
  db.rows[0].generationUsage = '[]'
  assert.deepEqual(repository.get(first.id).generationUsage, {})
  db.rows[0].generationUsage = {}
  await assert.rejects(
    repository.update(second.id, { usageSnapshot: [] }),
    error => error.code === 'INVALID_SUMMARY_REPORT_JSON'
  )
  await assert.rejects(
    repository.update(second.id, { providerRawOutput: 'secret' }),
    error => error.code === 'SUMMARY_REPORT_FIELD_FORBIDDEN'
  )
  await assert.rejects(
    repository.createQueued(request({ periodType: 'hour' })),
    error => error.code === 'INVALID_SUMMARY_REPORT'
  )
  await assert.rejects(
    repository.update(second.id, { coverage: { evidence: 'raw transcript' } }),
    error => error.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN'
  )
  await assert.doesNotReject(repository.update(second.id, {
    coverage: {
      sessionsIncluded: 4,
      sources: { transcript: 4, note: 1, nativeDigest: 0 }
    }
  }))
  assert.deepEqual((await repository.update(second.id, {
    generationMetrics: {
      strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0,
      durationMs: 25, mapConcurrency: 2
    }
  })).generationMetrics, {
    strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0,
    durationMs: 25, mapConcurrency: 2
  })
  for (const generationMetrics of [
    { strategy: 'batch', plannedCalls: 1, aiCalls: 1, cacheHits: 0, durationMs: 1, mapConcurrency: 2 },
    { strategy: 'direct', plannedCalls: -1, aiCalls: 1, cacheHits: 0, durationMs: 1, mapConcurrency: 2 },
    { strategy: 'direct', plannedCalls: 1, aiCalls: 1001, cacheHits: 0, durationMs: 1, mapConcurrency: 2 },
    { strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0, durationMs: -1, mapConcurrency: 2 },
    { strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0, durationMs: 1, mapConcurrency: 4 },
    { strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0, durationMs: 1, mapConcurrency: 2, prompt: 'secret' }
  ]) {
    await assert.rejects(
      repository.update(second.id, { generationMetrics }),
      error => error.code === 'INVALID_SUMMARY_GENERATION_METRICS'
    )
  }
  await assert.rejects(
    repository.update(second.id, { generationMetrics: [] }),
    error => error.code === 'INVALID_SUMMARY_GENERATION_METRICS'
  )
  await assert.rejects(
    repository.update(second.id, { coverage: { sources: { transcript: 'raw transcript' } } }),
    error => error.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN'
  )
  await assert.rejects(
    repository.update(second.id, { status: 'done' }),
    error => error.code === 'INVALID_SUMMARY_REPORT'
  )
  db.rows[0].generationMetrics = {
    strategy: 'direct', aiCalls: 1, prompt: 'legacy unsafe detail'
  }
  assert.deepEqual(repository.get(first.id).generationMetrics, {})
  assert.equal(db.getSummaryReport(second.id).status, 'queued')
})

test('report repository normalizes interactive defaults and rejects invalid run fields', async () => {
  const db = new MemoryDb()
  const repository = createReportRepository({ db, now: () => 1000, idFactory: () => 'r1' })

  const queued = await repository.createQueued(request({
    executionMode: 'interactive-cli',
    sessionId: 'session-1'
  }))
  assert.equal(queued.executionMode, 'interactive-cli')
  assert.equal(queued.sessionId, 'session-1')
  assert.equal(queued.runPhase, 'preparing')
  assert.deepEqual(queued.artifactMetadata, {})
  assert.equal(queued.legacyImportKey, null)

  db.rows.push({
    ...structuredClone(queued),
    id: 'legacy-r1',
    executionMode: undefined,
    sessionId: undefined,
    runPhase: undefined,
    artifactMetadata: undefined,
    legacyImportKey: undefined
  })
  assert.deepEqual(
    (({ executionMode, sessionId, runPhase, artifactMetadata, legacyImportKey }) => ({
      executionMode, sessionId, runPhase, artifactMetadata, legacyImportKey
    }))(repository.get('legacy-r1')),
    {
      executionMode: 'isolated-runner',
      sessionId: null,
      runPhase: null,
      artifactMetadata: {},
      legacyImportKey: null
    }
  )

  for (const patch of [
    { runPhase: 'waiting-forever' },
    { sessionId: '' },
    { artifactMetadata: { transcript: 'secret' } },
    { artifactMetadata: { projectPath: 'D:\\private\\source-project' } },
    { artifactMetadata: { workspacePath: 'C:\\private\\summary-run' } }
  ]) {
    await assert.rejects(
      repository.update(queued.id, patch),
      error => ['SUMMARY_RUN_PHASE_INVALID', 'INVALID_SUMMARY_REPORT',
        'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
    )
  }
  await assert.rejects(
    repository.createQueued(request({ executionMode: 'shared-session' })),
    error => error.code === 'INVALID_SUMMARY_REPORT'
  )
})

test('report repository rejects recursive secrets, tool payloads, and absolute path values', async () => {
  const repository = createReportRepository({
    db: new MemoryDb(), now: () => 1000, idFactory: () => 'r-sensitive'
  })
  const report = await repository.createQueued(request())
  const unsafePatches = [
    { artifactMetadata: { apiKey: 'sk-secret' } },
    { coverage: { nested: { toolPayload: { command: 'rm -rf data' } } } },
    { usageSnapshot: { location: 'C:\\private\\workspace\\report.md' } },
    { coverage: { credential: 'secret' } },
    { coverage: { nested: { prompt: 'raw prompt' } } },
    { coverage: { transcript: 'raw transcript' } },
    { coverage: { message: 'raw message' } },
    { coverage: { nested: { password: 'secret' } } },
    { coverage: { location: '\\\\server\\share\\report.md' } },
    { coverage: { location: '/private/workspace/report.md' } },
    { coverage: { location: 'file:///private/workspace/report.md' } }
  ]

  for (const patch of unsafePatches) {
    const rejectedKey = Object.keys(patch)[0]
    await assert.rejects(
      repository.update(report.id, patch),
      error => error.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN' &&
        !error.message.includes(rejectedKey)
    )
  }
  assert.deepEqual((await repository.update(report.id, {
    usageSnapshot: { totals: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
  })).usageSnapshot, { totals: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
})

test('report repository rejects unknown summary shapes and credential-shaped scalar values', async () => {
  const repository = createReportRepository({
    db: new MemoryDb(), now: () => 1000, idFactory: () => 'r-closed-json'
  })
  const report = await repository.createQueued(request())
  const secretKey = `sk-ant-${'x'.repeat(20)}`
  const awsKey = `AKIA${'A'.repeat(16)}`
  for (const patch of [
    { coverage: { authorization: 'safe-looking' } },
    { coverage: { accessKey: 'safe-looking' } },
    { coverage: { auth: 'safe-looking' } },
    { coverage: { payload: { safe: true } } },
    { coverage: { command: 'git status' } },
    { coverage: { sessionsIncluded: 1, value: secretKey } },
    { usageSnapshot: { totals: { inputTokens: 1 }, value: awsKey } },
    { generationUsage: { inputTokens: 1, outputTokens: 1, extra: 1 } }
  ]) {
    await assert.rejects(
      repository.update(report.id, patch),
      error => ['INVALID_SUMMARY_REPORT_JSON',
        'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
    )
  }
  assert.deepEqual((await repository.update(report.id, {
    coverage: { sessionsIncluded: 1, sources: { transcript: 2, note: 1, nativeDigest: 0 } }
  })).coverage.sources, { transcript: 2, note: 1, nativeDigest: 0 })
})

test('report repository accepts only bounded safe error machine codes', async () => {
  const db = new MemoryDb()
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => 'r-errors'
  })
  const report = await repository.createQueued(request())

  for (const errorText of [
    'C:\\private\\workspace\\report.md',
    'apiKey=sk-secret',
    'raw prompt text',
    'SUMMARY_RUN_FAILED:sk-secret',
    `SUMMARY_RUN_FAILED:AKIA${'A'.repeat(16)}`,
    'SUMMARY_PROVIDER_FAILED',
    'ARBITRARY_UPPERCASE_CODE',
    'SUMMARY_GENERATION_FAILED:leaked-suffix',
    'SUMMARY_AUTOMATIC_DUPLICATE:../../private/report',
    `SUMMARY_AUTOMATIC_DUPLICATE:sk-ant-${'x'.repeat(20)}`,
    `SUMMARY_AUTOMATIC_DUPLICATE:AKIA${'A'.repeat(16)}`
  ]) {
    await assert.rejects(
      repository.update(report.id, { errorText }),
      error => error.code === 'INVALID_SUMMARY_ERROR_CODE' &&
        !error.message.includes(errorText)
    )
  }
  const targetId = '11111111-1111-4111-8111-111111111111'
  db.rows.push({
    ...structuredClone(report), id: targetId, version: 2, status: 'completed',
    markdown: '# Existing', sourceHash: SOURCE_HASH, runPhase: 'completed',
    artifactMetadata: artifactMetadata('# Existing'), isCurrent: true
  })
  db.rows.push({
    ...structuredClone(report), id: '22222222-2222-4222-8222-222222222222',
    version: 3, status: 'running', runPhase: 'running'
  })
  db.rows.push({
    ...structuredClone(report), id: '33333333-3333-4333-8333-333333333333',
    periodStart: 300, periodEndExclusive: 400, status: 'completed',
    markdown: '# Other', sourceHash: SOURCE_HASH, runPhase: 'completed',
    artifactMetadata: artifactMetadata('# Other')
  })
  for (const duplicateTargetId of [
    '44444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'
  ]) {
    await assert.rejects(repository.update(report.id, {
      errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${duplicateTargetId}`
    }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
  }
  await assert.rejects(repository.update(report.id, {
    errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`
  }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
  await repository.update(report.id, {
    generatedBy: 'automatic', sourceHash: `sha256:${'b'.repeat(64)}`
  })
  await assert.rejects(repository.update(report.id, {
    errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`
  }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
  await repository.update(report.id, { sourceHash: SOURCE_HASH })
  assert.equal((await repository.update(report.id, {
    errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`
  })).errorText, `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`)
  for (const patch of [
    { generatedBy: 'manual' },
    { sourceHash: `sha256:${'b'.repeat(64)}` },
    {
      sourceHash: `sha256:${'b'.repeat(64)}`,
      errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`
    }
  ]) {
    await assert.rejects(
      repository.update(report.id, patch),
      error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
    )
  }
  assert.equal((await repository.update(report.id, { errorText: null })).errorText, null)
})

test('completed and imported artifact metadata is exact while active metadata stays empty', async () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `r-artifact-${++id}`
  })
  const queued = await repository.createQueued(request({
    executionMode: 'interactive-cli', sessionId: 'session-1'
  }))
  await assert.rejects(
    repository.update(queued.id, {
      artifactMetadata: artifactMetadata('# Active')
    }),
    error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA'
  )
  await repository.update(queued.id, { status: 'running', runPhase: 'running' })
  for (const invalidMetadata of [
    {},
    { canonical: 'html', bytes: 1, sha256: artifactMetadata('# Completed').sha256 },
    { canonical: 'markdown', bytes: 0, sha256: artifactMetadata('# Completed').sha256 },
    { canonical: 'markdown', bytes: 1, sha256: 'not-a-safe-hash' },
    { ...artifactMetadata('# Completed'), path: '/private/report.md' }
  ]) {
    await assert.rejects(repository.complete(queued.id, {
      markdown: '# Completed', sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
      artifactMetadata: invalidMetadata
    }), error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA')
  }
  await assert.rejects(repository.importCompleted({
    ...request(), markdown: '# Imported', legacyImportKey: 'legacy-invalid-artifact',
    sourceHash: SOURCE_HASH,
    artifactMetadata: { ...artifactMetadata('# Imported'), extra: true }
  }), error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA')
})

test('repository completion and import verify Markdown byte length and digest', async () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `r-integrity-${++id}`
  })
  const queued = await repository.createQueued(request({
    executionMode: 'interactive-cli', sessionId: 'session-integrity'
  }))
  await repository.update(queued.id, { status: 'running', runPhase: 'running' })
  const markdown = '# Integrity'
  const correct = artifactMetadata(markdown)
  for (const metadata of [
    { ...correct, bytes: correct.bytes + 1 },
    { ...correct, sha256: `sha256:${'f'.repeat(64)}` }
  ]) {
    await assert.rejects(repository.complete(queued.id, {
      markdown, sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
      artifactMetadata: metadata
    }), error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA')
  }
  for (const [index, metadata] of [
    { ...correct, bytes: correct.bytes + 1 },
    { ...correct, sha256: `sha256:${'e'.repeat(64)}` }
  ].entries()) {
    await assert.rejects(repository.importCompleted({
      ...request(), markdown, sourceHash: SOURCE_HASH,
      legacyImportKey: `legacy-integrity-${index}`, artifactMetadata: metadata
    }), error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA')
  }
})

test('report repository forbids identity and raw-path patches', async () => {
  const repository = createReportRepository({
    db: new MemoryDb(), now: () => 1000, idFactory: () => 'r1'
  })
  const report = await repository.createQueued(request())

  for (const patch of [
    { version: 2 },
    { periodStart: 0 },
    { workspacePath: 'C:\\private\\summary-run' },
    { rawPath: '/private/summary-run' }
  ]) {
    await assert.rejects(
      repository.update(report.id, patch),
      error => error.code === 'SUMMARY_REPORT_FIELD_FORBIDDEN'
    )
  }
})

test('report repository imports legacy markdown idempotently without changing current report', async () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `r${++id}`
  })
  const current = await repository.createQueued(request())
  await repository.update(current.id, { status: 'running' })
  await repository.complete(current.id, {
    markdown: '# Existing', sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
    artifactMetadata: artifactMetadata('# Existing')
  })
  const input = {
    ...request(),
    markdown: '# Imported',
    legacyImportKey: 'legacy-key-1',
    sourceHash: SOURCE_HASH,
    artifactMetadata: artifactMetadata('# Imported')
  }

  const first = await repository.importCompleted(input)
  const second = await repository.importCompleted(input)

  assert.equal(first.imported, true)
  assert.equal(second.imported, false)
  assert.equal(second.report.id, first.report.id)
  assert.equal(first.report.version, 2)
  assert.equal(first.report.status, 'completed')
  assert.equal(first.report.executionMode, 'legacy-worklog-import')
  assert.equal(first.report.isCurrent, false)
  assert.equal(repository.get(current.id).isCurrent, true)
  assert.equal(repository.listForKey(request()).length, 2)
})

test('report repository completes only running reports with canonical metadata', async () => {
  const db = new MemoryDb()
  const repository = createReportRepository({ db, now: () => 2000, idFactory: () => 'r1' })
  const queued = await repository.createQueued(request({
    executionMode: 'interactive-cli', sessionId: 'session-1'
  }))
  await assert.rejects(repository.update(queued.id, {
    status: 'completed', runPhase: 'completed', markdown: '# Bypass',
    sourceHash: SOURCE_HASH, artifactMetadata: artifactMetadata('# Bypass')
  }), error => error.code === 'INVALID_SUMMARY_STATUS')
  await repository.update(queued.id, { status: 'running', runPhase: 'running' })

  const report = await repository.complete(queued.id, {
    markdown: '# Completed',
    sourceHash: SOURCE_HASH,
    usageSnapshot: { totals: { inputTokens: 1 } },
    coverage: { sessionsIncluded: 1 },
    artifactMetadata: artifactMetadata('# Completed')
  })

  assert.equal(report.status, 'completed')
  assert.equal(report.runPhase, 'completed')
  assert.equal(report.isCurrent, true)
  assert.equal(report.markdown, '# Completed')
  assert.equal(report.errorText, null)
  await assert.rejects(
    repository.complete(report.id, {
      markdown: '# Replaced', sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
      artifactMetadata: artifactMetadata('# Replaced')
    }),
    error => error.code === 'SUMMARY_REPORT_NOT_RUNNING'
  )
})

test('report repository exposes only the normalized deletion result', async () => {
  const db = new MemoryDb()
  const repository = createReportRepository({ db, now: () => 1000, idFactory: () => 'r1' })
  await repository.createQueued(request())
  assert.deepEqual(await repository.delete('r1'), {
    deletedReportId: 'r1', currentReportId: null
  })
  assert.equal(repository.get('r1'), null)
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
    generationUsage: { inputTokens: 10, outputTokens: 2, costUsd: null },
    generationMetrics: {
      strategy: 'direct', plannedCalls: 1, aiCalls: 1, cacheHits: 0,
      durationMs: 25, mapConcurrency: 2
    }
  }
}

test('successful jobs use an opaque persistent workspace then compact it to output and metrics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-workspace-'))
  const pipelineCalls = []
  try {
    const workspaceService = createSummaryWorkspaceService({ root })
    const { service, repository } = createHarness({
      workspaceService,
      evidenceCollector: {
        async collect() {
          return {
            blocks: [
              { id: 'evidence:1', projectPath: 'C:\\secret-project\\alpha', text: 'implemented cache' },
              { id: 'evidence:2', projectPath: 'D:\\secret-project\\beta', text: 'fixed tests' }
            ],
            coverage: { sessionsIncluded: 2 }
          }
        }
      },
      pipeline: {
        async run(options) {
          pipelineCalls.push(options)
          assert.equal(readdirSync(options.workspaceDirectory).length, 0)
          return pipelineResult('workspace summary')
        }
      }
    })

    const job = await service.generate(request())
    const report = await job.completion
    const workspace = join(root, 'workspaces', job.reportId)
    const manifest = JSON.parse(readFileSync(join(workspace, 'manifest.json'), 'utf8'))

    assert.equal(pipelineCalls[0].workspaceDirectory, join(workspace, 'work'))
    assert.equal(report.generationMetrics.aiCalls, 1)
    assert.deepEqual(report.artifactMetadata, {
      canonical: 'markdown',
      bytes: Buffer.byteLength('workspace summary'),
      sha256: `sha256:${createHash('sha256').update('workspace summary').digest('hex')}`
    })
    assert.equal(manifest.status, 'completed')
    assert.deepEqual(manifest.artifacts.map(item => item.path), ['output/summary.md'])
    assert.equal(readFileSync(join(workspace, 'output', 'summary.md'), 'utf8'), 'workspace summary')
    assert.equal(existsSync(join(workspace, 'input')), false)
    assert.equal(existsSync(join(workspace, 'work')), false)
    assert.doesNotMatch(JSON.stringify(manifest), /secret-project|alpha|beta/)
    assert.equal(repository.get(job.reportId).generationMetrics.strategy, 'direct')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed jobs retain bounded redacted inputs with a seven day expiry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-failure-'))
  const now = Date.parse('2026-08-12T00:00:00.000Z')
  try {
    const workspaceService = createSummaryWorkspaceService({ root, now: () => now })
    const { service } = createHarness({
      workspaceService,
      evidenceCollector: {
        async collect() {
          return {
            blocks: [{ id: 'raw-session-id', projectPath: 'C:\\clients\\top-secret', text: 'safe work note' }],
            coverage: { sessionsIncluded: 1 }
          }
        }
      },
      pipeline: { async run() { throw Object.assign(new Error('credential leak'), { code: 'SUMMARY_PROVIDER_FAILED' }) } }
    })
  const job = await service.generate(request())
    await job.completion
    const workspace = join(root, 'workspaces', job.reportId)
    const manifest = JSON.parse(readFileSync(join(workspace, 'manifest.json'), 'utf8'))
    const inputNames = readdirSync(join(workspace, 'input')).sort()
    const inputText = inputNames.map(name => readFileSync(join(workspace, 'input', name), 'utf8')).join('\n')

    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.errorCode, 'SUMMARY_GENERATION_FAILED')
    assert.equal(manifest.expiresAt, '2026-08-19T00:00:00.000Z')
    assert.equal(inputNames.includes('period.json'), true)
    assert.equal(inputNames.includes('usage.json'), true)
    assert.match(
      inputNames.find(name => name.startsWith('project-')),
      /^project-[a-f0-9]{64}-0001\.json$/
    )
    assert.doesNotMatch(JSON.stringify(manifest), /clients|top-secret|credential/)
    assert.doesNotMatch(inputText, /C:\\\\clients|top-secret|raw-session-id/)
    assert.match(inputText, /safe work note/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function createHarness(overrides = {}) {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({
    db,
    now: () => 1000 + id,
    idFactory: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  })
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

  const [first, second] = await Promise.all([
    service.generate(request()), service.generate(request())
  ])
  const [firstResult, secondResult] = await Promise.all([first.completion, second.completion])

  assert.equal(maxActive, 1)
  assert.deepEqual([firstResult.version, secondResult.version], [1, 2])
  assert.deepEqual([firstResult.status, secondResult.status], ['completed', 'completed'])
  assert.equal(repository.get(first.reportId).isCurrent, false)
  assert.equal(repository.get(second.reportId).isCurrent, true)
  assert.deepEqual(transitions, [
    `${first.reportId}:queued`, `${second.reportId}:queued`,
    `${first.reportId}:running`, `${first.reportId}:completed`,
    `${second.reportId}:running`, `${second.reportId}:completed`
  ])
})

test('an initial running-transition failure settles completion and shutdown', async () => {
  const { service, repository } = createHarness()
  const originalUpdate = repository.update.bind(repository)
  repository.update = async (reportId, patch) => {
    if (patch.status === 'running') {
      throw Object.assign(new Error('private database detail'), { code: 'PRIVATE_DB_FAILURE' })
    }
    return originalUpdate(reportId, patch)
  }
  const job = await service.generate(request())

  const report = await Promise.race([
    job.completion,
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 100))
  ])
  assert.equal(report.status, 'failed')
  assert.equal(report.errorText, 'SUMMARY_GENERATION_FAILED')
  assert.equal(service.isActive(job.reportId), false)
  assert.equal(await Promise.race([
    service.shutdown().then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 100))
  ]), 'settled')
})

test('a confirmed transition plus failure-persistence rejection cannot strand a job', async () => {
  const { service, repository } = createHarness({
    pipeline: { async run({ confirmed }) {
      return confirmed
        ? pipelineResult()
        : { requiresConfirmation: true, estimatedCalls: 24, confirmationCallLimit: 24 }
    } }
  })
  const job = await service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'awaiting_confirmation')
  const originalUpdate = repository.update.bind(repository)
  repository.update = async (reportId, patch) => {
    if (['running', 'failed'].includes(patch.status)) {
      throw Object.assign(new Error('private database detail'), { code: 'PRIVATE_DB_FAILURE' })
    }
    return originalUpdate(reportId, patch)
  }

  await service.confirm(job.reportId, { confirmationCallLimit: 24 })
  const outcome = await Promise.race([
    job.completion.then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 100))
  ])
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.error.code, 'SUMMARY_GENERATION_FAILED')
  assert.equal(service.isActive(job.reportId), false)
  assert.equal(await Promise.race([
    service.shutdown().then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 100))
  ]), 'settled')
})

test('pipeline progress is forwarded ephemerally without changing persisted report fields', async () => {
  const events = []
  const { service, repository } = createHarness({
    pipeline: {
      async run({ onProgress }) {
        onProgress({ phase: 'cache-check', cacheKey: 'must not escape' })
        onProgress({ phase: 'mapping', current: 2, total: 4, evidence: 'must not escape' })
        onProgress({ phase: 'reducing' })
        return pipelineResult()
      }
    }
  })
  service.subscribe((report, progress) => {
    if (progress) events.push({ reportId: report.id, ...progress })
  })

  const job = await service.generate(request())
  await job.completion
  assert.deepEqual(events, [
    { reportId: job.reportId, phase: 'cache-check', completed: 0, total: 1 },
    { reportId: job.reportId, phase: 'mapping', completed: 2, total: 4 },
    { reportId: job.reportId, phase: 'reducing', completed: 0, total: 1 }
  ])
  assert.equal('progress' in repository.get(job.reportId), false)
})

test('completed jobs persist only bounded generation metrics that survive repository restart', async () => {
  const unsafeMetrics = {
    strategy: 'map-reduce', plannedCalls: 4, aiCalls: 2, cacheHits: 5,
    durationMs: 38000, mapConcurrency: 3,
    prompt: 'raw prompt', cacheKey: 'sha256:secret', path: 'C:\\private', providerOutput: 'secret'
  }
  const { service, repository, db } = createHarness({
    pipeline: { async run() { return { ...pipelineResult(), generationMetrics: unsafeMetrics } } }
  })
  const job = await service.generate(request())
  await job.completion
  const restarted = createReportRepository({ db })
  assert.deepEqual(restarted.get(job.reportId).generationMetrics, {
    strategy: 'map-reduce', plannedCalls: 4, aiCalls: 2, cacheHits: 5,
    durationMs: 38000, mapConcurrency: 3
  })
  assert.doesNotMatch(JSON.stringify(restarted.get(job.reportId)), /raw prompt|sha256:secret|private|providerOutput/)
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
  const job = await service.generate(request())
  await waitFor(() => observedSignal !== null)
  assert.equal(await service.cancel(job.reportId), true)
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
  const job = await service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'running')
  resolvePipeline(pipelineResult())
  await service.cancel(job.reportId)
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
  const job = await service.generate(request())
  await waitFor(() => repository.get(job.reportId).sourceHash !== null)

  await service.cancel(job.reportId)
  resolveUsage({ totals: { inputTokens: 0 } })
  const report = await job.completion

  assert.equal(report.status, 'cancelled')
  assert.equal(report.isCurrent, false)
})

test('cancel waits for a real database completion already queued behind the transaction tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-finishing-cancel-'))
  const db = await openDb(join(root, 'ucli.db'))
  let releaseTail
  let markTailStarted
  let markCompleteQueued
  const tailGate = new Promise(resolve => { releaseTail = resolve })
  const tailStarted = new Promise(resolve => { markTailStarted = resolve })
  const completeQueued = new Promise(resolve => { markCompleteQueued = resolve })
  let tailBlocker
  try {
    const repository = createReportRepository({ db })
    const originalComplete = db.completeSummaryReport.bind(db)
    db.completeSummaryReport = (id, patch) => {
      const completion = originalComplete(id, patch)
      markCompleteQueued()
      return completion
    }
    const service = createSummaryJobService({
      repository,
      evidenceCollector: { async collect() { return evidence() } },
      snapshotUsage: async () => ({ totals: {} }),
      pipeline: { async run() { return pipelineResult() } },
      workspaceService: {
        async create() { return { workDirectory: 'safe-work' } },
        async writeArtifact() {},
        async markStage() {},
        async complete() {
          tailBlocker = db.transaction(async () => {
            markTailStarted()
            await tailGate
          })
          await tailStarted
        },
        async fail() {}
      }
    })
    const job = await service.generate(request())
    await completeQueued

    const cancelling = service.cancel(job.reportId)
    releaseTail()

    assert.equal(await cancelling, false)
    assert.equal((await job.completion).status, 'completed')
    assert.equal(repository.get(job.reportId).isCurrent, true)
    await tailBlocker
    await service.shutdown()
  } finally {
    releaseTail?.()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('shutdown drains a real database completion already queued behind the transaction tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-finishing-shutdown-'))
  const db = await openDb(join(root, 'ucli.db'))
  let releaseTail
  let markTailStarted
  let markCompleteQueued
  const tailGate = new Promise(resolve => { releaseTail = resolve })
  const tailStarted = new Promise(resolve => { markTailStarted = resolve })
  const completeQueued = new Promise(resolve => { markCompleteQueued = resolve })
  try {
    const repository = createReportRepository({ db })
    const workspace = createSummaryWorkspaceService({ root })
    const originalComplete = db.completeSummaryReport.bind(db)
    db.completeSummaryReport = (id, patch) => {
      const completion = originalComplete(id, patch)
      markCompleteQueued()
      return completion
    }
    const service = createSummaryJobService({
      repository,
      evidenceCollector: { async collect() { return evidence() } },
      snapshotUsage: async () => ({ totals: {} }),
      pipeline: { async run() { return pipelineResult() } },
      workspaceService: {
        ...workspace,
        async complete(reportId, outputs) {
          await workspace.complete(reportId, outputs)
          const blocker = db.transaction(async () => {
            markTailStarted()
            await tailGate
          })
          blocker.catch(() => {})
          await tailStarted
        }
      }
    })
    const job = await service.generate(request())
    await completeQueued

    let shutdownSettled = false
    const shutdown = service.shutdown().finally(() => { shutdownSettled = true })
    await Promise.resolve()
    assert.equal(shutdownSettled, false)
    releaseTail()

    await shutdown
    assert.equal((await job.completion).status, 'completed')
    assert.equal(repository.get(job.reportId).isCurrent, true)
    assert.equal(service.isActive(job.reportId), false)
    const manifest = JSON.parse(readFileSync(
      join(root, 'workspaces', job.reportId, 'manifest.json'), 'utf8'
    ))
    assert.equal(manifest.status, 'completed')
  } finally {
    releaseTail?.()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('repository startup recovery marks stale queued, running, and awaiting reports interrupted', async () => {
  const db = new MemoryDb()
  let id = 0
  const repository = createReportRepository({ db, idFactory: () => `stale-${++id}` })
  const queued = await repository.createQueued(request())
  const running = await repository.createQueued(request())
  await repository.update(running.id, { status: 'running' })
  const awaiting = await repository.createQueued(request())
  await repository.update(awaiting.id, { status: 'awaiting_confirmation' })

  await repository.interruptStale()

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
  const job = await service.generate(request())
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
  const first = await service.generate(request())
  const firstResult = await first.completion
  const second = await service.generate(request())
  const secondResult = await second.completion

  assert.equal(firstResult.isCurrent, true)
  assert.equal(secondResult.version, 2)
  assert.equal(secondResult.status, 'failed')
  assert.equal(secondResult.isCurrent, false)
  assert.equal(repository.get(first.reportId).isCurrent, true)
  assert.equal(secondResult.errorText, 'SUMMARY_GENERATION_FAILED')
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
  const first = await service.generate(request())
  await first.completion
  const second = await service.generate(request())
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
  const first = await service.generate(request())
  await first.completion

  const automatic = await service.generate(request({ generatedBy: 'automatic' }))
  const automaticResult = await automatic.completion
  assert.equal(automaticResult.status, 'skipped_empty')
  assert.match(automaticResult.errorText, /^SUMMARY_AUTOMATIC_DUPLICATE:/)
  assert.equal(aiCalls, 1)
  assert.equal(repository.get(first.reportId).isCurrent, true)

  const manual = await service.generate(request({ generatedBy: 'manual' }))
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
  const job = await service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'awaiting_confirmation')
  assert.equal(calls.length, 1)
  assert.equal(repository.get(job.reportId).errorText, 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED')
  assert.equal(service.getConfirmationCallLimit(job.reportId), 24)

  const resumed = await service.confirm(job.reportId)
  assert.equal(resumed.completion, job.completion)
  const completed = await resumed.completion
  assert.equal(calls.length, 2)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.isCurrent, true)
  assert.equal(service.getConfirmationCallLimit(job.reportId), null)
})

test('concurrent confirmation admits exactly one confirmed pipeline run', async () => {
  let confirmedRuns = 0
  const { service, repository } = createHarness({
    pipeline: {
      async run({ confirmed }) {
        if (!confirmed) {
          return { requiresConfirmation: true, estimatedCalls: 24, confirmationCallLimit: 24 }
        }
        confirmedRuns += 1
        return pipelineResult()
      }
    }
  })
  const job = await service.generate(request())
  await waitFor(() => repository.get(job.reportId).status === 'awaiting_confirmation')

  const results = await Promise.allSettled([
    service.confirm(job.reportId), service.confirm(job.reportId)
  ])

  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'])
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'SUMMARY_CONFIRMATION_IN_PROGRESS')
  const admitted = results.find(result => result.status === 'fulfilled').value
  await admitted.completion
  assert.equal(confirmedRuns, 1)
  assert.equal(repository.get(job.reportId).status, 'completed')
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
  const job = await service.generate(request())
  const report = await job.completion
  assert.equal(report.status, 'failed')
  assert.equal(report.errorText, 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED')
  assert.equal(calls, 1)
  await assert.rejects(
    service.confirm(job.reportId),
    error => error.code === 'SUMMARY_CONFIRMATION_CONTEXT_MISSING'
  )
  assert.equal(repository.get(job.reportId).status, 'failed')
})

test('headless jobs map unlisted provider codes to the persisted generation fallback', async () => {
  for (const code of ['SUMMARY_PROVIDER_FAILED', 'ARBITRARY_UPPERCASE_CODE']) {
    const { service } = createHarness({
      pipeline: {
        async run() {
          throw Object.assign(new Error('private provider failure'), { code })
        }
      }
    })
    const report = await (await service.generate(request())).completion
    assert.equal(report.status, 'failed')
    assert.equal(report.errorText, 'SUMMARY_GENERATION_FAILED')
  }
})

test('workspace finalization failure never persists a completed non-current report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-workspace-finalize-failure-'))
  try {
    const workspace = createSummaryWorkspaceService({ root })
    const workspaceService = {
      ...workspace,
      async complete() {
        throw Object.assign(new Error('workspace output failed'), {
          code: 'SUMMARY_WORKSPACE_WRITE_FAILED'
        })
      }
    }
    const { db, service, repository } = createHarness({ workspaceService })
    const statuses = []
    const originalUpdate = db.updateSummaryReport.bind(db)
    db.updateSummaryReport = (id, patch) => {
      if (patch.status) statuses.push(patch.status)
      return originalUpdate(id, patch)
    }

    const job = await service.generate(request())
    const report = await job.completion

    assert.equal(report.status, 'failed')
    assert.equal(report.isCurrent, false)
    assert.equal(repository.get(job.reportId).status, 'failed')
    assert.doesNotMatch(statuses.join(','), /completed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('job order finalizes the workspace before one atomic database completion', async () => {
  const order = []
  const db = new MemoryDb()
  const originalCreate = db.createQueuedSummaryReport.bind(db)
  db.createQueuedSummaryReport = report => { order.push('queued'); return originalCreate(report) }
  const originalComplete = db.completeSummaryReport.bind(db)
  db.completeSummaryReport = async (id, patch) => {
    order.push('complete')
    return originalComplete(id, patch)
  }
  const repository = createReportRepository({ db, idFactory: () => 'ordered' })
  const service = createSummaryJobService({
    repository,
    evidenceCollector: { async collect() { order.push('collect'); return evidence() } },
    snapshotUsage: async () => { order.push('usage'); return { totals: {} } },
    pipeline: { async run() { order.push('pipeline'); return pipelineResult() } },
    workspaceService: {
      async create() { return { workDirectory: 'safe-work' } },
      async writeArtifact() {},
      async markStage() {},
      async complete() { order.push('workspace') },
      async fail() {}
    }
  })
  const job = await service.generate(request())
  await job.completion
  assert.deepEqual(order, ['queued', 'collect', 'usage', 'pipeline', 'workspace', 'complete'])
})

async function shutdownCancellationFailureScenario(failingPosition) {
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const { service, repository } = createHarness({
    pipeline: {
      run({ signal }) {
        markStarted()
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('cancelled'), { code: 'SUMMARY_RUNNER_ABORTED' }))
        }, { once: true }))
      }
    }
  })
  const running = await service.generate(request())
  const queued = await service.generate(request())
  await started
  const failingId = failingPosition === 'running' ? running.reportId : queued.reportId
  const originalUpdate = repository.update.bind(repository)
  repository.update = async (reportId, patch) => {
    if (reportId === failingId && patch.status === 'cancelled') {
      throw Object.assign(new Error('private cancellation detail'), {
        code: 'PRIVATE_DB_FAILURE'
      })
    }
    return originalUpdate(reportId, patch)
  }
  const settleWithin = promise => Promise.race([
    promise.then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 100))
  ])

  const [shutdown, runningCompletion, queuedCompletion] = await Promise.all([
    settleWithin(service.shutdown()),
    settleWithin(running.completion),
    settleWithin(queued.completion)
  ])
  assert.equal(shutdown.status, 'fulfilled')
  assert.deepEqual(
    [runningCompletion.status, queuedCompletion.status].sort(),
    ['fulfilled', 'rejected']
  )
  const rejected = [runningCompletion, queuedCompletion]
    .find(outcome => outcome.status === 'rejected')
  assert.equal(rejected.error.code, 'SUMMARY_GENERATION_FAILED')
  assert.equal(service.isActive(running.reportId), false)
  assert.equal(service.isActive(queued.reportId), false)
  const surviving = repository.get(
    failingPosition === 'running' ? queued.reportId : running.reportId
  )
  assert.equal(surviving.status, 'cancelled')
}

test('shutdown drains other jobs when a running cancellation write fails', async () => {
  await shutdownCancellationFailureScenario('running')
})

test('shutdown settles queued ownership when its cancellation write fails', async () => {
  await shutdownCancellationFailureScenario('queued')
})

test('shutdown is idempotent, rejects new jobs, cancels active work, and drains its workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-shutdown-'))
  let pipelineStarted
  const started = new Promise(resolve => { pipelineStarted = resolve })
  let workspaceFailCalls = 0
  try {
    const workspace = createSummaryWorkspaceService({ root })
    const workspaceService = {
      ...workspace,
      async fail(...args) {
        workspaceFailCalls += 1
        return workspace.fail(...args)
      }
    }
    const { service, repository } = createHarness({
      workspaceService,
      pipeline: {
        run({ signal }) {
          pipelineStarted()
          return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { code: 'SUMMARY_RUNNER_ABORTED' }))
          }, { once: true }))
        }
      }
    })
  const job = await service.generate(request())
    await started
    const first = service.shutdown()
    const second = service.shutdown()
    assert.equal(first, second)
    await first
    assert.equal(repository.get(job.reportId).status, 'cancelled')
    const manifest = JSON.parse(readFileSync(
      join(root, 'workspaces', job.reportId, 'manifest.json'), 'utf8'
    ))
    assert.notEqual(manifest.status, 'running')
    assert.equal(workspaceFailCalls, 1)
    await assert.rejects(
      service.generate(request()),
      error => error.code === 'SUMMARY_SERVICE_SHUTTING_DOWN'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shutdown waits for an in-flight generate admission and safely terminates its queued row', async () => {
  const { service, repository } = createHarness()
  const originalCreateQueued = repository.createQueued.bind(repository)
  let releaseCreate
  let markCreateStarted
  const createStarted = new Promise(resolve => { markCreateStarted = resolve })
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  repository.createQueued = async input => {
    markCreateStarted()
    await createGate
    return originalCreateQueued(input)
  }

  const generating = service.generate(request())
  await createStarted
  let shutdownSettled = false
  const shutdown = service.shutdown().finally(() => { shutdownSettled = true })
  await Promise.resolve()
  assert.equal(shutdownSettled, false)

  releaseCreate()
  await assert.rejects(
    generating,
    error => error.code === 'SUMMARY_SERVICE_SHUTTING_DOWN'
  )
  await shutdown

  const reports = repository.list()
  assert.equal(reports.some(report => ['queued', 'running'].includes(report.status)), false)
  assert.equal(reports.every(report => !service.isActive(report.id)), true)
})

test('shutdown compacts an awaiting-confirmation workspace instead of leaving it running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-job-shutdown-awaiting-'))
  try {
    const workspaceService = createSummaryWorkspaceService({ root })
    const { service, repository } = createHarness({
      workspaceService,
      pipeline: { async run() {
        return { requiresConfirmation: true, estimatedCalls: 24, confirmationCallLimit: 24 }
      } }
    })
  const job = await service.generate(request())
    await waitFor(() => repository.get(job.reportId).status === 'awaiting_confirmation')
    await service.shutdown()
    const manifest = JSON.parse(readFileSync(
      join(root, 'workspaces', job.reportId, 'manifest.json'), 'utf8'
    ))
    assert.equal(repository.get(job.reportId).status, 'cancelled')
    assert.equal(manifest.status, 'failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isActive protects queued work only until the job reaches a terminal state', async () => {
  const { service, repository } = createHarness({
    pipeline: { run: async () => pipelineResult('done') }
  })
  const job = await service.generate(request())
  assert.equal(service.isActive(job.reportId), true)
  await job.completion
  assert.equal(repository.get(job.reportId).status, 'completed')
  assert.equal(service.isActive(job.reportId), false)
  assert.equal(service.isActive('missing'), false)
})
