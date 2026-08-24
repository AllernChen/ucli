import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
    scope: 'model',
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

async function openMigratedUsageDb(prefix, { models = [['claude-sonnet', 100, 20, 0.5]] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  legacy.run("INSERT INTO sessions VALUES ('s1', '/projects/demo', 'claude', NULL, NULL, '', 'safety-rules', 'claude-sonnet', 'offline', 1, 2)")
  legacy.run("INSERT INTO session_stats VALUES ('s1', 100, 20, 0.5, 2, 0, 0, 0)")
  for (const [model, inputTokens, outputTokens, costUsd] of models) {
    legacy.run('INSERT INTO model_stats VALUES (?, ?, ?, ?, ?)', ['s1', model, inputTokens, outputTokens, costUsd])
  }
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()
  return { db: await openDb(path), dir }
}

function ledgerSnapshot(db, offset, overrides = {}) {
  return usageSnapshot({
    observedAt: db.getUsageLedgerMetadata().exactSince + offset,
    ...overrides
  })
}

function modelEvents(db, filters = {}) {
  return db.queryUsageEvents({ ...filters, scopes: ['model'] })
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
    usageSnapshot: { totals: { inputTokens: 30, outputTokens: 10 } },
    coverage: { sessionsIncluded: 2 },
    generationUsage: { inputTokens: 0, outputTokens: 0 },
    generationMetrics: {},
    generationCostUsd: null,
    promptVersion: 'summary-v1',
    sourceHash: 'source-1',
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

function summaryArtifact(markdown) {
  return {
    canonical: 'markdown',
    bytes: Buffer.byteLength(markdown),
    sha256: `sha256:${createHash('sha256').update(markdown).digest('hex')}`
  }
}

async function seedCompletedSummary(db, overrides = {}) {
  const markdown = overrides.markdown ?? '# Completed'
  const report = summaryReport({
    ...overrides,
    status: 'completed',
    markdown,
    sourceHash: `sha256:${'a'.repeat(64)}`,
    isCurrent: false,
    executionMode: 'legacy-worklog-import',
    runPhase: 'completed',
    artifactMetadata: summaryArtifact(markdown),
    legacyImportKey: `legacy:${overrides.id ?? 'report-1'}`
  })
  const result = await db.importCompletedSummaryReport(report)
  if (overrides.isCurrent) return db.setCurrentSummaryReport(result.report.id)
  return result.report
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

  const openedAfter = Date.now()
  const db = await openDb(path)
  try {
    assert.deepEqual(
      tableNames(db).filter((name) => ['usage_checkpoints', 'usage_events', 'summary_reports', 'summary_settings'].includes(name)),
      ['summary_reports', 'summary_settings', 'usage_checkpoints', 'usage_events']
    )
    const checkpointSql = db.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'usage_checkpoints'")[0].values[0][0]
    const eventSql = db.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'usage_events'")[0].values[0][0]
    assert.match(checkpointSql, /scope/i)
    assert.match(eventSql, /scope\s+TEXT\s+NOT NULL\s+CHECK\s*\(scope IN \('session', 'model', 'approval'\)\)/i)
    const session = db.getSession('s1')
    assert.equal(session.stats.tokens.input, 100)
    assert.equal(session.stats.tokens.output, 20)
    assert.equal(session.stats.costUsd, 0.5)
    assert.deepEqual(db.getModelStatsForSession('s1')[0], {
      model: 'sonnet', input_tokens: 100, output_tokens: 20, cost_usd: 0.5, cost_available: 1
    })
    const metadata = db.getUsageLedgerMetadata()
    assert.equal(metadata.ledgerStartedAt, metadata.exactSince)
    assert.ok(metadata.exactSince >= openedAfter && metadata.exactSince <= Date.now())
    assert.deepEqual(db.getLegacyUsageBaseline(), {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
      costAvailable: true,
      turns: 2
    })

    const update = await db.observeUsage(usageSnapshot({
      model: 'sonnet', observedAt: metadata.exactSince + 1000,
      inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 0
    }))
    assert.equal(update.event.inputTokens, 30)
    assert.equal(update.event.outputTokens, 10)
    assert.equal(update.event.turns, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy JSON totals seed the ledger before exact observations begin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-usage-ledger-json-migration-'))
  const path = join(dir, 'ucli.db')
  let db = await openDb(path, { deferUsageLedgerInitialization: true })

  try {
    assert.deepEqual(db.getUsageLedgerMetadata(), {
      ledgerStartedAt: undefined,
      exactSince: undefined
    })

    db.migrateFromJson(null, null, {
      s1: {
        cwd: 'F:/projects/demo',
        adapterId: 'claude',
        model: 'claude-sonnet',
        createdAt: 1,
        stats: {
          tokens: { input: 100, output: 25 },
          costUsd: 0.75,
          turns: 4
        }
      }
    })

    const metadata = db.initializeUsageLedgerAfterLegacyImport()
    assert.equal(metadata.ledgerStartedAt, metadata.exactSince)
    assert.deepEqual(db.getLegacyUsageBaseline(), {
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.75,
      costAvailable: true,
      turns: 4
    })

    const unchanged = await db.observeUsage(usageSnapshot({
      scope: 'session',
      model: null,
      observedAt: metadata.exactSince + 1,
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.75,
      turns: 4
    }))
    assert.equal(unchanged.event, null)

    const increment = await db.observeUsage(usageSnapshot({
      scope: 'session',
      model: null,
      observedAt: metadata.exactSince + 2,
      inputTokens: 110,
      outputTokens: 30,
      costUsd: 0.9,
      turns: 5
    }))
    assert.deepEqual({
      inputTokens: increment.event.inputTokens,
      outputTokens: increment.event.outputTokens,
      costUsd: increment.event.costUsd,
      turns: increment.event.turns
    }, {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.15,
      turns: 1
    })

    assert.deepEqual(db.initializeUsageLedgerAfterLegacyImport(), metadata)
    db.flush()
    db.close()
    db = await openDb(path)
    assert.deepEqual(db.getUsageLedgerMetadata(), metadata)
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrated session totals produce only their post-upgrade delta', async () => {
  const { db, dir } = await openMigratedUsageDb('ucli-usage-scope-session-')
  try {
    const result = await db.observeUsage(ledgerSnapshot(db, 1, {
      scope: 'session', model: null, inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3
    }))
    assert.equal(result.event.scope, 'session')
    assert.equal(result.event.inputTokens, 30)
    assert.equal(result.event.outputTokens, 10)
    assert.equal(result.event.turns, 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrated model counters produce independent per-model deltas', async () => {
  const { db, dir } = await openMigratedUsageDb('ucli-usage-scope-model-', {
    models: [['sonnet', 60, 12, 0.3], ['haiku', 40, 8, 0.2]]
  })
  try {
    await db.observeUsage(ledgerSnapshot(db, 1, {
      scope: 'model', model: 'sonnet', inputTokens: 70, outputTokens: 14, costUsd: 0.35, turns: 0
    }))
    await db.observeUsage(ledgerSnapshot(db, 2, {
      scope: 'model', model: 'haiku', inputTokens: 50, outputTokens: 10, costUsd: 0.25, turns: 0
    }))
    assert.deepEqual(
      db.queryUsageEvents({ scopes: ['model'] }).map((event) => [event.model, event.inputTokens, event.outputTokens]),
      [['sonnet', 10, 2], ['haiku', 10, 2]]
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session totals and model breakdown remain separate when both are observed', async () => {
  const { db, dir } = await openMigratedUsageDb('ucli-usage-scope-both-')
  try {
    await db.observeUsage(ledgerSnapshot(db, 1, {
      scope: 'session', model: null, inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3
    }))
    await db.observeUsage(ledgerSnapshot(db, 2, {
      scope: 'model', model: 'claude-sonnet', inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 0
    }))
    const [sessionEvent] = db.queryUsageEvents({ scopes: ['session'] })
    const [modelEvent] = db.queryUsageEvents({ scopes: ['model'] })
    assert.equal(sessionEvent.inputTokens, 30)
    assert.equal(sessionEvent.turns, 1)
    assert.equal(modelEvent.inputTokens, 30)
    assert.equal(modelEvent.turns, 0)
    assert.deepEqual(db.queryUsageEvents({}).map((event) => event.scope), ['session'])
    assert.deepEqual(db.queryUsageEvents({ models: ['claude-sonnet'] }).map((event) => event.scope), ['model'])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usage observations require an explicit valid scope and model identity', async () => {
  await withDb('ucli-usage-scope-validation-', async (db) => {
    await assert.rejects(
      db.observeUsage(ledgerSnapshot(db, 1, { scope: undefined })),
      (error) => error.code === 'INVALID_USAGE_SCOPE'
    )
    await assert.rejects(
      db.observeUsage(ledgerSnapshot(db, 1, { scope: 'approval' })),
      (error) => error.code === 'INVALID_USAGE_SCOPE'
    )
    await assert.rejects(
      db.observeUsage(ledgerSnapshot(db, 1, { scope: 'model', model: '' })),
      (error) => error.code === 'INVALID_USAGE_MODEL'
    )
  })
})

test('legacy baseline uses canonical session totals with zero, one, or many model rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-usage-ledger-canonical-baseline-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  for (const [id, adapterId, inputTokens, outputTokens, costUsd, turns] of [
    ['zero-models', 'claude', 100, 10, 1, 1],
    ['one-model', 'codex', 200, 20, 2, 2],
    ['two-models', 'claude', 300, 30, 3, 3]
  ]) {
    legacy.run('INSERT INTO sessions VALUES (?, ?, ?, NULL, NULL, \'\', \'safety-rules\', NULL, \'offline\', 1, 2)', [id, `/projects/${id}`, adapterId])
    legacy.run('INSERT INTO session_stats VALUES (?, ?, ?, ?, ?, 0, 0, 0)', [id, inputTokens, outputTokens, costUsd, turns])
  }
  legacy.run("INSERT INTO model_stats VALUES ('one-model', 'sonnet', 150, 15, 1.5)")
  legacy.run("INSERT INTO model_stats VALUES ('two-models', 'sonnet', 90, 9, 0.9)")
  legacy.run("INSERT INTO model_stats VALUES ('two-models', 'haiku', 110, 11, 1.1)")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    assert.deepEqual(db.getLegacyUsageBaseline(), {
      inputTokens: 600,
      outputTokens: 60,
      costUsd: 6,
      costAvailable: true,
      turns: 6
    })
    assert.deepEqual(db.getLegacyUsageBaseline({ projectPaths: ['/projects/one-model'] }), {
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 2,
      costAvailable: true,
      turns: 2
    })
    assert.deepEqual(db.getLegacyUsageBaseline({ adapterIds: ['claude'] }), {
      inputTokens: 400,
      outputTokens: 40,
      costUsd: 4,
      costAvailable: true,
      turns: 4
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new post-migration session records its first non-zero observation from zero', async () => {
  await withDb('ucli-usage-ledger-baseline-', async (db) => {
    const observedAt = db.getUsageLedgerMetadata().exactSince + 1
    const result = await db.observeUsage(usageSnapshot({ observedAt }))

    assert.equal(result.baseline, false)
    assert.equal(result.event.inputTokens, 100)
    assert.equal(result.event.outputTokens, 20)
    assert.equal(result.event.turns, 2)
    assert.deepEqual(db.getLegacyUsageBaseline(), {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costAvailable: true,
      turns: 0
    })
  })
})

test('a model first seen after migration records its first observation from zero', async () => {
  await withDb('ucli-usage-ledger-new-model-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1, { model: 'model-a' }))
    const result = await db.observeUsage(ledgerSnapshot(db, 2, {
      model: 'model-b', inputTokens: 40, outputTokens: 5, costUsd: 0.1, turns: 1
    }))

    assert.equal(result.baseline, false)
    assert.equal(result.event.model, 'model-b')
    assert.equal(result.event.inputTokens, 40)
    assert.equal(result.event.outputTokens, 5)
    assert.equal(result.event.turns, 1)
  })
})

test('later usage observations append a non-negative delta and advance the checkpoint', async () => {
  await withDb('ucli-usage-ledger-delta-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1000))
    const result = await db.observeUsage(ledgerSnapshot(db, 2000, {
      inputTokens: 130,
      outputTokens: 30,
      costUsd: 0.7,
      turns: 3
    }))

    assert.equal(result.baseline, false)
    assert.match(result.event.id, /^[a-f0-9]{64}$/)
    assert.deepEqual(modelEvents(db).at(-1), result.event)
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
        sessionId: 's1', adapterId: 'claude', model: 'claude-sonnet', observedAt: result.event.observedAt,
        inputTokens: 30, outputTokens: 10, costUsd: 0.2, costAvailable: true,
        turns: 1, approvals: 0
      }
    )
  })
})

test('replaying the same cumulative observation is idempotent', async () => {
  await withDb('ucli-usage-ledger-idempotent-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1000))
    const update = ledgerSnapshot(db, 2000, { inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3 })
    const first = await db.observeUsage(update)
    const replay = await db.observeUsage(update)

    assert.equal(replay.event, null)
    assert.equal(modelEvents(db).filter((event) => event.id === first.event.id).length, 1)
  })
})

test('usage observation IDs are stable across databases', async () => {
  const ids = []
  const observedAt = Date.now() + 10000
  for (const suffix of ['a', 'b']) {
    await withDb(`ucli-usage-ledger-stable-${suffix}-`, async (db) => {
      await db.observeUsage(usageSnapshot({ observedAt: observedAt - 1000 }))
      const result = await db.observeUsage(usageSnapshot({ observedAt,
        inputTokens: 130, outputTokens: 30, costUsd: 0.7, turns: 3
      }))
      ids.push(result.event.id)
    })
  }
  assert.equal(ids[0], ids[1])
})

test('any cumulative counter rollback resets the entire checkpoint without a mixed delta', async () => {
  await withDb('ucli-usage-ledger-reset-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1000))
    const beforeReset = modelEvents(db).length
    const reset = await db.observeUsage(ledgerSnapshot(db, 2000, {
      inputTokens: 130, outputTokens: 10, costUsd: 0.6, turns: 3
    }))
    assert.equal(reset.reset, true)
    assert.equal(reset.event, null)
    assert.equal(modelEvents(db).length, beforeReset)

    await db.observeUsage(ledgerSnapshot(db, 3000, {
      inputTokens: 140, outputTokens: 15, costUsd: 0.7, turns: 4
    }))
    const event = modelEvents(db).at(-1)
    assert.equal(event.inputTokens, 10)
    assert.equal(event.outputTokens, 5)
    assert.equal(event.turns, 1)
    assert.equal(event.costUsd, 0.1)
  })
})

test('usage event insertion and checkpoint advance are atomic', async () => {
  await withDb('ucli-usage-ledger-atomic-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1000))
    const eventCount = modelEvents(db).length
    db.sql.run(`
      CREATE TRIGGER reject_usage_checkpoint_update
      BEFORE UPDATE ON usage_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint update failed');
      END
    `)

    await assert.rejects(
      db.observeUsage(ledgerSnapshot(db, 2000, { inputTokens: 110 })),
      /checkpoint update failed/
    )
    assert.equal(modelEvents(db).length, eventCount)
  })
})

test('concurrent usage observations share the database transaction queue', async () => {
  await withDb('ucli-usage-ledger-concurrent-', async (db) => {
    const results = await Promise.all([
      db.observeUsage(ledgerSnapshot(db, 1, { inputTokens: 100, outputTokens: 20, turns: 2 })),
      db.observeUsage(ledgerSnapshot(db, 2, { inputTokens: 150, outputTokens: 30, turns: 3 }))
    ])

    assert.equal(results.length, 2)
    assert.equal(modelEvents(db).reduce((sum, event) => sum + event.inputTokens, 0), 150)
    assert.equal(modelEvents(db).reduce((sum, event) => sum + event.outputTokens, 0), 30)
  })
})

test('out-of-order observations cannot rewind a checkpoint or inflate later deltas', async () => {
  await withDb('ucli-usage-ledger-out-of-order-', async (db) => {
    const exactSince = db.getUsageLedgerMetadata().exactSince
    const at = (offset, inputTokens) => usageSnapshot({
      observedAt: exactSince + offset,
      inputTokens,
      outputTokens: 0,
      costUsd: null,
      costAvailable: false,
      turns: 0
    })
    await db.observeUsage(at(1, 100))
    await db.observeUsage(at(3, 150))
    const stale = await db.observeUsage(at(2, 120))
    await db.observeUsage(at(4, 160))

    assert.equal(stale.ignored, true)
    assert.equal(stale.event, null)
    assert.equal(
      modelEvents(db, { start: exactSince + 2 }).reduce((sum, event) => sum + event.inputTokens, 0),
      60
    )
  })
})

test('a same-timestamp counter rollback is ignored instead of treated as a reset', async () => {
  await withDb('ucli-usage-ledger-same-time-', async (db) => {
    const observedAt = db.getUsageLedgerMetadata().exactSince + 10
    await db.observeUsage(usageSnapshot({ observedAt, inputTokens: 150 }))
    const stale = await db.observeUsage(usageSnapshot({ observedAt, inputTokens: 120 }))
    await db.observeUsage(usageSnapshot({ observedAt: observedAt + 1, inputTokens: 160 }))

    assert.equal(stale.ignored, true)
    assert.equal(modelEvents(db, { start: observedAt + 1 }).at(-1).inputTokens, 10)
  })
})

test('cost is known only when availability and a non-negative finite amount agree', async () => {
  await withDb('ucli-usage-ledger-cost-contract-', async (db) => {
    const missingFlag = await db.observeUsage(ledgerSnapshot(db, 1, {
      inputTokens: 10, outputTokens: 0, turns: 0, costUsd: 0.5, costAvailable: undefined
    }))
    assert.equal(missingFlag.event.costAvailable, false)
    assert.equal(missingFlag.event.costUsd, null)

    const invalidAmount = await db.observeUsage(ledgerSnapshot(db, 2, {
      inputTokens: 20, outputTokens: 0, turns: 0, costUsd: -1, costAvailable: true
    }))
    assert.equal(invalidAmount.reset, undefined)
    assert.equal(invalidAmount.event.inputTokens, 10)
    assert.equal(invalidAmount.event.costAvailable, false)
    assert.equal(invalidAmount.event.costUsd, null)
  })
})

test('an inconsistent cost update cannot reset otherwise increasing token counters', async () => {
  await withDb('ucli-usage-ledger-cost-reset-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1, {
      inputTokens: 100, outputTokens: 0, turns: 0, costUsd: 0.5, costAvailable: true
    }))
    const invalid = await db.observeUsage(ledgerSnapshot(db, 2, {
      inputTokens: 110, outputTokens: 0, turns: 0, costUsd: Number.NaN, costAvailable: true
    }))
    await db.observeUsage(ledgerSnapshot(db, 3, {
      inputTokens: 120, outputTokens: 0, turns: 0, costUsd: 0.6, costAvailable: true
    }))

    assert.equal(invalid.reset, undefined)
    assert.equal(invalid.event.inputTokens, 10)
    assert.equal(
      modelEvents(db).reduce((sum, event) => sum + event.inputTokens, 0),
      120
    )
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
    const replay = await db.recordApproval({ ...approval, observedAt: 3500 })

    assert.equal(first.id, replay.id)
    assert.deepEqual(db.queryUsageEvents({}), [{
      id: first.id,
      sessionId: 's1',
      scope: 'approval',
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
    assert.throws(
      () => db.recordApproval({ ...approval, approvalId: '' }),
      (error) => error.code === 'INVALID_APPROVAL_ID'
    )
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
      sessionIds: ['s2'],
      scopes: ['approval']
    })
    assert.deepEqual(result.map((event) => event.sessionId), ['s2'])
  })
})

