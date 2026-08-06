import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'

const PROFILE_TABLES = [
  'ai_cli_profile_bindings',
  'ai_cli_profile_revisions',
  'ai_cli_profile_secrets',
  'ai_cli_profiles'
]

function tableNames(db) {
  return db.sql.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(([name]) => name)
}

function tableColumns(db, table) {
  return db.sql.exec(`PRAGMA table_info(${table})`)[0].values.map((row) => row[1])
}

function profile(overrides = {}) {
  return {
    id: 'profile-1',
    adapterId: 'codex',
    name: 'Company Gateway',
    kind: 'managed',
    nativeProfileName: 'ucli-550e8400e29b41d4a716446655440000',
    providerId: 'ucli_550e8400e29b',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    contextWindow: 400000,
    config: { wireApi: 'responses' },
    hasSecretHint: true,
    fileSha256: 'hash-1',
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

async function withDb(prefix, work) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const db = await openDb(join(dir, 'ucli.db'))
  try {
    await work(db, dir)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('new databases contain profile tables and a nullable session profile binding', async () => {
  await withDb('ucli-profile-db-new-', async (db) => {
    assert.deepEqual(
      tableNames(db).filter((name) => name.startsWith('ai_cli_profile')),
      PROFILE_TABLES
    )
    assert.equal(tableColumns(db, 'sessions').includes('profile_id'), true)
  })
})

test('legacy databases gain profile schema without changing existing data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-profile-db-legacy-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  legacy.run('CREATE TABLE rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL)')
  legacy.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  legacy.run('CREATE TABLE gateway_secrets (key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  legacy.run("INSERT INTO sessions VALUES ('legacy-session', 'F:\\projects\\legacy', 'codex', 'thread-1', 'Legacy', 'keep note', 'safety-rules', 'gpt-5', 'offline', 1, 2)")
  legacy.run("INSERT INTO settings VALUES ('app', '{\"theme\":\"dark\"}')")
  legacy.run("INSERT INTO settings VALUES ('workbench', '{\"paneCount\":2}')")
  legacy.run("INSERT INTO gateway_secrets VALUES ('feishu:app', 'encrypted-value', 7)")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    assert.deepEqual(
      tableNames(db).filter((name) => name.startsWith('ai_cli_profile')),
      PROFILE_TABLES
    )
    assert.equal(tableColumns(db, 'sessions').includes('profile_id'), true)
    assert.equal(db.getSession('legacy-session').name, 'Legacy')
    assert.equal(db.getSession('legacy-session').taskNote, 'keep note')
    assert.equal(db.getSession('legacy-session').profileId, null)
    assert.equal(db.getSettings().theme, 'dark')
    assert.equal(db.getWorkbench().paneCount, 2)
    assert.equal(db.getGatewaySecretCiphertext('feishu:app'), 'encrypted-value')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('profile CRUD maps database fields to camelCase and tolerates invalid JSON', async () => {
  await withDb('ucli-profile-db-crud-', async (db) => {
    db.insertAiCliProfile(profile())
    assert.deepEqual(db.getAiCliProfile('profile-1'), profile())
    assert.deepEqual(db.listAiCliProfiles({ adapterId: 'codex' }), [profile()])
    assert.deepEqual(db.listAiCliProfiles({ adapterId: 'claude' }), [])

    db.updateAiCliProfile('profile-1', {
      name: 'Updated Gateway',
      model: 'gpt-5.5',
      config: { wireApi: 'responses', feature: true },
      hasSecretHint: false,
      updatedAt: 200
    })
    assert.deepEqual(db.getAiCliProfile('profile-1'), profile({
      name: 'Updated Gateway',
      model: 'gpt-5.5',
      config: { wireApi: 'responses', feature: true },
      hasSecretHint: false,
      updatedAt: 200
    }))

    db.sql.run("UPDATE ai_cli_profiles SET config_json = '{broken' WHERE id = 'profile-1'")
    assert.deepEqual(db.getAiCliProfile('profile-1').config, {})

    assert.equal(db.deleteAiCliProfile('profile-1'), true)
    assert.equal(db.getAiCliProfile('profile-1'), null)
    assert.equal(db.deleteAiCliProfile('profile-1'), false)
  })
})

test('profile bindings and session references produce an explicit usage count', async () => {
  await withDb('ucli-profile-db-usage-', async (db) => {
    db.insertAiCliProfile(profile())
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'codex',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    db.sql.run("UPDATE sessions SET profile_id = 'profile-1' WHERE id = 'session-1'")

    db.upsertAiCliProfileBinding({
      scopeType: 'app',
      scopeKey: '*',
      adapterId: 'codex',
      profileId: 'profile-1',
      updatedAt: 10
    })
    db.upsertAiCliProfileBinding({
      scopeType: 'project',
      scopeKey: 'F:\\projects\\demo',
      adapterId: 'codex',
      profileId: 'profile-1',
      updatedAt: 11
    })

    assert.deepEqual(db.listAiCliProfileBindings({ adapterId: 'codex' }), [
      {
        scopeType: 'app',
        scopeKey: '*',
        adapterId: 'codex',
        profileId: 'profile-1',
        updatedAt: 10
      },
      {
        scopeType: 'project',
        scopeKey: 'F:\\projects\\demo',
        adapterId: 'codex',
        profileId: 'profile-1',
        updatedAt: 11
      }
    ])
    assert.deepEqual(db.getAiCliProfileUsage('profile-1'), {
      sessionCount: 1,
      bindingCount: 2
    })

    assert.equal(db.deleteAiCliProfileBinding('project', 'F:\\projects\\demo', 'codex'), true)
    assert.equal(db.getAiCliProfileUsage('profile-1').bindingCount, 1)
  })
})

test('profile revisions retain the newest ten records and parse invalid JSON safely', async () => {
  await withDb('ucli-profile-db-revisions-', async (db) => {
    db.insertAiCliProfile(profile())
    for (let index = 1; index <= 11; index += 1) {
      db.insertAiCliProfileRevision({
        id: `revision-${index}`,
        profileId: 'profile-1',
        config: { version: index },
        fileSha256: `hash-${index}`,
        reason: 'update',
        createdAt: index
      })
    }

    const revisions = db.listAiCliProfileRevisions('profile-1')
    assert.equal(revisions.length, 10)
    assert.equal(revisions[0].id, 'revision-11')
    assert.equal(revisions.at(-1).id, 'revision-2')
    assert.deepEqual(db.getAiCliProfileRevision('revision-11').config, { version: 11 })
    assert.equal(db.getAiCliProfileRevision('revision-1'), null)

    db.sql.run("UPDATE ai_cli_profile_revisions SET config_json = '{broken' WHERE id = 'revision-11'")
    assert.deepEqual(db.getAiCliProfileRevision('revision-11').config, {})
  })
})

test('profile secret persistence stores ciphertext only and supports deletion', async () => {
  await withDb('ucli-profile-db-secrets-', async (db) => {
    db.saveAiCliProfileSecretCiphertext('profile-1', 'encrypted-value', 100)
    assert.deepEqual(db.getAiCliProfileSecretRecord('profile-1'), {
      profileId: 'profile-1',
      ciphertext: 'encrypted-value',
      updatedAt: 100
    })
    assert.equal(db.deleteAiCliProfileSecret('profile-1'), true)
    assert.equal(db.getAiCliProfileSecretRecord('profile-1'), null)
    assert.equal(db.deleteAiCliProfileSecret('profile-1'), false)
  })
})

test('database flush reports a persistence failure instead of swallowing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-profile-db-flush-'))
  const missingParent = join(root, 'missing-parent')
  const db = await openDb(join(missingParent, 'ucli.db'))
  try {
    assert.equal(db.flush(), false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
