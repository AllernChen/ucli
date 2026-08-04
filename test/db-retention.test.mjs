import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../electron/persistence/db.js'

test('removing a session hides it from the workbench but retains usage statistics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-retention-'))
  const db = await openDb(join(dir, 'ucli.db'))

  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'claude',
      native_session_id: 'native-1',
      provider: 'openai',
      source_provider: 'cubence_codex',
      tier: 'safety-rules',
      model: 'claude-test',
      status: 'offline',
      created_at: 1
    })
    db.upsertStats('session-1', {
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25,
      turnsDelta: 2,
      confirmed: 1
    })
    db.upsertModelStats('session-1', 'claude-test', {
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25
    })

    db.removeSession('session-1')

    assert.deepEqual(db.listSessions(), [])
    const [removed] = db.listSessions({ includeRemoved: true })
    assert.equal(removed.id, 'session-1')
    assert.equal(removed.status, 'removed')
    assert.equal(removed.provider, 'openai')
    assert.equal(removed.sourceProvider, 'cubence_codex')
    assert.ok(removed.removedAt)
    assert.equal(removed.stats.tokens.input, 120)
    assert.equal(removed.stats.costUsd, 0.25)
    assert.equal(db.getModelStats()[0].input_tokens, 120)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persists unavailable OpenCode costs separately from a real zero cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-cost-availability-'))
  const db = await openDb(join(dir, 'ucli.db'))

  try {
    for (const [id, adapterId] of [['known-zero', 'claude'], ['unknown-cost', 'opencode']]) {
      db.insertSession({
        id,
        project_path: 'F:\\projects\\demo',
        adapter_id: adapterId,
        tier: 'safety-rules',
        model: 'shared-model',
        status: 'offline',
        created_at: 1
      })
    }

    db.upsertStats('known-zero', {
      inputTokens: 10, outputTokens: 2, costUsd: 0, costAvailable: true, turnsDelta: 1
    })
    db.upsertStats('unknown-cost', {
      inputTokens: 20, outputTokens: 3, costUsd: null, costAvailable: false, turnsDelta: 1
    })
    db.upsertModelStats('known-zero', 'shared-model', {
      inputTokens: 10, outputTokens: 2, costUsd: 0, costAvailable: true
    })
    db.upsertModelStats('unknown-cost', 'shared-model', {
      inputTokens: 20, outputTokens: 3, costUsd: null, costAvailable: false
    })
    db.removeSession('unknown-cost')

    const sessions = db.listSessions({ includeRemoved: true })
    assert.equal(sessions.find((session) => session.id === 'known-zero').stats.costUsd, 0)
    assert.equal(sessions.find((session) => session.id === 'known-zero').stats.costAvailable, true)
    assert.equal(sessions.find((session) => session.id === 'unknown-cost').stats.costUsd, null)
    assert.equal(sessions.find((session) => session.id === 'unknown-cost').stats.costAvailable, false)

    const [model] = db.getModelStats()
    assert.equal(model.cost_usd, 0)
    assert.equal(model.cost_unavailable_count, 1)
    const projects = db.getStats()
    assert.equal(projects.reduce((sum, project) => sum + project.cost_usd, 0), 0)
    assert.equal(projects.reduce((sum, project) => sum + project.cost_unavailable_count, 0), 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upgrades legacy statistics tables with cost availability columns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-cost-migration-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT \'\', tier TEXT NOT NULL DEFAULT \'safety-rules\', model TEXT, provider TEXT, source_provider TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER)')
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    const sessionColumns = db.sql.exec('PRAGMA table_info(session_stats)')[0].values.map((row) => row[1])
    const modelColumns = db.sql.exec('PRAGMA table_info(model_stats)')[0].values.map((row) => row[1])
    assert.ok(sessionColumns.includes('cost_available'))
    assert.ok(modelColumns.includes('cost_available'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upgrades Codex provider metadata with a safe default policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-provider-policy-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT \'\', tier TEXT NOT NULL DEFAULT \'safety-rules\', model TEXT, provider TEXT, source_provider TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER)')
  legacy.run("INSERT INTO sessions VALUES ('imported', 'F:\\projects\\demo', 'codex', 'native-1', NULL, '', 'safety-rules', NULL, 'legacy_gateway', NULL, 'offline', 1, 2, NULL)")
  legacy.run("INSERT INTO sessions VALUES ('fresh', 'F:\\projects\\demo', 'codex', NULL, NULL, '', 'safety-rules', NULL, NULL, NULL, 'offline', 1, 2, NULL)")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    assert.equal(db.getSession('imported').providerPolicy, 'source')
    assert.equal(db.getSession('fresh').providerPolicy, 'live')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persists an explicit Codex provider separately from the effective provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-explicit-provider-'))
  const db = await openDb(join(dir, 'ucli.db'))
  try {
    db.insertSession({
      id: 'explicit-provider',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'codex',
      tier: 'safety-rules',
      provider: 'work_gateway',
      explicit_provider: 'legacy_gateway',
      provider_policy: 'explicit',
      status: 'offline',
      created_at: 1
    })
    const session = db.getSession('explicit-provider')
    assert.equal(session.provider, 'work_gateway')
    assert.equal(session.explicitProvider, 'legacy_gateway')
    assert.equal(session.providerPolicy, 'explicit')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
