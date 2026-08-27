import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'

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

test('server schema has isolated installation, connection, model, and skill tables with required constraints', async () => {
  await withDb(async (db) => {
    const tables = db.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat()
    for (const name of [
      'server_installation', 'server_connections', 'server_model_profiles',
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
    assert.deepEqual(tableColumns(db, 'server_model_profiles'), [
      'profile_id', 'server_origin', 'organization_id', 'organization_name', 'model_id', 'adapter_id',
      'display_name', 'context_size', 'connection_revision', 'availability_status', 'codex_file_sha256'
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
  })
})
