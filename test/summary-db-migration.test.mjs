import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import initSqlJs from 'sql.js'

import { openDb } from '../electron/persistence/db.js'
import { createReportRepository } from '../electron/summaries/reportRepository.js'

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`

function artifactMetadata(markdown) {
  return {
    canonical: 'markdown',
    bytes: Buffer.byteLength(markdown),
    sha256: `sha256:${createHash('sha256').update(markdown).digest('hex')}`
  }
}

const V0115_SUMMARY_REPORTS_DDL = `CREATE TABLE summary_reports (
  id TEXT PRIMARY KEY,
  period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month','quarter','year')),
  period_start INTEGER NOT NULL,
  period_end_exclusive INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','completed','failed','cancelled','interrupted',
    'awaiting_confirmation','skipped_empty'
  )),
  markdown TEXT,
  executor_id TEXT,
  profile_id TEXT,
  model TEXT,
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  generation_usage_json TEXT NOT NULL DEFAULT '{}',
  generation_metrics_json TEXT NOT NULL DEFAULT '{}',
  generation_cost_usd REAL,
  prompt_version TEXT,
  source_hash TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('manual','automatic')),
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (period_type, period_start, period_end_exclusive, timezone, version),
  CHECK (period_start < period_end_exclusive),
  CHECK (is_current = 0 OR status = 'completed')
)`

test('existing 0.11.5 summary database gains interactive fields without losing reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-db-'))
  const dbPath = join(root, 'ucli.db')
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run(V0115_SUMMARY_REPORTS_DDL)
  legacy.run(`INSERT INTO summary_reports (
    id, period_type, period_start, period_end_exclusive, timezone, partial,
    version, status, markdown, usage_snapshot_json, coverage_json,
    generation_usage_json, generation_metrics_json, is_current, generated_by,
    created_at, updated_at
  ) VALUES ('legacy-r1', 'week', 1, 2, 'Asia/Shanghai', 0, 1, 'completed',
    '# 摘要', '{}', '{}', '{}', '{}', 1, 'manual', 10, 10)`)
  await writeFile(dbPath, Buffer.from(legacy.export()))
  legacy.close()

  let db = await openDb(dbPath)
  try {
    const columns = db.sql.exec('PRAGMA table_info(summary_reports)')[0].values
      .map(row => row[1])
    for (const column of [
      'execution_mode', 'session_id', 'run_phase', 'artifact_metadata_json',
      'legacy_import_key'
    ]) {
      assert.ok(columns.includes(column), `missing migrated column ${column}`)
    }
    assert.deepEqual(db.getSummaryReport('legacy-r1'), {
      id: 'legacy-r1',
      periodType: 'week',
      periodStart: 1,
      periodEndExclusive: 2,
      timezone: 'Asia/Shanghai',
      partial: false,
      version: 1,
      status: 'completed',
      markdown: '# 摘要',
      executorId: null,
      profileId: null,
      model: null,
      usageSnapshot: {},
      coverage: {},
      generationUsage: {},
      generationMetrics: {},
      generationCostUsd: null,
      promptVersion: null,
      sourceHash: null,
      isCurrent: true,
      generatedBy: 'manual',
      errorText: null,
      executionMode: 'isolated-runner',
      sessionId: null,
      runPhase: null,
      artifactMetadata: {},
      legacyImportKey: null,
      createdAt: 10,
      updatedAt: 10
    })
    db.close()
    db = await openDb(dbPath)
    assert.equal(db.getSummaryReport('legacy-r1').markdown, '# 摘要')
    assert.deepEqual(
      db.sql.exec('PRAGMA table_info(summary_reports)')[0].values
        .map(row => row[1])
        .filter(column => ['execution_mode', 'session_id', 'run_phase',
          'artifact_metadata_json', 'legacy_import_key'].includes(column)),
      ['execution_mode', 'session_id', 'run_phase', 'artifact_metadata_json', 'legacy_import_key']
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

function summaryReport(overrides = {}) {
  return {
    id: 'report-1',
    periodType: 'week',
    periodStart: 100,
    periodEndExclusive: 200,
    timezone: 'Asia/Shanghai',
    partial: false,
    version: 1,
    status: 'completed',
    markdown: '# Previous',
    executorId: 'codex',
    profileId: 'profile-1',
    model: 'gpt-5',
    usageSnapshot: {},
    coverage: {},
    generationUsage: {},
    generationMetrics: {},
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: SOURCE_HASH,
    isCurrent: false,
    generatedBy: 'manual',
    errorText: null,
    executionMode: 'isolated-runner',
    sessionId: null,
    runPhase: null,
    artifactMetadata: {},
    legacyImportKey: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

test('completing a running report atomically commits markdown and switches current version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-complete-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    db.createSummaryReport(summaryReport({ id: 'week-v1', isCurrent: true }))
    db.createSummaryReport(summaryReport({
      id: 'week-v2', version: 2, status: 'running', markdown: null,
      sourceHash: null, executionMode: 'interactive-cli', sessionId: 'session-2',
      runPhase: 'running'
    }))

    const completed = await db.completeSummaryReport('week-v2', {
      status: 'completed',
      runPhase: 'completed',
      markdown: '# Current',
      sourceHash: SOURCE_HASH,
      usageSnapshot: { totals: { inputTokens: 3 } },
      coverage: { sessionsIncluded: 1 },
      artifactMetadata: artifactMetadata('# Current'),
      errorText: null,
      updatedAt: 2000
    })

    assert.equal(completed.isCurrent, true)
    assert.equal(completed.markdown, '# Current')
    assert.equal(db.getSummaryReport('week-v1').isCurrent, false)

    db.createSummaryReport(summaryReport({
      id: 'week-v3', version: 3, status: 'running', markdown: null,
      sourceHash: null, executionMode: 'interactive-cli', sessionId: 'session-3',
      runPhase: 'running'
    }))
    db.sql.run(`CREATE TRIGGER reject_completed_current
      BEFORE UPDATE OF is_current ON summary_reports
      WHEN NEW.id = 'week-v3' AND NEW.is_current = 1
      BEGIN SELECT RAISE(ABORT, 'complete current switch failed'); END`)

    await assert.rejects(db.completeSummaryReport('week-v3', {
      status: 'completed', runPhase: 'completed', markdown: '# Must Roll Back',
      sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
      artifactMetadata: artifactMetadata('# Must Roll Back'),
      errorText: null, updatedAt: 3000
    }), /complete current switch failed/)
    assert.equal(db.getSummaryReport('week-v2').isCurrent, true)
    assert.deepEqual(
      (({ status, markdown, sourceHash, isCurrent }) => ({ status, markdown, sourceHash, isCurrent }))(
        db.getSummaryReport('week-v3')
      ),
      { status: 'running', markdown: null, sourceHash: null, isCurrent: false }
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('database completion rejects invalid canonical fields before changing report state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-complete-boundary-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    db.createSummaryReport(summaryReport({
      id: 'running-boundary', status: 'running', markdown: null, sourceHash: null,
      executionMode: 'interactive-cli', sessionId: 'session-boundary', runPhase: 'running'
    }))
    for (const patch of [
      { markdown: '', sourceHash: SOURCE_HASH, artifactMetadata: artifactMetadata('# Report') },
      { markdown: '# Report', sourceHash: '', artifactMetadata: artifactMetadata('# Report') },
      { markdown: '# Report', sourceHash: SOURCE_HASH, artifactMetadata: {} },
      { markdown: '# Report', sourceHash: SOURCE_HASH,
        artifactMetadata: { ...artifactMetadata('# Report'), extra: true } },
      { markdown: '# Report', sourceHash: SOURCE_HASH,
        artifactMetadata: { ...artifactMetadata('# Report'), bytes: 1 } },
      { markdown: '# Report', sourceHash: SOURCE_HASH,
        artifactMetadata: { ...artifactMetadata('# Report'), sha256: `sha256:${'f'.repeat(64)}` } }
    ]) {
      await assert.rejects(db.completeSummaryReport('running-boundary', {
        status: 'completed', runPhase: 'completed', usageSnapshot: {}, coverage: {},
        errorText: null, updatedAt: 2000, ...patch
      }), error => ['INVALID_SUMMARY_CANONICAL_REPORT',
        'INVALID_SUMMARY_ARTIFACT_METADATA'].includes(error.code))
      assert.equal(db.getSummaryReport('running-boundary').status, 'running')
    }
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed completion transaction cannot roll back an unrelated synchronous write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-transaction-isolation-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    db.createSummaryReport(summaryReport({ id: 'week-current', isCurrent: true }))
    db.createSummaryReport(summaryReport({
      id: 'week-running', version: 2, status: 'running', markdown: null, sourceHash: null,
      executionMode: 'interactive-cli', sessionId: 'session-running', runPhase: 'running'
    }))
    db.sql.run(`CREATE TRIGGER reject_isolated_complete
      BEFORE UPDATE OF is_current ON summary_reports
      WHEN NEW.id = 'week-running' AND NEW.is_current = 1
      BEGIN SELECT RAISE(ABORT, 'isolated complete failed'); END`)

    const failedCompletion = db.completeSummaryReport('week-running', {
      status: 'completed', runPhase: 'completed', markdown: '# Fails',
      sourceHash: SOURCE_HASH, usageSnapshot: {}, coverage: {},
      artifactMetadata: artifactMetadata('# Fails'),
      errorText: null, updatedAt: 2000
    })
    await Promise.resolve()
    db.createSummaryReport(summaryReport({
      id: 'unrelated-day', periodType: 'day', periodStart: 300, periodEndExclusive: 400
    }))

    await assert.rejects(failedCompletion, /isolated complete failed/)
    assert.equal(db.getSummaryReport('week-running').status, 'running')
    assert.equal(db.getSummaryReport('week-current').isCurrent, true)
    assert.equal(db.getSummaryReport('unrelated-day').id, 'unrelated-day')
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('real database imports are concurrent-idempotent and allocate same-period versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-real-import-'))
  const db = await openDb(join(root, 'ucli.db'))
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `import-${++id}`
  })
  const imported = (overrides = {}) => {
    const value = {
      periodType: 'week', start: 100, endExclusive: 200, timezone: 'Asia/Shanghai',
      partial: false, generatedBy: 'manual', markdown: '# Imported',
      sourceHash: SOURCE_HASH, legacyImportKey: 'legacy-key-1', ...overrides
    }
    return { ...value, artifactMetadata: overrides.artifactMetadata ?? artifactMetadata(value.markdown) }
  }
  try {
    db.createSummaryReport(summaryReport({ id: 'existing-current', isCurrent: true }))
    const [first, repeated] = await Promise.all([
      repository.importCompleted(imported()),
      repository.importCompleted(imported())
    ])
    const next = await repository.importCompleted(imported({
      legacyImportKey: 'legacy-key-2', markdown: '# Imported Two'
    }))

    assert.deepEqual([first.imported, repeated.imported].sort(), [false, true])
    assert.equal(first.report.id, repeated.report.id)
    assert.equal(first.report.version, 2)
    assert.equal(next.report.version, 3)
    assert.equal(next.report.isCurrent, false)
    assert.equal(repository.get('existing-current').isCurrent, true)
    assert.equal(repository.listForKey(imported()).length, 3)
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('database transaction preserves existing async callback compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-async-transaction-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    await db.transaction(async () => {
      db.sql.run('CREATE TABLE async_transaction_probe (id TEXT PRIMARY KEY)')
      await Promise.resolve()
      db.sql.run("INSERT INTO async_transaction_probe VALUES ('survived')")
    })
    assert.equal(
      db.sql.exec('SELECT id FROM async_transaction_probe')[0].values[0][0],
      'survived'
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('direct database report writes reject unknown shapes and credential scalars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-db-closed-json-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    const secretKey = `sk-ant-${'x'.repeat(20)}`
    const awsKey = `AKIA${'A'.repeat(16)}`
    const unsafe = [
      { coverage: { authorization: 'value' } },
      { coverage: { accessKey: 'value' } },
      { coverage: { auth: 'value' } },
      { coverage: { payload: { safe: true } } },
      { coverage: { command: 'git status' } },
      { coverage: { sessionsIncluded: 1, value: secretKey } },
      { usageSnapshot: { totals: { inputTokens: 1 }, value: awsKey } }
    ]
    for (const [index, fields] of unsafe.entries()) {
      assert.throws(
        () => db.createSummaryReport(summaryReport({ id: `unsafe-create-${index}`, ...fields })),
        error => ['INVALID_SUMMARY_JSON_SHAPE',
          'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
      )
    }
    db.createSummaryReport(summaryReport({ id: 'safe-update-target' }))
    for (const fields of unsafe) {
      assert.throws(
        () => db.updateSummaryReport('safe-update-target', fields),
        error => ['INVALID_SUMMARY_JSON_SHAPE',
        'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
      )
    }
    for (const [index, errorText] of [
      `SUMMARY_RUN_FAILED:AKIA${'A'.repeat(16)}`,
      'ARBITRARY_UPPERCASE_CODE',
      'SUMMARY_GENERATION_FAILED:leaked-suffix'
    ].entries()) {
      assert.throws(
        () => db.createSummaryReport(summaryReport({
          id: `unsafe-error-${index}`, errorText
        })),
        error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
      )
      assert.throws(
        () => db.updateSummaryReport('safe-update-target', { errorText }),
        error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
      )
    }
    assert.equal(db.updateSummaryReport('safe-update-target', {
      errorText: 'SUMMARY_AUTOMATIC_DUPLICATE:safe-report-1'
    }).errorText, 'SUMMARY_AUTOMATIC_DUPLICATE:safe-report-1')
    assert.doesNotThrow(() => db.updateSummaryReport('safe-update-target', {
      coverage: { sessionsIncluded: 1, sources: { transcript: 2, note: 1, nativeDigest: 0 } }
    }))
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('direct database import verifies Markdown byte length and digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-db-import-integrity-'))
  const db = await openDb(join(root, 'ucli.db'))
  const markdown = '# Imported Integrity'
  const correct = artifactMetadata(markdown)
  try {
    for (const [index, metadata] of [
      { ...correct, bytes: correct.bytes + 1 },
      { ...correct, sha256: `sha256:${'e'.repeat(64)}` }
    ].entries()) {
      await assert.rejects(db.importCompletedSummaryReport(summaryReport({
        id: `direct-import-${index}`, status: 'completed', markdown,
        executionMode: 'legacy-worklog-import', runPhase: 'completed', isCurrent: false,
        legacyImportKey: `direct-integrity-${index}`, artifactMetadata: metadata
      })), error => error.code === 'INVALID_SUMMARY_ARTIFACT_METADATA')
    }
    assert.equal(db.listSummaryReports({ executionMode: 'legacy-worklog-import' }).length, 0)
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