test('model-filtered queries include matching approvals without double-counting tokens', async () => {
  await withDb('ucli-usage-ledger-model-approval-query-', async (db) => {
    await db.observeUsage(ledgerSnapshot(db, 1, {
      model: 'gpt-5', inputTokens: 10, outputTokens: 2, turns: 1
    }))
    db.recordApproval({
      approvalId: 'approval-1', sessionId: 's1', projectPath: 'F:/projects/demo',
      adapterId: 'codex', model: 'gpt-5', observedAt: db.getUsageLedgerMetadata().exactSince + 2
    })

    const events = db.queryUsageEvents({ models: ['gpt-5'] })
    assert.deepEqual(events.map((event) => event.scope), ['model', 'approval'])
    assert.equal(events.reduce((sum, event) => sum + event.inputTokens, 0), 10)
    assert.equal(events.reduce((sum, event) => sum + event.approvals, 0), 1)
  })
})

test('summary report CRUD maps fields and validates JSON at the database boundary', async () => {
  await withDb('ucli-summary-report-crud-', async (db) => {
    assert.deepEqual(await db.createSummaryReport(summaryReport()), summaryReport())
    assert.deepEqual(db.getSummaryReport('report-1'), summaryReport())
    assert.deepEqual(db.listSummaryReports({ periodType: 'week', status: 'queued' }), [summaryReport()])
    assert.deepEqual(db.listSummaryReports({ periodType: 'day' }), [])

    await db.updateSummaryReport('report-1', { status: 'running' })
    const completed = await db.completeSummaryReport('report-1', {
      status: 'completed',
      runPhase: 'completed',
      markdown: '# 周报',
      coverage: { sessionsIncluded: 3 },
      generationUsage: { inputTokens: 200, outputTokens: 50 },
      generationMetrics: {
        strategy: 'map-reduce', plannedCalls: 3, aiCalls: 3, cacheHits: 2,
        durationMs: 25, mapConcurrency: 2
      },
      generationCostUsd: 0.25,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      artifactMetadata: summaryArtifact('# 周报'),
      errorText: null,
      updatedAt: 2000
    })
    assert.deepEqual(completed, summaryReport({
      status: 'completed',
      markdown: '# 周报',
      coverage: { sessionsIncluded: 3 },
      generationUsage: { inputTokens: 200, outputTokens: 50 },
      generationMetrics: {
        strategy: 'map-reduce', plannedCalls: 3, aiCalls: 3, cacheHits: 2,
        durationMs: 25, mapConcurrency: 2
      },
      generationCostUsd: 0.25,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      isCurrent: true,
      runPhase: 'completed',
      artifactMetadata: summaryArtifact('# 周报'),
      updatedAt: 2000
    }))

    db.sql.run("UPDATE summary_reports SET usage_snapshot_json = '{broken', coverage_json = '[]', generation_usage_json = 'null', generation_metrics_json = '{broken' WHERE id = 'report-1'")
    const tolerant = db.getSummaryReport('report-1')
    assert.deepEqual(tolerant.usageSnapshot, {})
    assert.deepEqual(tolerant.coverage, {})
    assert.deepEqual(tolerant.generationUsage, {})
    assert.deepEqual(tolerant.generationMetrics, {})
  })
})

