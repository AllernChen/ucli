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
      'legacy_import_key', 'title', 'task_note'
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
      title: null,
      taskNote: '',
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
    db.sql.run(`UPDATE summary_reports SET
      usage_snapshot_json = '{"inputTokens":30,"unknownCounter":99}',
      coverage_json = '{"sessionsIncluded":2,"unknownSafe":1}',
      error_text = 'LEGACY_PROVIDER_TIMEOUT_42'
      WHERE id = 'legacy-r1'`)
    const legacyReport = createReportRepository({ db }).get('legacy-r1')
    assert.deepEqual(legacyReport.usageSnapshot, { totals: { inputTokens: 30 } })
    assert.deepEqual(legacyReport.coverage, { sessionsIncluded: 2 })
    assert.equal(legacyReport.errorText, 'SUMMARY_GENERATION_FAILED')
    assert.equal(legacyReport.markdown, '# 摘要')
    assert.equal(legacyReport.title, '工作总结（每周）1970-01-01 08:00')
    assert.equal(legacyReport.taskNote, '')
    db.close()
    db = await openDb(dbPath)
    const reopenedLegacyReport = createReportRepository({ db }).list()[0]
    assert.equal(reopenedLegacyReport.markdown, '# 摘要')
    assert.deepEqual(reopenedLegacyReport.usageSnapshot, { totals: { inputTokens: 30 } })
    assert.equal(reopenedLegacyReport.errorText, 'SUMMARY_GENERATION_FAILED')
    assert.deepEqual(
      db.sql.exec('PRAGMA table_info(summary_reports)')[0].values
        .map(row => row[1])
        .filter(column => ['execution_mode', 'session_id', 'run_phase',
          'artifact_metadata_json', 'legacy_import_key', 'title', 'task_note'].includes(column)),
      ['execution_mode', 'session_id', 'run_phase', 'artifact_metadata_json', 'legacy_import_key',
        'title', 'task_note']
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
    status: 'queued',
    title: '工作总结（每周）1970-01-01 08:00',
    taskNote: '',
    markdown: null,
    executorId: 'codex',
    profileId: 'profile-1',
    model: 'gpt-5',
    usageSnapshot: {},
    coverage: {},
    generationUsage: {},
    generationMetrics: {},
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: null,
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

test('repository assigns canonical metadata when creating queued reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-task-title-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    const repository = createReportRepository({
      db,
      now: () => Date.UTC(2026, 7, 25, 1, 50),
      idFactory: () => 'task-title-report'
    })
    const report = await repository.createQueued({
      periodType: 'week', periodStart: 1, periodEndExclusive: 2,
      timezone: 'Asia/Shanghai', generatedBy: 'manual'
    })
    assert.equal(report.title, '工作总结（每周）2026-08-25 09:50')
    assert.equal(report.taskNote, '')
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function seedCompletedSummary(db, overrides = {}) {
  const markdown = overrides.markdown ?? '# Previous'
  const report = summaryReport({
    ...overrides,
    status: 'completed',
    markdown,
    sourceHash: overrides.sourceHash ?? SOURCE_HASH,
    executionMode: 'legacy-worklog-import',
    runPhase: 'completed',
    artifactMetadata: overrides.artifactMetadata ?? artifactMetadata(markdown),
    legacyImportKey: overrides.legacyImportKey ?? `legacy:${overrides.id ?? 'report-1'}`,
    isCurrent: false
  })
  const result = await db.importCompletedSummaryReport(report)
  if (overrides.isCurrent) return db.setCurrentSummaryReport(result.report.id)
  return result.report
}

