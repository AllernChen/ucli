import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as sessionConfig from '../electron/adapters/adapterSessionConfig.js'
import { claudeDescriptor } from '../electron/adapters/claudeAdapter.js'
import { getDb, openDb } from '../electron/persistence/db.js'

const { normalizeDshSessionConfig, normalizeSessionConfig } = sessionConfig

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

test('existing descriptors normalize session config to an empty object', () => {
  assert.deepEqual(normalizeSessionConfig({ id: 'claude' }, {
    profileName: 'tui',
    token: 'must-not-leak'
  }), {})
})

test('descriptor-owned normalization returns an isolated value', () => {
  const descriptorResult = { profileName: 'tui', surfacePreference: 'tui' }
  const normalized = normalizeSessionConfig({
    id: 'deepseek-harness',
    normalizeSessionConfig: () => descriptorResult
  }, {})

  descriptorResult.profileName = 'changed-after-normalization'
  assert.deepEqual(normalized, {
    profileName: 'tui',
    surfacePreference: 'tui'
  })
})

test('DSH session config keeps only the persisted allowlist', () => {
  assert.deepEqual(normalizeDshSessionConfig({
    profileName: 'tui',
    surfacePreference: 'tui',
    endpoint: '\\\\.\\pipe\\ucli-secret',
    token: 'must-not-leak',
    webUrl: 'http://127.0.0.1:1234',
    dshHome: 'C:\\secret'
  }), {
    profileName: 'tui',
    surfacePreference: 'tui'
  })
})

test('DSH session config accepts a named TUI profile', () => {
  assert.deepEqual(normalizeDshSessionConfig({
    profileName: 'team-profile',
    surfacePreference: 'tui'
  }), {
    profileName: 'team-profile',
    surfacePreference: 'tui'
  })
})

test('DSH Web session config does not require or retain a profile name', () => {
  assert.deepEqual(normalizeDshSessionConfig({
    surfacePreference: 'web'
  }), {
    surfacePreference: 'web'
  })
  assert.deepEqual(normalizeDshSessionConfig({
    profileName: 'obsolete/profile',
    surfacePreference: 'web'
  }), {
    surfacePreference: 'web'
  })
})

test('DSH session config rejects unsafe or unsupported profile names', () => {
  const invalidNames = [
    '',
    'a'.repeat(129),
    'bad\u0000name',
    'bad\nname',
    `bad${String.fromCodePoint(0x80)}name`,
    `bad${String.fromCodePoint(0x9f)}name`,
    '.',
    '..',
    'node_modules',
    'path/name',
    'path\\name'
  ]

  for (const profileName of invalidNames) {
    assert.throws(
      () => normalizeDshSessionConfig({ profileName, surfacePreference: 'tui' }),
      /profile name/i,
      JSON.stringify(profileName)
    )
  }
})

test('persisted session normalization fails safe when descriptor config is obsolete', () => {
  const descriptor = {
    normalizeSessionConfig() {
      throw new Error('obsolete persisted config')
    }
  }

  assert.deepEqual(
    sessionConfig.normalizePersistedSessionConfig(descriptor, { oldVersion: true }),
    {}
  )
  assert.throws(
    () => normalizeSessionConfig(descriptor, { oldVersion: true }),
    /obsolete persisted config/
  )
})

test('interactive session creation propagates descriptor config validation', async () => {
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const root = mkdtempSync(join(tmpdir(), 'ucli-strict-adapter-config-'))
  const userData = join(root, 'user-data')
  mkdirSync(userData, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = userData
  const originalNormalizer = claudeDescriptor.normalizeSessionConfig
  const orchestratorModule = await import(`../electron/orchestrator.js?strict-create=${Date.now()}`)
  const orchestrator = orchestratorModule.createOrchestrator()
  claudeDescriptor.normalizeSessionConfig = () => {
    throw new Error('interactive config rejected')
  }
  try {
    orchestrator.registerIpc()
    assert.throws(
      () => handlers.get('session:create')({}, {
        adapterId: 'claude',
        cwd: 'F:\\projects\\demo',
        adapterConfig: { obsolete: true }
      }),
      /interactive config rejected/
    )
  } finally {
    if (originalNormalizer === undefined) delete claudeDescriptor.normalizeSessionConfig
    else claudeDescriptor.normalizeSessionConfig = originalNormalizer
    await orchestrator.shutdown()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

test('orchestrator restore and public mapping fail safe for obsolete persisted config', async () => {
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const root = mkdtempSync(join(tmpdir(), 'ucli-safe-adapter-config-'))
  const userData = join(root, 'user-data')
  mkdirSync(userData, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = userData

  const seed = await openDb(join(userData, 'ucli.db'))
  seed.insertSession({
    id: 'obsolete-session',
    project_path: 'F:\\projects\\demo',
    adapter_id: 'claude',
    adapter_config_json: JSON.stringify({ oldVersion: true }),
    tier: 'safety-rules',
    status: 'offline',
    created_at: 1
  })
  seed.flush()
  seed.close()

  const originalNormalizer = claudeDescriptor.normalizeSessionConfig
  claudeDescriptor.normalizeSessionConfig = () => {
    throw new Error('obsolete persisted config')
  }
  let orchestrator = null
  try {
    const orchestratorModule = await import(`../electron/orchestrator.js?safe-restore=${Date.now()}`)
    orchestrator = orchestratorModule.createOrchestrator()
    await orchestrator.initPersistence()
    orchestrator.registerIpc()

    const restored = handlers.get('session:list')()
      .find((session) => session.id === 'obsolete-session')
    assert.deepEqual(restored.adapterConfig, {})
  } finally {
    if (originalNormalizer === undefined) delete claudeDescriptor.normalizeSessionConfig
    else claudeDescriptor.normalizeSessionConfig = originalNormalizer
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH session config rejects unsupported surfaces', () => {
  assert.throws(
    () => normalizeDshSessionConfig({ profileName: 'tui', surfacePreference: 'headless' }),
    /surface preference/i
  )
})

test('0.10.2 databases gain adapter config without changing existing sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-adapter-config-migration-'))
  const path = join(root, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, system_model TEXT, provider TEXT, source_provider TEXT, provider_policy TEXT, explicit_provider TEXT, profile_id TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cost_available INTEGER NOT NULL DEFAULT 1, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cost_available INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session_id, model))')
  legacy.run("INSERT INTO sessions (id, project_path, adapter_id, tier, status, created_at, updated_at) VALUES ('legacy-session', 'F:\\projects\\legacy', 'claude', 'safety-rules', 'offline', 1, 2)")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    const columns = db.sql.exec('PRAGMA table_info(sessions)')[0].values.map((row) => row[1])
    assert.equal(columns.includes('adapter_config_json'), true)
    assert.equal(db.getSession('legacy-session').name, null)
    assert.deepEqual(db.getSession('legacy-session').adapterConfig, {})
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
