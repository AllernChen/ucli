import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'

async function withDb(prefix, work) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const path = join(dir, 'ucli.db')
  const db = await openDb(path)
  try {
    await work(db, path)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function tableNames(db) {
  return db.sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]
    .values.map(([name]) => name)
}

function usageSnapshot(overrides = {}) {
  return {
    sessionId: 's1',
    model: 'claude-sonnet',
    projectPath: 'F:/projects/demo',
    adapterId: 'claude',
    observedAt: 1000,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.5,
    costAvailable: true,
    turns: 2,
    ...overrides
  }
}

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
    markdown: null,
    executorId: 'codex',
    profileId: 'profile-1',
    model: 'gpt-5',
    usageSnapshot: { inputTokens: 30, outputTokens: 10 },
    coverage: { sessionsIncluded: 2 },
    generationUsage: { inputTokens: 0, outputTokens: 0 },
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: 'source-1',
    isCurrent: false,
    generatedBy: 'manual',
    errorText: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

test('migration preserves cumulative statistics and adds usage and summary tables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-usage-ledger-migration-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  legacy.run("INSERT INTO sessions VALUES ('s1', 'F:/projects/demo', 'claude', NULL, 'Legacy', '', 'safety-rules', 'sonnet', 'offline', 1, 2)")
  legacy.run("INSERT INTO session_stats VALUES ('s1', 100, 20, 0.5, 2, 1, 1, 0)")
  legacy.run("INSERT INTO model_stats VALUES ('s1', 'sonnet', 100, 20, 0.5)")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    assert.deepEqual(
      tableNames(db).filter((name) => ['usage_checkpoints', 'usage_events', 'summary_reports', 'summary_settings'].includes(name)),
      ['summary_reports', 'summary_settings', 'usage_checkpoints', 'usage_events']
    )
    const session = db.getSession('s1')
    assert.equal(session.stats.tokens.input, 100)
    assert.equal(session.stats.tokens.output, 20)
    assert.equal(session.stats.costUsd, 0.5)
    assert.deepEqual(db.getModelStatsForSession('s1')[0], {
      model: 'sonnet', input_tokens: 100, output_tokens: 20, cost_usd: 0.5, cost_available: 1
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('first usage observation creates only a checkpoint and legacy baseline', async () => {
  await withDb('ucli-usage-ledger-baseline-', async (db) => {
    const result = await db.observeUsage(usageSnapshot())

    assert.deepEqual(result, { baseline: true, event: null })
    assert.deepEqual(db.queryUsageEvents({}), [])
    assert.deepEqual(db.getLegacyUsageBaseline(), {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
      costAvailable: true,
      turns: 2
    })
  })
})

test('later usage observations append a non-negative delta and advance the checkpoint', async () => {
  await withDb('ucli-usage-ledger-delta-', async (db) => {
    await db.observeUsage(usageSnapshot())
    const result = await db.observeUsage(usageSnapshot({
      observedAt: 2000,
      inputTokens: 130,
      outputTokens: 30,
      costUsd: 0.7,
      turns: 3
    }))

    assert.equal(result.baseline, false)
    assert.match(result.event.id, /^[a-f0-9]{64}$/)
    assert.deepEqual(db.queryUsageEvents({}), [result.event])
    assert.deepEqual(
      {
        sessionId: result.event.sessionId,
        adapterId: result.event.adapterId,
        model: result.event.model,
        observedAt: result.event.observedAt,
        inputTokens: result.event.inputTokens,
        outputTokens: result.event.outputTokens,
        costUsd: result.event.costUsd,
        costAvailable: result.event.costAvailable,
        turns: result.event.turns,
        approvals: result.event.approvals
      },
      {
        sessionId: 's1', adapterId: 'claude', model: 'claude-sonnet', observedAt: 2000,
        inputTokens: 30, outputTokens: 10, costUsd: 0.2, costAvailable: true,
        turns: 1, approvals: 0
      }
    )
  })
})

test('replaying the same cumulative observation is idempotent', async () => {
  await withDb('ucli-usage-ledger-idempotent-', async (db) => {
    await db.observeUsage(usageSnapshot())
    const update = usageSnapshot({ observedAt: 2000, inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3 })
    const first = await db.observeUsage(update)
    const replay = await db.observeUsage(update)

    assert.equal(replay.event, null)
    assert.deepEqual(db.queryUsageEvents({}).map((event) => event.id), [first.event.id])
  })
})

test('usage observation IDs are stable across databases', async () => {
  const ids = []
  for (const suffix of ['a', 'b']) {
    await withDb(`ucli-usage-ledger-stable-${suffix}-`, async (db) => {
      await db.observeUsage(usageSnapshot())
      const result = await db.observeUsage(usageSnapshot({
        observedAt: 2000, inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3
      }))
      ids.push(result.event.id)
    })
  }
  assert.equal(ids[0], ids[1])
})

test('any cumulative counter rollback resets the entire checkpoint without a mixed delta', async () => {
  await withDb('ucli-usage-ledger-reset-', async (db) => {
    await db.observeUsage(usageSnapshot())
    const reset = await db.observeUsage(usageSnapshot({
      observedAt: 2000, inputTokens: 130, outputTokens: 10, costUsd: 0.6, turns: 3
    }))
    assert.equal(reset.reset, true)
    assert.equal(reset.event, null)
    assert.deepEqual(db.queryUsageEvents({}), [])

    await db.observeUsage(usageSnapshot({
      observedAt: 3000, inputTokens: 140, outputTokens: 15, costUsd: 0.7, turns: 4
    }))
    const [event] = db.queryUsageEvents({})
    assert.equal(event.inputTokens, 10)
    assert.equal(event.outputTokens, 5)
    assert.equal(event.turns, 1)
    assert.equal(event.costUsd, 0.1)
  })
})

test('usage event insertion and checkpoint advance are atomic', async () => {
  await withDb('ucli-usage-ledger-atomic-', async (db) => {
    await db.observeUsage(usageSnapshot())
    db.sql.run(`
      CREATE TRIGGER reject_usage_checkpoint_update
      BEFORE UPDATE ON usage_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint update failed');
      END
    `)

    await assert.rejects(
      db.observeUsage(usageSnapshot({ observedAt: 2000, inputTokens: 110 })),
      /checkpoint update failed/
    )
    assert.deepEqual(db.queryUsageEvents({}), [])
  })
})

test('approval decisions are append-only usage events and replay safely', async () => {
  await withDb('ucli-usage-ledger-approval-', async (db) => {
    const approval = {
      approvalId: 'decision-1',
      sessionId: 's1',
      projectPath: 'F:/projects/demo',
      adapterId: 'codex',
      model: 'gpt-5',
      observedAt: 2500
    }
    const first = await db.recordApproval(approval)
    const replay = await db.recordApproval(approval)

    assert.equal(first.id, replay.id)
    assert.deepEqual(db.queryUsageEvents({}), [{
      id: first.id,
      sessionId: 's1',
      projectPath: 'F:/projects/demo',
      adapterId: 'codex',
      model: 'gpt-5',
      observedAt: 2500,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costAvailable: false,
      turns: 0,
      approvals: 1
    }])
  })
})

test('usage event queries filter by time, project, adapter, model, and session', async () => {
  await withDb('ucli-usage-ledger-query-', async (db) => {
    await db.recordApproval({
      approvalId: 'a1', sessionId: 's1', projectPath: '/a', adapterId: 'codex', model: 'gpt-5', observedAt: 1000
    })
    await db.recordApproval({
      approvalId: 'a2', sessionId: 's2', projectPath: '/b', adapterId: 'claude', model: 'sonnet', observedAt: 2000
    })

    const result = db.queryUsageEvents({
      start: 1500,
      endExclusive: 2500,
      projectPaths: ['/b'],
      adapterIds: ['claude'],
      models: ['sonnet'],
      sessionIds: ['s2']
    })
    assert.deepEqual(result.map((event) => event.sessionId), ['s2'])
  })
})

test('summary report CRUD maps fields and validates JSON at the database boundary', async () => {
  await withDb('ucli-summary-report-crud-', async (db) => {
    assert.deepEqual(db.createSummaryReport(summaryReport()), summaryReport())
    assert.deepEqual(db.getSummaryReport('report-1'), summaryReport())
    assert.deepEqual(db.listSummaryReports({ periodType: 'week', status: 'queued' }), [summaryReport()])
    assert.deepEqual(db.listSummaryReports({ periodType: 'day' }), [])

    const completed = db.updateSummaryReport('report-1', {
      status: 'completed',
      markdown: '# 周报',
      coverage: { sessionsIncluded: 3 },
      generationUsage: { inputTokens: 200, outputTokens: 50 },
      generationCostUsd: 0.25,
      updatedAt: 2000
    })
    assert.deepEqual(completed, summaryReport({
      status: 'completed',
      markdown: '# 周报',
      coverage: { sessionsIncluded: 3 },
      generationUsage: { inputTokens: 200, outputTokens: 50 },
      generationCostUsd: 0.25,
      updatedAt: 2000
    }))

    db.sql.run("UPDATE summary_reports SET usage_snapshot_json = '{broken', coverage_json = '[]', generation_usage_json = 'null' WHERE id = 'report-1'")
    const tolerant = db.getSummaryReport('report-1')
    assert.deepEqual(tolerant.usageSnapshot, {})
    assert.deepEqual(tolerant.coverage, {})
    assert.deepEqual(tolerant.generationUsage, {})
  })
})

test('setting a current report atomically switches only its logical period', async () => {
  await withDb('ucli-summary-report-current-', async (db) => {
    db.createSummaryReport(summaryReport({ id: 'week-v1', isCurrent: true }))
    db.createSummaryReport(summaryReport({ id: 'week-v2', version: 2 }))
    db.createSummaryReport(summaryReport({
      id: 'day-v1', periodType: 'day', periodStart: 300, periodEndExclusive: 400, isCurrent: true
    }))

    const current = await db.setCurrentSummaryReport('week-v2')
    assert.equal(current.id, 'week-v2')
    assert.equal(current.isCurrent, true)
    assert.equal(db.getSummaryReport('week-v1').isCurrent, false)
    assert.equal(db.getSummaryReport('day-v1').isCurrent, true)
    assert.deepEqual(
      db.listSummaryReports({ periodType: 'week', isCurrent: true }).map((report) => report.id),
      ['week-v2']
    )
  })
})

test('a failed current switch rolls back the previous current marker', async () => {
  await withDb('ucli-summary-report-current-atomic-', async (db) => {
    db.createSummaryReport(summaryReport({ id: 'week-v1', isCurrent: true }))
    db.createSummaryReport(summaryReport({ id: 'week-v2', version: 2 }))
    db.sql.run(`
      CREATE TRIGGER reject_report_current
      BEFORE UPDATE OF is_current ON summary_reports
      WHEN NEW.id = 'week-v2' AND NEW.is_current = 1
      BEGIN
        SELECT RAISE(ABORT, 'current switch failed');
      END
    `)

    await assert.rejects(db.setCurrentSummaryReport('week-v2'), /current switch failed/)
    assert.equal(db.getSummaryReport('week-v1').isCurrent, true)
    assert.equal(db.getSummaryReport('week-v2').isCurrent, false)
  })
})

test('summary settings expose safe defaults and merge validated updates', async () => {
  await withDb('ucli-summary-settings-', async (db) => {
    const defaults = {
      autoEnabled: false,
      autoPeriods: { day: true, week: true, month: false, quarter: false, year: false },
      defaultExecutorId: null,
      defaultProfileId: null,
      defaultModel: null,
      firstEnableDisclosureAcceptedAt: null,
      automaticCallLimit: 20
    }
    assert.deepEqual(db.getSummarySettings(), defaults)

    assert.deepEqual(db.setSummarySettings({
      autoEnabled: true,
      autoPeriods: { month: true },
      defaultExecutorId: 'codex',
      defaultProfileId: 'profile-1',
      automaticCallLimit: 30,
      ignored: 'not persisted'
    }), {
      ...defaults,
      autoEnabled: true,
      autoPeriods: { ...defaults.autoPeriods, month: true },
      defaultExecutorId: 'codex',
      defaultProfileId: 'profile-1',
      automaticCallLimit: 30
    })

    db.sql.run("UPDATE summary_settings SET settings_json = '{broken' WHERE id = 1")
    assert.deepEqual(db.getSummarySettings(), defaults)
  })
})