test('completing a running report atomically commits markdown and switches current version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-complete-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    await seedCompletedSummary(db, { id: 'week-v1', isCurrent: true })
    await db.createSummaryReport(summaryReport({
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

    await db.createSummaryReport(summaryReport({
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
    await db.createSummaryReport(summaryReport({
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

test('direct create and update cannot bypass the dedicated completion path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-completion-bypass-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    assert.equal(db._insertSummaryReportSync, undefined)
    assert.equal(db._updateSummaryReportSync, undefined)
    const markdown = '# Bypass'
    await assert.rejects(db.createSummaryReport(summaryReport({
      id: 'direct-completed', status: 'completed', markdown, sourceHash: SOURCE_HASH,
      runPhase: 'completed', artifactMetadata: artifactMetadata(markdown)
    })), error => error.code === 'INVALID_SUMMARY_STATUS')

    await db.createSummaryReport(summaryReport({
      id: 'bypass-target', status: 'running', runPhase: 'running'
    }))
    await assert.rejects(db.updateSummaryReport('bypass-target', {
      status: 'completed', runPhase: 'completed', markdown, sourceHash: SOURCE_HASH,
      artifactMetadata: artifactMetadata(markdown), updatedAt: 2000
    }), error => error.code === 'INVALID_SUMMARY_STATUS')
    await assert.rejects(
      db.setCurrentSummaryReport('bypass-target'),
      error => error.code === 'SUMMARY_REPORT_NOT_COMPLETED'
    )
    assert.deepEqual(
      (({ status, markdown, sourceHash, isCurrent }) => ({ status, markdown, sourceHash, isCurrent }))(
        db.getSummaryReport('bypass-target')
      ),
      { status: 'running', markdown: null, sourceHash: null, isCurrent: false }
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed completion transaction cannot roll back an unrelated synchronous write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-transaction-isolation-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    await seedCompletedSummary(db, { id: 'week-current', isCurrent: true })
    await db.createSummaryReport(summaryReport({
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
    await db.createSummaryReport(summaryReport({
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

test('summary task metadata updates the sole UCLI session projection atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-task-update-'))
  const db = await openDb(join(root, 'ucli.db'))
  try {
    db.insertSession({
      id: 'summary-session', project_path: 'C:\\summary', adapter_id: 'claude',
      name: 'old name', task_note: '', tier: 'safety-rules', status: 'offline', created_at: 1
    })
    await db.createSummaryReport(summaryReport({
      id: 'editable-report', sessionId: 'summary-session', title: 'old name', taskNote: ''
    }))

    const result = await db.updateSummaryTask('editable-report', {
      title: '新的任务名称', taskNote: '复盘说明', updatedAt: 2
    })
    assert.equal(result.report.title, '新的任务名称')
    assert.equal(result.report.taskNote, '复盘说明')
    assert.equal(result.sessionUpdated, true)
    assert.equal(db.getSession('summary-session').name, '新的任务名称')
    assert.equal(db.getSession('summary-session').taskNote, '复盘说明')

    await db.createSummaryReport(summaryReport({
      id: 'shared-owner', version: 2, sessionId: 'summary-session', title: 'second owner'
    }))
    const shared = await db.updateSummaryTask('editable-report', {
      title: '只更新报告', taskNote: '共享异常', updatedAt: 3
    })
    assert.equal(shared.report.title, '只更新报告')
    assert.equal(shared.sessionUpdated, false)
    assert.equal(db.getSession('summary-session').name, '新的任务名称')
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
    await seedCompletedSummary(db, { id: 'existing-current', isCurrent: true })
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

test('real repository queued creates allocate same-period versions atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-real-queued-versions-'))
  const db = await openDb(join(root, 'ucli.db'))
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `queued-${++id}`
  })
  const input = {
    periodType: 'week', start: 100, endExclusive: 200, timezone: 'Asia/Shanghai',
    partial: false, generatedBy: 'manual'
  }
  try {
    const results = await Promise.allSettled([
      repository.createQueued(input), repository.createQueued(input)
    ])

    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'])
    assert.deepEqual(
      results.map(result => result.value.version).sort((left, right) => left - right),
      [1, 2]
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('real repository queued creates allocate different logical keys independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-real-queued-keys-'))
  const db = await openDb(join(root, 'ucli.db'))
  let id = 0
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => `queued-key-${++id}`
  })
  const input = {
    periodType: 'week', start: 100, endExclusive: 200, timezone: 'Asia/Shanghai',
    partial: false, generatedBy: 'manual'
  }
  try {
    const [week, day] = await Promise.all([
      repository.createQueued(input),
      repository.createQueued({
        ...input, periodType: 'day', start: 300, endExclusive: 400
      })
    ])

    assert.deepEqual([week.version, day.version], [1, 1])
    assert.deepEqual(repository.list().map(report => report.id).sort(), [week.id, day.id].sort())
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed atomic queued create rolls back before later queued writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-real-queued-rollback-'))
  const db = await openDb(join(root, 'ucli.db'))
  const ids = ['reject-queued', 'surviving-week', 'surviving-day']
  const repository = createReportRepository({
    db, now: () => 1000, idFactory: () => ids.shift()
  })
  const input = {
    periodType: 'week', start: 100, endExclusive: 200, timezone: 'Asia/Shanghai',
    partial: false, generatedBy: 'manual'
  }
  try {
    db.sql.run(`CREATE TRIGGER reject_queued_create
      BEFORE INSERT ON summary_reports WHEN NEW.id = 'reject-queued'
      BEGIN SELECT RAISE(ABORT, 'queued create failed'); END`)
    const results = await Promise.allSettled([
      repository.createQueued(input),
      repository.createQueued(input),
      repository.createQueued({
        ...input, periodType: 'day', start: 300, endExclusive: 400
      })
    ])

    assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled'])
    assert.match(results[0].reason.message, /queued create failed/)
    assert.equal(results[1].value.version, 1)
    assert.equal(results[2].value.version, 1)
    assert.deepEqual(
      repository.list().map(report => report.id).sort(),
      ['surviving-day', 'surviving-week']
    )
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

test('a failing async transaction preserves an unrelated summary created while it awaits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-async-transaction-ownership-'))
  const db = await openDb(join(root, 'ucli.db'))
  let releaseTransaction
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { releaseTransaction = resolve })
  try {
    const failed = db.transaction(async () => {
      db.saveGatewaySetting('gateway.async-summary-isolation', { enabled: true })
      markStarted()
      await gate
      throw new Error('gateway transaction failed')
    })
    await started

    const create = db.createSummaryReport(summaryReport({ id: 'unrelated-summary' }))
    releaseTransaction()

    await assert.rejects(failed, /gateway transaction failed/)
    const created = await create
    assert.equal(created.id, 'unrelated-summary')
    assert.equal(db.getGatewaySetting('gateway.async-summary-isolation'), null)
    assert.equal(db.getSummaryReport('unrelated-summary')?.id, 'unrelated-summary')
  } finally {
    releaseTransaction?.()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a successful async transaction commits before a queued summary create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-async-transaction-commit-'))
  const db = await openDb(join(root, 'ucli.db'))
  let releaseTransaction
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { releaseTransaction = resolve })
  try {
    const committed = db.transaction(async () => {
      db.saveGatewaySetting('gateway.async-summary-commit', { enabled: true })
      markStarted()
      await gate
    })
    await started

    let createSettled = false
    const create = db.createSummaryReport(summaryReport({ id: 'after-commit' }))
      .finally(() => { createSettled = true })
    await Promise.resolve()
    assert.equal(createSettled, false)

    releaseTransaction()
    await committed
    assert.equal((await create).id, 'after-commit')
    assert.deepEqual(db.getGatewaySetting('gateway.async-summary-commit'), { enabled: true })
    assert.equal(db.getSummaryReport('after-commit')?.id, 'after-commit')
  } finally {
    releaseTransaction?.()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('queued summary create and update preserve invocation order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ucli-summary-write-order-'))
  const db = await openDb(join(root, 'ucli.db'))
  let releaseTransaction
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { releaseTransaction = resolve })
  try {
    const blocker = db.transaction(async () => {
      markStarted()
      await gate
    })
    await started

    const create = db.createSummaryReport(summaryReport({ id: 'ordered-report' }))
    const update = db.updateSummaryReport('ordered-report', {
      status: 'running', runPhase: 'running', model: 'ordered-model', updatedAt: 2000
    })
    releaseTransaction()

    await blocker
    await create
    const updated = await update
    assert.equal(updated.status, 'running')
    assert.equal(updated.model, 'ordered-model')
    assert.equal(db.getSummaryReport('ordered-report').updatedAt, 2000)
  } finally {
    releaseTransaction?.()
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
      await assert.rejects(
        db.createSummaryReport(summaryReport({ id: `unsafe-create-${index}`, ...fields })),
        error => ['INVALID_SUMMARY_JSON_SHAPE',
          'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
      )
    }
    await db.createSummaryReport(summaryReport({ id: 'safe-update-target' }))
    for (const fields of unsafe) {
      await assert.rejects(
        db.updateSummaryReport('safe-update-target', fields),
        error => ['INVALID_SUMMARY_JSON_SHAPE',
        'SUMMARY_SENSITIVE_JSON_FORBIDDEN'].includes(error.code)
      )
    }
    for (const [index, errorText] of [
      `SUMMARY_RUN_FAILED:AKIA${'A'.repeat(16)}`,
      'ARBITRARY_UPPERCASE_CODE',
      'SUMMARY_GENERATION_FAILED:leaked-suffix',
      `SUMMARY_AUTOMATIC_DUPLICATE:${secretKey}`,
      `SUMMARY_AUTOMATIC_DUPLICATE:${awsKey}`
    ].entries()) {
      await assert.rejects(
        db.createSummaryReport(summaryReport({
          id: `unsafe-error-${index}`, version: index + 2, errorText
        })),
        error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
      )
      await assert.rejects(
        db.updateSummaryReport('safe-update-target', { errorText }),
        error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
      )
    }
    const completedTargetId = '11111111-1111-4111-8111-111111111111'
    const wrongPeriodTargetId = '22222222-2222-4222-8222-222222222222'
    const runningTargetId = '33333333-3333-4333-8333-333333333333'
    await seedCompletedSummary(db, { id: completedTargetId })
    await seedCompletedSummary(db, {
      id: wrongPeriodTargetId, periodStart: 300, periodEndExclusive: 400
    })
    await db.createSummaryReport(summaryReport({
      id: runningTargetId, version: 3, status: 'running', runPhase: 'running'
    }))
    for (const targetId of [
      '44444444-4444-4444-8444-444444444444', wrongPeriodTargetId, runningTargetId
    ]) {
      await assert.rejects(db.updateSummaryReport('safe-update-target', {
        errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${targetId}`
      }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
    }
    await assert.rejects(db.updateSummaryReport('safe-update-target', {
      errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${completedTargetId}`
    }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
    await db.updateSummaryReport('safe-update-target', {
      generatedBy: 'automatic', sourceHash: `sha256:${'b'.repeat(64)}`
    })
    await assert.rejects(db.updateSummaryReport('safe-update-target', {
      errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${completedTargetId}`
    }), error => error.code === 'INVALID_SUMMARY_ERROR_CODE')
    await db.updateSummaryReport('safe-update-target', { sourceHash: SOURCE_HASH })
    assert.equal((await db.updateSummaryReport('safe-update-target', {
      errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${completedTargetId}`
    })).errorText, `SUMMARY_AUTOMATIC_DUPLICATE:${completedTargetId}`)
    for (const patch of [
      { generatedBy: 'manual' },
      { sourceHash: `sha256:${'b'.repeat(64)}` },
      {
        sourceHash: `sha256:${'b'.repeat(64)}`,
        errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${completedTargetId}`
      }
    ]) {
      await assert.rejects(
        db.updateSummaryReport('safe-update-target', patch),
        error => error.code === 'INVALID_SUMMARY_ERROR_CODE'
      )
    }
    await assert.doesNotReject(db.updateSummaryReport('safe-update-target', {
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
        sourceHash: SOURCE_HASH,
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
