import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'

async function withDb(work) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-skills-db-'))
  const db = await openDb(join(root, 'ucli.db'))
  try { await work(db) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const skillPackage = (overrides = {}) => ({
  id: 'skill-1',
  name: 'release-notes',
  description: 'Prepare release notes',
  sourceType: 'github',
  sourceLocator: 'https://github.com/example/skills.git',
  sourceRef: 'main',
  sourceRefType: 'branch',
  sourceSubdir: 'release-notes',
  resolvedRevision: 'abc123',
  manifest: { name: 'release-notes', description: 'Prepare release notes' },
  contentSha256: 'package-hash',
  lastCheckedAt: 90,
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

const installation = (overrides = {}) => ({
  id: 'installation-1',
  packageId: 'skill-1',
  targetAdapterId: 'codex',
  scopeType: 'project',
  scopeKey: 'F:\\projects\\demo',
  targetPath: 'F:\\projects\\demo\\.agents\\skills\\release-notes',
  enabled: true,
  deployedSha256: 'package-hash',
  status: 'ready',
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

const sourceIdentity = (overrides = {}) => ({
  packageId: 'skill-1',
  originKind: 'organization',
  serverOrigin: 'https://server.example.test',
  organizationId: 'org-1',
  organizationName: 'Engineering',
  identityStatus: 'resolved',
  catalogVersionId: 'version-1',
  artifactSha256: 'a'.repeat(64),
  createdAt: 100,
  updatedAt: 100,
  ...overrides
})

const desiredState = (overrides = {}) => ({
  packageId: 'skill-1',
  scopeType: 'project',
  scopeKey: 'F:\\projects\\demo',
  adapterId: 'codex',
  desiredState: 'enabled',
  enforcementStatus: 'satisfied',
  reasonCode: null,
  updatedAt: 100,
  ...overrides
})

test('database persists skill packages without credential fields', async () => {
  await withDb(async (db) => {
    const tableNames = db.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat()
    assert.equal(tableNames.includes('skill_packages'), true)
    assert.equal(tableNames.includes('skill_installations'), true)

    db.insertSkillPackage(skillPackage())
    assert.deepEqual(db.getSkillPackage('skill-1'), skillPackage())
    assert.deepEqual(db.listSkillPackages(), [skillPackage()])

    db.updateSkillPackage('skill-1', {
      resolvedRevision: 'def456',
      contentSha256: 'updated-hash',
      lastCheckedAt: 200,
      updatedAt: 200
    })
    assert.deepEqual(db.getSkillPackage('skill-1'), skillPackage({
      resolvedRevision: 'def456',
      contentSha256: 'updated-hash',
      lastCheckedAt: 200,
      updatedAt: 200
    }))
  })
})

test('database persists projection installations and cascades explicit removal', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(skillPackage())
    db.insertSkillInstallation(installation())
    assert.deepEqual(db.listSkillInstallations({ packageId: 'skill-1' }), [installation()])
    assert.deepEqual(db.getSkillInstallation('installation-1'), installation())

    db.updateSkillInstallation('installation-1', {
      enabled: false,
      deployedSha256: null,
      status: 'disabled',
      updatedAt: 200
    })
    assert.deepEqual(db.getSkillInstallation('installation-1'), installation({
      enabled: false,
      deployedSha256: null,
      status: 'disabled',
      updatedAt: 200
    }))

    assert.equal(db.deleteSkillInstallation('installation-1'), true)
    assert.equal(db.deleteSkillPackage('skill-1'), true)
    assert.equal(db.getSkillPackage('skill-1'), null)
  })
})

test('database persists normalized source identities and CLI desired states', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(skillPackage())
    const identity = sourceIdentity({ serverOrigin: 'https://server.example.test/catalog' })
    const expectedIdentity = sourceIdentity()

    db.upsertSkillSourceIdentity(identity)
    assert.deepEqual(db.getSkillSourceIdentity('skill-1'), expectedIdentity)
    assert.deepEqual(db.listSkillSourceIdentities(), [expectedIdentity])

    db.upsertSkillCliDesiredState(desiredState())
    assert.deepEqual(db.listSkillCliDesiredStates({ packageId: 'skill-1' }), [desiredState()])
    assert.deepEqual(db.listSkillCliDesiredStates({
      packageId: 'skill-1', scopeType: 'project', scopeKey: 'F:\\projects\\demo', adapterId: 'codex'
    }), [desiredState()])

    assert.equal(db.deleteSkillCliDesiredStates('skill-1'), true)
    assert.equal(db.listSkillCliDesiredStates({ packageId: 'skill-1' }).length, 0)
    assert.equal(db.deleteSkillSourceIdentity('skill-1'), true)
    assert.equal(db.getSkillSourceIdentity('skill-1'), null)
  })
})

test('database rejects invalid skill source identities', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(skillPackage())
    const invalidIdentities = [
      sourceIdentity({ organizationId: '' }),
      sourceIdentity({ organizationName: '' }),
      sourceIdentity({ catalogVersionId: '' }),
      sourceIdentity({ artifactSha256: 'A'.repeat(64) }),
      sourceIdentity({ originKind: 'invalid' }),
      sourceIdentity({ identityStatus: 'invalid' }),
      sourceIdentity({ serverOrigin: 'not a URL' }),
      sourceIdentity({
        originKind: 'local', serverOrigin: 'https://server.example.test', organizationId: 'org-1',
        organizationName: 'Engineering', catalogVersionId: 'version-1', artifactSha256: 'a'.repeat(64)
      }),
      sourceIdentity({ packageId: 'missing-package' })
    ]

    for (const identity of invalidIdentities) {
      assert.throws(() => db.upsertSkillSourceIdentity(identity), {
        code: 'SKILL_SOURCE_IDENTITY_INVALID'
      })
    }
  })
})

test('database rejects invalid desired-state enums and deletes skill metadata with the package', async () => {
  await withDb(async (db) => {
    db.insertSkillPackage(skillPackage())
    for (const state of [
      desiredState({ scopeType: 'invalid' }),
      desiredState({ desiredState: 'invalid' }),
      desiredState({ enforcementStatus: 'invalid' })
    ]) assert.throws(() => db.upsertSkillCliDesiredState(state))

    db.upsertSkillSourceIdentity(sourceIdentity())
    db.upsertSkillCliDesiredState(desiredState())
    assert.equal(db.deleteSkillPackage('skill-1'), true)
    assert.equal(db.getSkillSourceIdentity('skill-1'), null)
    assert.deepEqual(db.listSkillCliDesiredStates({ packageId: 'skill-1' }), [])
  })
})