test('summary report migration adds metrics without changing a legacy row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-summary-report-metrics-migration-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run(`
    CREATE TABLE summary_reports (
      id TEXT PRIMARY KEY, period_type TEXT NOT NULL, period_start INTEGER NOT NULL,
      period_end_exclusive INTEGER NOT NULL, timezone TEXT NOT NULL, partial INTEGER NOT NULL,
      version INTEGER NOT NULL, status TEXT NOT NULL, markdown TEXT, executor_id TEXT,
      profile_id TEXT, model TEXT, usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
      coverage_json TEXT NOT NULL DEFAULT '{}', generation_usage_json TEXT NOT NULL DEFAULT '{}',
      generation_cost_usd REAL, prompt_version TEXT, source_hash TEXT, is_current INTEGER NOT NULL,
      generated_by TEXT NOT NULL, error_text TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `)
  legacy.run(`
    INSERT INTO summary_reports VALUES (
      'legacy-report', 'week', 100, 200, 'Asia/Shanghai', 0, 1, 'completed', '# Legacy',
      'claude', NULL, 'sonnet', '{"inputTokens":30}', '{"sessionsIncluded":2}',
      '{"inputTokens":10}', 0.25, 'summary-v1', 'source-1', 1, 'manual', NULL, 1000, 2000
    )
  `)
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    const report = db.getSummaryReport('legacy-report')
    assert.equal(report.markdown, '# Legacy')
    assert.equal(report.isCurrent, true)
    assert.deepEqual(report.generationUsage, { inputTokens: 10 })
    assert.deepEqual(report.generationMetrics, {})
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summary cache metadata validates keys, kinds, paths, sizes, and timestamps', async () => {
  await withDb('ucli-summary-cache-metadata-', async db => {
    const hex = 'a'.repeat(64)
    const key = `sha256:${hex}`
    const entry = {
      key,
      kind: 'map',
      relativePath: `map/aa/${hex}.json`,
      sizeBytes: 123,
      createdAt: 1000,
      lastAccessedAt: 2000,
      expiresAt: null
    }
    assert.deepEqual(db.upsertSummaryCacheEntry(entry), entry)
    assert.deepEqual(db.getSummaryCacheEntry(key), entry)
    assert.deepEqual(db.listSummaryCacheEntries(), [entry])
    assert.deepEqual(db.touchSummaryCacheEntry(key, 3000), { ...entry, lastAccessedAt: 3000 })

    for (const invalid of [
      { ...entry, key: 'sha256:not-a-key' },
      { ...entry, kind: 'chunk' },
      { ...entry, relativePath: `map/ab/${hex}.json` },
      { ...entry, relativePath: `map\\aa\\${hex}.json` },
      { ...entry, relativePath: '../escape.json' },
      { ...entry, relativePath: `/map/aa/${hex}.json` },
      { ...entry, sizeBytes: -1 },
      { ...entry, sizeBytes: 1.5 },
      { ...entry, createdAt: -1 },
      { ...entry, lastAccessedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...entry, expiresAt: -1 }
    ]) {
      assert.throws(
        () => db.upsertSummaryCacheEntry(invalid),
        error => error?.code === 'INVALID_SUMMARY_CACHE_ENTRY'
      )
    }

    assert.throws(
      () => db.touchSummaryCacheEntry('sha256:bad', 3000),
      error => error?.code === 'INVALID_SUMMARY_CACHE_ENTRY'
    )
    assert.equal(db.deleteSummaryCacheEntries([key]), 1)
    assert.equal(db.getSummaryCacheEntry(key), null)
  })
})

test('summary reports reject invalid periods, states, origins, versions, ranges, and timezones', async () => {
  await withDb('ucli-summary-report-validation-', async (db) => {
    for (const [overrides, code] of [
      [{ periodType: 'hour' }, 'INVALID_SUMMARY_PERIOD'],
      [{ status: 'done' }, 'INVALID_SUMMARY_STATUS'],
      [{ generatedBy: 'scheduler' }, 'INVALID_SUMMARY_GENERATED_BY'],
      [{ version: 0 }, 'INVALID_SUMMARY_VERSION'],
      [{ periodStart: 200, periodEndExclusive: 200 }, 'INVALID_SUMMARY_RANGE'],
      [{ timezone: '  ' }, 'INVALID_SUMMARY_TIMEZONE']
    ]) {
      await assert.rejects(
        db.createSummaryReport(summaryReport(overrides)),
        (error) => error.code === code
      )
    }

    await db.createSummaryReport(summaryReport())
    await assert.rejects(
      db.updateSummaryReport('report-1', { status: 'done' }),
      (error) => error.code === 'INVALID_SUMMARY_STATUS'
    )
    await assert.rejects(
      db.updateSummaryReport('report-1', { generatedBy: 'scheduler' }),
      (error) => error.code === 'INVALID_SUMMARY_GENERATED_BY'
    )

    const schema = db.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'summary_reports'")[0].values[0][0]
    assert.match(schema, /CHECK\s*\(period_type IN/i)
    assert.match(schema, /CHECK\s*\(status IN/i)
    assert.match(schema, /CHECK\s*\(generated_by IN/i)
    assert.match(schema, /CHECK\s*\(is_current = 0 OR status = 'completed'\)/i)
  })
})

test('setting a current report atomically switches only its logical period', async () => {
  await withDb('ucli-summary-report-current-', async (db) => {
    await seedCompletedSummary(db, { id: 'week-v1', isCurrent: true })
    await seedCompletedSummary(db, { id: 'week-v2' })
    await seedCompletedSummary(db, {
      id: 'day-v1', periodType: 'day', periodStart: 300, periodEndExclusive: 400,
      isCurrent: true
    })

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
    await seedCompletedSummary(db, { id: 'week-v1', isCurrent: true })
    await seedCompletedSummary(db, { id: 'week-v2' })
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

test('only completed reports can become current', async () => {
  await withDb('ucli-summary-report-current-status-', async (db) => {
    await db.createSummaryReport(summaryReport({ status: 'running' }))
    await assert.rejects(
      db.setCurrentSummaryReport('report-1'),
      (error) => error.code === 'SUMMARY_REPORT_NOT_COMPLETED'
    )
    assert.equal(db.getSummaryReport('report-1').isCurrent, false)
  })
})

test('a current completed report cannot transition to a non-completed status', async () => {
  await withDb('ucli-summary-report-current-update-', async (db) => {
    await seedCompletedSummary(db, { isCurrent: true })
    await assert.rejects(
      db.updateSummaryReport('report-1', { status: 'failed' }),
      (error) => error.code === 'SUMMARY_REPORT_NOT_COMPLETED'
    )
    assert.equal(db.getSummaryReport('report-1').status, 'completed')
    assert.equal(db.getSummaryReport('report-1').isCurrent, true)
  })
})

test('deleting reports rejects active work and atomically promotes the previous completed version', async () => {
  await withDb('ucli-summary-report-delete-', async (db) => {
    await seedCompletedSummary(db, { id: 'week-v1' })
    await seedCompletedSummary(db, { id: 'week-v2', isCurrent: true })
    await db.createSummaryReport(summaryReport({
      id: 'week-running', status: 'running', version: 3
    }))
    await seedCompletedSummary(db, {
      id: 'day-current', periodType: 'day', periodStart: 300, periodEndExclusive: 400,
      isCurrent: true
    })

    await assert.rejects(
      db.deleteSummaryReport('missing'),
      error => error.code === 'SUMMARY_REPORT_NOT_FOUND'
    )
    await assert.rejects(
      db.deleteSummaryReport('week-running'),
      error => error.code === 'SUMMARY_REPORT_ACTIVE'
    )
    assert.ok(db.getSummaryReport('week-running'))

    assert.deepEqual(await db.deleteSummaryReport('week-v2'), {
      deletedReportId: 'week-v2', currentReportId: 'week-v1'
    })
    assert.equal(db.getSummaryReport('week-v2'), null)
    assert.equal(db.getSummaryReport('week-v1').isCurrent, true)
    assert.equal(db.getSummaryReport('day-current').isCurrent, true)
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
      automaticCallLimit: 20,
      cacheEnabled: true,
      cacheMaxBytes: 1_073_741_824,
      failedWorkspaceRetentionDays: 7,
      mapConcurrency: 2
    }
    assert.deepEqual(db.getSummarySettings(), defaults)

    assert.deepEqual(db.setSummarySettings({
      autoEnabled: true,
      autoPeriods: { month: true },
      defaultExecutorId: 'codex',
      defaultProfileId: 'profile-1',
      automaticCallLimit: 30,
      cacheEnabled: false,
      cacheMaxBytes: 2 * 1024 * 1024 * 1024,
      failedWorkspaceRetentionDays: 14,
      mapConcurrency: 3,
      ignored: 'not persisted'
    }), {
      ...defaults,
      autoEnabled: true,
      autoPeriods: { ...defaults.autoPeriods, month: true },
      defaultExecutorId: 'codex',
      defaultProfileId: 'profile-1',
      automaticCallLimit: 30,
      cacheEnabled: false,
      cacheMaxBytes: 2 * 1024 * 1024 * 1024,
      failedWorkspaceRetentionDays: 14,
      mapConcurrency: 3
    })

    db.sql.run("UPDATE summary_settings SET settings_json = '{broken' WHERE id = 1")
    assert.deepEqual(db.getSummarySettings(), defaults)
  })
})

test('summary settings reject cache, retention, and concurrency values outside their bounds', async () => {
  await withDb('ucli-summary-settings-validation-', async db => {
    for (const [patch, code] of [
      [{ cacheEnabled: 'yes' }, 'INVALID_SUMMARY_CACHE_ENABLED'],
      [{ cacheMaxBytes: 256 * 1024 * 1024 - 1 }, 'INVALID_SUMMARY_CACHE_LIMIT'],
      [{ cacheMaxBytes: 5 * 1024 * 1024 * 1024 + 1 }, 'INVALID_SUMMARY_CACHE_LIMIT'],
      [{ cacheMaxBytes: 1.5 }, 'INVALID_SUMMARY_CACHE_LIMIT'],
      [{ failedWorkspaceRetentionDays: 0 }, 'INVALID_SUMMARY_WORKSPACE_RETENTION'],
      [{ failedWorkspaceRetentionDays: 31 }, 'INVALID_SUMMARY_WORKSPACE_RETENTION'],
      [{ mapConcurrency: 0 }, 'INVALID_SUMMARY_MAP_CONCURRENCY'],
      [{ mapConcurrency: 4 }, 'INVALID_SUMMARY_MAP_CONCURRENCY']
    ]) {
      assert.throws(() => db.setSummarySettings(patch), error => error?.code === code)
    }
  })
})
