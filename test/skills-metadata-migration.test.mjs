import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { backfillSkillManagementMetadata } from '../electron/skills/metadataMigration.js'
import { openDb } from '../electron/persistence/db.js'

async function withDb(work) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-metadata-migration-'))
  const db = await openDb(join(root, 'ucli.db'))
  try { await work(db) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const packageRecord = (overrides = {}) => ({
  id: 'server-package',
  name: 'release-notes',
  description: 'Prepare release notes',
  sourceType: 'server',
  sourceLocator: 'https://server.example.test/api/v1/skills/version-1/download',
  sourceRef: 'version-1',
  sourceRefType: 'fixed',
  sourceSubdir: '',
  resolvedRevision: 'a'.repeat(64),
  manifest: { name: 'release-notes', description: 'Prepare release notes' },
  contentSha256: 'a'.repeat(64),
  lastCheckedAt: 100,
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

const installation = (overrides = {}) => ({
  id: 'server-installation',
  packageId: 'server-package',
  targetAdapterId: 'codex',
  scopeType: 'project',
  scopeKey: 'F:\\projects\\demo',
  targetPath: 'F:\\projects\\demo\\.agents\\skills\\release-notes',
  enabled: true,
  deployedSha256: 'a'.repeat(64),
  status: 'ready',
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

function saveCurrentConnection(db, organizationId = 'org-1', organizationName = 'Engineering') {
  db.saveServerConnection({
    id: 'connection-1',
    slot: 'current',
    serverOrigin: 'https://server.example.test',
    refreshTokenCiphertext: 'ciphertext',
    accountId: 'account-1',
    accountDisplayName: 'Ada',
    organizationId,
    organizationName,
    authorizationExpiresAt: null,
    serverTime: null,
    receivedLocalTime: 100,
    serverOffsetMs: 0,
    lastSyncedAt: 100,
    connectionRevision: 1,
    degradedReason: null,
    reminderState: {}
  })
}

test('legacy metadata backfill preserves organization provenance and CLI intent across reruns', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(packageRecord())
    db.insertSkillPackage(packageRecord({
      id: 'local-package', sourceType: 'local', sourceLocator: 'F:\\skills\\release-notes',
      sourceRef: '', sourceRefType: 'fixed', resolvedRevision: null
    }))
    db.insertSkillInstallation(installation())
    db.insertSkillInstallation(installation({
      id: 'local-installation', packageId: 'local-package', targetAdapterId: 'claude', enabled: false,
      deployedSha256: null, status: 'disabled', targetPath: 'F:\\projects\\demo\\.claude\\skills\\release-notes'
    }))
    db.linkServerSkillPackage({
      packageId: 'server-package', versionId: 'version-1', serverOrigin: 'https://server.example.test/catalog',
      organizationId: 'org-1', slug: 'release-notes', version: '1.0.0'
    })
    saveCurrentConnection(db)
    db.replaceServerServiceCatalog({
      profile: {
        id: 'https://server.example.test::org-1', serverOrigin: 'https://server.example.test',
        organization: { id: 'org-1', name: 'Engineering' }, connectionRevision: 1, availabilityStatus: 'ready'
      },
      models: []
    })

    backfillSkillManagementMetadata({ db, now: () => 100 })
    const firstIdentity = db.getSkillSourceIdentity('server-package')
    const firstStates = db.listSkillCliDesiredStates({ packageId: 'server-package' })
    backfillSkillManagementMetadata({ db, now: () => 200 })

    assert.deepEqual(db.getSkillSourceIdentity('server-package'), {
      packageId: 'server-package', originKind: 'organization',
      serverOrigin: 'https://server.example.test', organizationId: 'org-1',
      organizationName: 'Engineering', identityStatus: 'resolved',
      catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64),
      createdAt: 100, updatedAt: 100
    })
    assert.deepEqual(db.getSkillSourceIdentity('server-package'), firstIdentity)
    assert.equal(db.getSkillSourceIdentity('local-package').originKind, 'local')
    assert.equal(db.getSkillSourceIdentity('local-package').serverOrigin, null)
    assert.equal(db.listSkillSourceIdentities().length, 2)

    const states = db.listSkillCliDesiredStates({ packageId: 'server-package' })
    assert.equal(states.find((item) => item.adapterId === 'codex').desiredState, 'enabled')
    assert.equal(states.find((item) => item.adapterId === 'opencode').desiredState, 'inherit')
    assert.deepEqual(states, firstStates)
    assert.equal(db.listSkillCliDesiredStates({ packageId: 'local-package' })
      .find((item) => item.adapterId === 'claude').desiredState, 'disabled')
  })
})

test('legacy metadata backfill uses organization IDs only as pending-name fallbacks', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(packageRecord({
      id: 'pending-package', sourceRef: 'version-pending', resolvedRevision: 'b'.repeat(64)
    }))
    db.linkServerSkillPackage({
      packageId: 'pending-package', versionId: 'version-pending', serverOrigin: 'https://server.example.test',
      organizationId: 'org-missing', slug: 'release-notes', version: '1.0.0'
    })

    backfillSkillManagementMetadata({ db, now: () => 100 })

    assert.deepEqual(db.getSkillSourceIdentity('pending-package'), {
      packageId: 'pending-package', originKind: 'organization',
      serverOrigin: 'https://server.example.test', organizationId: 'org-missing',
      organizationName: 'org-missing', identityStatus: 'name_pending',
      catalogVersionId: 'version-pending', artifactSha256: 'b'.repeat(64),
      createdAt: 100, updatedAt: 100
    })
  })
})
