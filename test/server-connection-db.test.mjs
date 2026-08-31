import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { stableServiceProfileId } from '../electron/serverConnection/serviceProfileCatalog.js'

async function withDb(work) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-db-'))
  const db = await openDb(join(root, 'ucli.db'))
  try { await work(db) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const connection = (overrides = {}) => ({
  id: 'connection-1',
  slot: 'candidate',
  serverOrigin: 'https://server.example.test',
  refreshTokenCiphertext: 'ciphertext-1',
  accountId: 'account-1',
  accountDisplayName: 'Ada Lovelace',
  organizationId: 'organization-1',
  organizationName: 'Example Org',
  authorizationExpiresAt: '2026-12-01T00:00:00.000Z',
  serverTime: '2026-08-27T00:00:00.000Z',
  receivedLocalTime: 100,
  serverOffsetMs: 50,
  lastSyncedAt: 100,
  connectionRevision: 0,
  degradedReason: null,
  reminderState: { notified: [] },
  ...overrides
})

function tableColumns(db, table) {
  return db.sql.exec(`PRAGMA table_info(${table})`)[0].values.map((row) => row[1])
}

test('server schema has isolated installation, normalized service catalog, and skill tables with required constraints', async () => {
  await withDb(async (db) => {
    const tables = db.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat()
    for (const name of [
      'server_installation', 'server_connections', 'server_service_profiles', 'server_service_models',
      'server_skill_versions', 'server_skill_packages'
    ]) assert.equal(tables.includes(name), true)
    assert.deepEqual(tableColumns(db, 'server_installation'), [
      'singleton_key', 'installation_id', 'device_name', 'created_at'
    ])
    assert.deepEqual(tableColumns(db, 'server_connections'), [
      'id', 'slot', 'server_origin', 'refresh_token_ciphertext', 'account_id', 'account_display_name',
      'organization_id', 'organization_name', 'authorization_expires_at', 'server_time',
      'received_local_time', 'server_offset_ms', 'last_synced_at', 'connection_revision',
      'degraded_reason', 'reminder_state_json'
    ])
    assert.deepEqual(tableColumns(db, 'server_service_profiles'), [
      'profile_id', 'server_origin', 'organization_id', 'organization_name', 'connection_revision',
      'availability_status'
    ])
    assert.deepEqual(tableColumns(db, 'server_service_models'), [
      'service_profile_id', 'model_id', 'display_name', 'context_size', 'protocols_json',
      'availability_status', 'catalog_order', 'codex_file_sha256'
    ])
    assert.deepEqual(tableColumns(db, 'server_skill_versions'), [
      'version_id', 'server_origin', 'organization_id', 'slug', 'version', 'name', 'description', 'sha256',
      'size_bytes', 'published_at', 'created_at', 'download_url', 'lifecycle_status', 'connection_revision'
    ])
    assert.deepEqual(tableColumns(db, 'server_skill_packages'), [
      'package_id', 'version_id', 'server_origin', 'organization_id', 'slug', 'version'
    ])

    db.sql.run("INSERT INTO server_installation VALUES (1, 'installation-1', 'Workstation', 1)")
    assert.throws(() => db.sql.run("INSERT INTO server_installation VALUES (1, 'installation-2', 'Other', 2)"))
    assert.throws(() => db.sql.run("INSERT INTO server_installation VALUES (2, 'installation-2', 'Other', 2)"))

    db.saveServerConnection(connection())
    assert.throws(() => db.sql.run("INSERT INTO server_connections (id, slot, server_origin, refresh_token_ciphertext, account_id, account_display_name, organization_id, organization_name, received_local_time, server_offset_ms, connection_revision, reminder_state_json) VALUES ('invalid', 'other', 'https://server.example.test', 'ciphertext', 'account', 'Account', 'org', 'Org', 1, 0, 0, '{}')"))
    assert.throws(() => db.sql.run("INSERT INTO server_connections (id, slot, server_origin, refresh_token_ciphertext, account_id, account_display_name, organization_id, organization_name, received_local_time, server_offset_ms, connection_revision, reminder_state_json) VALUES ('second-candidate', 'candidate', 'https://server.example.test', 'ciphertext', 'account', 'Account', 'org', 'Org', 1, 0, 0, '{}')"))
  })
})

test('opening a pre-server database adds the server schema without rewriting existing records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-db-legacy-'))
  const path = join(root, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  legacy.run("INSERT INTO settings VALUES ('app', '{\"theme\":\"dark\"}')")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()
  const db = await openDb(path)
  try {
    assert.equal(db.getSettings().theme, 'dark')
    assert.equal(tableColumns(db, 'server_connections').includes('refresh_token_ciphertext'), true)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('server connection operations hide candidates and atomically replace current with the next revision', async () => {
  await withDb(async (db) => {
    db.saveServerConnection(connection({ id: 'old-current', slot: 'current', connectionRevision: 3 }))
    db.saveServerConnection(connection({ id: 'new-candidate' }))

    assert.equal(db.getServerConnection('candidate').id, 'new-candidate')
    assert.equal(db.getServerConnection('current').id, 'old-current')
    await db.transaction(() => db.promoteServerConnection({ candidateId: 'new-candidate', nextRevision: 4 }))

    assert.equal(db.getServerConnection('candidate'), null)
    assert.deepEqual(db.getServerConnection('current'), connection({
      id: 'new-candidate', slot: 'current', connectionRevision: 4
    }))
  })
})

test('server projections replace by revision and disconnect cleanup preserves local skill records', async () => {
  await withDb(async (db) => {
    db.saveServerConnection(connection({ id: 'current', slot: 'current', connectionRevision: 1 }))
    db.insertSkillPackage({
      id: 'local-package', name: 'local', description: 'local skill', sourceType: 'directory',
      sourceLocator: 'C:/skills/local', sourceRef: '', sourceSubdir: '', contentSha256: 'local-hash',
      manifest: {}, createdAt: 1, updatedAt: 1
    })
    db.replaceServerModelProfiles({ connectionRevision: 1, profiles: [{
      profileId: 'server-profile', serverOrigin: 'https://server.example.test', organizationId: 'organization-1',
      organizationName: 'Example Org', modelId: 'model-1', adapterId: 'codex', displayName: 'Model One',
      contextSize: 1000, availabilityStatus: 'available', codexFileSha256: 'file-hash'
    }] })
    db.replaceServerSkillVersions({ connectionRevision: 1, versions: [{
      versionId: 'version-1', serverOrigin: 'https://server.example.test', organizationId: 'organization-1',
      slug: 'server-skill', version: '1.0.0', name: 'Server skill', description: 'from server', sha256: 'a'.repeat(64),
      sizeBytes: 10, publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
      downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download', lifecycleStatus: 'ACTIVE'
    }] })
    db.linkServerSkillPackage({ packageId: 'local-package', versionId: 'version-1', serverOrigin: 'https://server.example.test', organizationId: 'organization-1', slug: 'server-skill', version: '1.0.0' })

    assert.equal(db.listServerModelProfiles().length, 1)
    db.clearServerConnections()
    assert.equal(db.getServerConnection('current'), null)
    assert.deepEqual(db.listServerModelProfiles(), [])
    assert.equal(db.sql.exec('SELECT COUNT(*) AS count FROM server_skill_versions')[0].values[0][0], 0)
    assert.equal(db.sql.exec('SELECT COUNT(*) AS count FROM server_skill_packages')[0].values[0][0], 1)
    assert.deepEqual(db.findServerSkillPackage({
      serverOrigin: 'https://server.example.test', organizationId: 'organization-1',
      slug: 'server-skill', version: '1.0.0'
    }), {
      packageId: 'local-package', versionId: 'version-1', serverOrigin: 'https://server.example.test',
      organizationId: 'organization-1', slug: 'server-skill', version: '1.0.0'
    })
    assert.equal(db.getSkillPackage('local-package').id, 'local-package')
    db.deleteSkillPackage('local-package')
    assert.equal(db.getServerSkillPackage('local-package'), null)
  })
})

test('normalized service catalog survives reopen, replaces only its child models, and clears with connections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-service-catalog-'))
  const path = join(root, 'ucli.db')
  const serviceProfileId = stableServiceProfileId({
    serverOrigin: 'http://10.44.100.100:80/path', organizationId: 'org-1'
  })
  const profile = {
    id: serviceProfileId,
    serverOrigin: 'http://10.44.100.100:80/path',
    organization: { id: 'org-1', name: 'Product R&D' },
    connectionRevision: 'revision-1',
    availabilityStatus: 'available'
  }
  const models = [
    { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'], availabilityStatus: 'available' },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'], availabilityStatus: 'available' },
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'], availabilityStatus: 'available' }
  ]
  let db = await openDb(path)
  try {
    db.replaceServerServiceCatalog({ profile, models })
    db.close()

    db = await openDb(path)
    assert.deepEqual(db.listServerServiceProfiles(), [{
      profileId: serviceProfileId,
      serverOrigin: 'http://10.44.100.100',
      organizationId: 'org-1',
      organizationName: 'Product R&D',
      connectionRevision: 'revision-1',
      availabilityStatus: 'available'
    }])
    assert.deepEqual(
      db.listServerServiceModels(serviceProfileId).map((row) => row.modelId),
      ['chat', 'claude', 'responses']
    )
    db.replaceServerServiceCatalog({
      profile: {
        id: 'https://second.example.test::org-2', serverOrigin: 'https://second.example.test',
        organization: { id: 'org-2', name: 'Second Org' }, connectionRevision: 'revision-2', availabilityStatus: 'available'
      },
      models: [{ id: 'other', displayName: 'Other', contextSize: 4096, protocols: ['openai_responses'], availabilityStatus: 'available' }]
    })
    db.replaceServerServiceCatalog({ profile, models: [models[1], models[2]] })
    assert.deepEqual(db.listServerServiceProfiles(), [
      {
        profileId: serviceProfileId,
        serverOrigin: 'http://10.44.100.100',
        organizationId: 'org-1',
        organizationName: 'Product R&D',
        connectionRevision: 'revision-1',
        availabilityStatus: 'available'
      },
      {
        profileId: 'https://second.example.test::org-2',
        serverOrigin: 'https://second.example.test',
        organizationId: 'org-2',
        organizationName: 'Second Org',
        connectionRevision: 'revision-2',
        availabilityStatus: 'available'
      }
    ])
    assert.deepEqual(
      db.listServerServiceModels(serviceProfileId).map((row) => row.modelId),
      ['claude', 'responses']
    )
    assert.deepEqual(db.listServerServiceModels('https://second.example.test::org-2').map((row) => row.modelId), ['other'])
    db.updateServerServiceModelArtifact({ serviceProfileId, modelId: 'responses', codexFileSha256: 'artifact-hash' })
    assert.deepEqual(db.listServerServiceModels(serviceProfileId).map(({ modelId, codexFileSha256 }) => ({
      modelId,
      codexFileSha256
    })), [
      { modelId: 'claude', codexFileSha256: null },
      { modelId: 'responses', codexFileSha256: 'artifact-hash' }
    ])
    db.clearServerConnections()
    assert.deepEqual(db.listServerServiceProfiles(), [])
    assert.deepEqual(db.listServerServiceModels(), [])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('opening a legacy per-adapter catalog migrates selections once and clears unresolved bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-service-migration-'))
  const path = join(root, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL,
    native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules',
    model TEXT, profile_id TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  legacy.run(`CREATE TABLE ai_cli_profiles (
    id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    native_profile_name TEXT UNIQUE, provider_id TEXT, base_url TEXT, model TEXT, reasoning_effort TEXT,
    context_window INTEGER, config_json TEXT NOT NULL DEFAULT '{}', has_secret_hint INTEGER NOT NULL DEFAULT 0,
    file_sha256 TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  legacy.run(`CREATE TABLE ai_cli_profile_bindings (
    scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, adapter_id TEXT NOT NULL, profile_id TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY (scope_type, scope_key, adapter_id)
  )`)
  legacy.run(`CREATE TABLE server_model_profiles (
    profile_id TEXT PRIMARY KEY, server_origin TEXT NOT NULL, organization_id TEXT NOT NULL,
    organization_name TEXT NOT NULL, model_id TEXT NOT NULL, adapter_id TEXT NOT NULL,
    display_name TEXT NOT NULL, context_size INTEGER NOT NULL, connection_revision INTEGER NOT NULL,
    availability_status TEXT NOT NULL, codex_file_sha256 TEXT
  )`)
  for (const [profileId, modelId, adapterId] of [
    ['legacy-codex', 'shared', 'codex'],
    ['legacy-claude', 'shared', 'claude'],
    ['legacy-responses', 'responses-only', 'codex']
  ]) {
    legacy.run(`INSERT INTO server_model_profiles VALUES (?, 'http://10.44.100.100:80', 'org-1', 'Product R&D', ?, ?, ?, 128000, 1, 'available', NULL)`, [profileId, modelId, adapterId, modelId])
  }
  legacy.run(`INSERT INTO sessions VALUES
    ('codex-session', 'F:/project', 'codex', NULL, NULL, '', 'safety-rules', 'shared', 'legacy-codex', 'offline', 1, 2),
    ('claude-session', 'F:/project', 'claude', NULL, NULL, '', 'safety-rules', 'shared', 'legacy-claude', 'offline', 1, 2),
    ('historical-unresolved', 'F:/project', 'codex', NULL, NULL, '', 'safety-rules', 'missing', 'legacy-missing', 'offline', 1, 2)`)
  legacy.run(`INSERT INTO ai_cli_profiles VALUES
    ('local-profile', 'codex', 'Local', 'local', NULL, NULL, NULL, NULL, NULL, NULL, '{}', 0, NULL, 1, 1)`)
  legacy.run(`INSERT INTO ai_cli_profile_bindings VALUES
    ('app', '*', 'codex', 'legacy-codex', 1),
    ('project', 'F:/project', 'claude', 'legacy-claude', 2),
    ('project', 'F:/ambiguous', 'codex', 'legacy-missing', 3),
    ('project', 'F:/local', 'codex', 'local-profile', 4)`)
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const serviceProfileId = 'http://10.44.100.100::org-1'
  let db = await openDb(path)
  try {
    assert.deepEqual(db.listServerServiceProfiles(), [{
      profileId: serviceProfileId, serverOrigin: 'http://10.44.100.100', organizationId: 'org-1',
      organizationName: 'Product R&D', connectionRevision: '1', availabilityStatus: 'available'
    }])
    assert.deepEqual(db.listServerServiceModels(serviceProfileId).map(({ modelId, protocols }) => ({ modelId, protocols })), [
      { modelId: 'responses-only', protocols: ['openai_responses'] },
      { modelId: 'shared', protocols: ['openai_responses', 'anthropic_messages'] }
    ])
    assert.deepEqual(
      ['codex-session', 'claude-session'].map((id) => db.getSession(id)).map(({ profileId, model }) => ({ profileId, model })),
      [{ profileId: serviceProfileId, model: 'shared' }, { profileId: serviceProfileId, model: 'shared' }]
    )
    assert.equal(db.getSession('historical-unresolved').model, 'missing')
    assert.deepEqual(db.listAiCliProfileBindings(), [
      { scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: serviceProfileId, modelId: 'shared', updatedAt: 1 },
      { scopeType: 'project', scopeKey: 'F:/local', adapterId: 'codex', profileId: 'local-profile', modelId: null, updatedAt: 4 },
      { scopeType: 'project', scopeKey: 'F:/project', adapterId: 'claude', profileId: serviceProfileId, modelId: 'shared', updatedAt: 2 }
    ])
    assert.equal(db.sql.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'server_model_profiles'")[0].values[0][0], 0)
    const persisted = {
      profiles: db.listServerServiceProfiles(),
      models: db.listServerServiceModels(),
      bindings: db.listAiCliProfileBindings(),
      sessions: ['codex-session', 'claude-session', 'historical-unresolved'].map((id) => db.getSession(id))
    }
    db.close()
    db = await openDb(path)
    assert.deepEqual({
      profiles: db.listServerServiceProfiles(),
      models: db.listServerServiceModels(),
      bindings: db.listAiCliProfileBindings(),
      sessions: ['codex-session', 'claude-session', 'historical-unresolved'].map((id) => db.getSession(id))
    }, persisted)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy compatibility replacement preserves other normalized service catalogs', async () => {
  await withDb(async (db) => {
    const first = {
      id: 'https://first.example.test::org-1', serverOrigin: 'https://first.example.test',
      organization: { id: 'org-1', name: 'First Org' }, connectionRevision: 'revision-1', availabilityStatus: 'available'
    }
    const second = {
      id: 'https://second.example.test::org-2', serverOrigin: 'https://second.example.test',
      organization: { id: 'org-2', name: 'Second Org' }, connectionRevision: 'revision-2', availabilityStatus: 'available'
    }
    db.replaceServerServiceCatalog({
      profile: first,
      models: [{ id: 'first-model', displayName: 'First', contextSize: 4096, protocols: ['openai_responses'], availabilityStatus: 'available' }]
    })
    db.replaceServerServiceCatalog({
      profile: second,
      models: [{ id: 'second-model', displayName: 'Second', contextSize: 8192, protocols: ['anthropic_messages'], availabilityStatus: 'available' }]
    })
    db.updateServerServiceModelArtifact({
      serviceProfileId: second.id, modelId: 'second-model', codexFileSha256: 'second-artifact'
    })

    db.replaceServerModelProfiles({
      connectionRevision: 'revision-3',
      profiles: [{
        profileId: 'legacy-first', serverOrigin: first.serverOrigin, organizationId: 'org-1',
        organizationName: 'First Org', modelId: 'replacement-model', adapterId: 'codex',
        displayName: 'Replacement', contextSize: 16384, availabilityStatus: 'available'
      }]
    })

    assert.deepEqual(db.listServerServiceModels(second.id), [{
      serviceProfileId: second.id, serverOrigin: second.serverOrigin, organizationId: 'org-2',
      organizationName: 'Second Org', connectionRevision: 'revision-2', modelId: 'second-model',
      displayName: 'Second', contextSize: 8192, protocols: ['anthropic_messages'], availabilityStatus: 'available',
      catalogOrder: 0, codexFileSha256: 'second-artifact'
    }])
  })
})

test('invalid service model protocols reject before replacing an existing catalog', async () => {
  await withDb(async (db) => {
    const profile = {
      id: 'https://server.example.test::org-1', serverOrigin: 'https://server.example.test',
      organization: { id: 'org-1', name: 'Example Org' }, connectionRevision: 'revision-1', availabilityStatus: 'available'
    }
    const priorModels = [{
      id: 'valid-model', displayName: 'Valid', contextSize: 4096,
      protocols: ['openai_responses'], availabilityStatus: 'available'
    }]
    db.replaceServerServiceCatalog({ profile, models: priorModels })
    const persisted = db.listServerServiceModels(profile.id)

    for (const protocols of [[], ['unsupported_protocol']]) {
      assert.throws(() => db.replaceServerServiceCatalog({
        profile,
        models: [{
          id: 'invalid-model', displayName: 'Invalid', contextSize: 4096,
          protocols, availabilityStatus: 'available'
        }]
      }), { code: 'INVALID_SERVICE_MODEL_PROTOCOLS' })
      assert.deepEqual(db.listServerServiceModels(profile.id), persisted)
    }
  })
})
