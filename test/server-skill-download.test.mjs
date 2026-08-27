import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { openDb } from '../electron/persistence/db.js'
import { createSkillsService } from '../electron/skills/service.js'
import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'
import { createSkillsCatalogAdapter } from '../electron/serverConnection/skillsCatalogAdapter.js'
import { symlinkOrSkip } from './helpers/fsCapabilities.mjs'

function archive() {
  const zip = new AdmZip()
  zip.addFile('example/SKILL.md', Buffer.from('---\nname: example\ndescription: Example skill\n---\n\n# Example\n'))
  return zip.toBuffer()
}

function serverSource(sha256) {
  return {
    locator: 'https://server.example.test/organizations/org-1/skills/example', versionId: 'version-1',
    serverOrigin: 'https://server.example.test', organizationId: 'org-1', slug: 'example', version: '1.0.0', sha256
  }
}

async function createFailedServerReuse(root) {
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const archivePath = join(root, 'server.zip')
  writeFileSync(archivePath, bytes)
  const db = await openDb(join(root, 'ucli.db'))
  let stale = false
  let reusing = false
  let reuseFlushes = 0
  let failCompensationFlush = true
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const service = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    flush: async () => {
      if (!reusing) return db.flush()
      reuseFlushes += 1
      if (reuseFlushes === 2 && failCompensationFlush) return false
      const result = await db.flush()
      if (reuseFlushes === 1) stale = true
      return result
    }
  })
  const targets = (targetAdapterIds) => ({
    targetAdapterIds, scopeType: 'project', projectPath: join(root, 'project')
  })
  const initial = await service.installVerifiedServerArchive({
    archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256), targets: targets(['codex'])
  })
  return {
    db,
    initial,
    installMissingProjection: () => {
      reusing = true
      return service.installVerifiedServerArchive({
        archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256), targets: targets(['claude']),
        guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
      })
    }
  }
}

async function failNewServerInstallAfterPersistence(root, { packageId, marker = false, driftCurrent = false }) {
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const archivePath = join(root, 'server.zip')
  const packageParent = join(root, 'user-data', 'skills', 'packages', packageId)
  writeFileSync(archivePath, bytes)
  const db = await openDb(join(root, 'ucli.db'))
  let stale = false
  let identifiers = [packageId, 'stale-installation']
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const service = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    uuid: () => identifiers.shift(),
    flush: async () => {
      const result = await db.flush()
      if (!stale) {
        if (marker) writeFileSync(join(packageParent, 'keep'), 'keep')
        if (driftCurrent) writeFileSync(join(packageParent, 'current', 'SKILL.md'), 'externally modified')
        stale = true
      }
      return result
    }
  })
  await assert.rejects(service.installVerifiedServerArchive({
    archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256),
    targets: { targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project') },
    guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
  }), error => error.code === 'SERVER_SKILL_STALE')
  return { db, packageParent }
}

test('verified server archive installs with sanitized provenance and removes staging data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-download-'))
  const archiveBytes = archive()
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
  const db = await openDb(join(root, 'ucli.db'))
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const skillsService = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    flush: () => db.flush()
  })
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 1 }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'test-access-token'
  }
  const catalogItem = {
    id: 'version-1', version: '1.0.0', sha256, sizeBytes: archiveBytes.length,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  const requests = []
  const stagingRoot = join(root, 'server-staging')
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, sourceLoader, skillsService, stagingRoot,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/catalog')) return new Response(JSON.stringify([catalogItem]), { status: 200 })
      if (url.endsWith('/revocations')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response(archiveBytes, { status: 200, headers: {
        'content-type': 'application/zip', 'content-length': String(archiveBytes.length), 'x-ucli-sha256': sha256
      } })
    }
  })
  try {
    await adapter.sync()
    const installed = await adapter.install('version-1', {
      targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project')
    })
    assert.equal(installed.sourceType, 'server')
    assert.equal(installed.sourceLocator.includes('server-staging'), false)
    assert.equal(JSON.stringify(db.listSkillPackages()).includes('test-access-token'), false)
    assert.deepEqual(db.getServerSkillPackage(installed.id), {
      packageId: installed.id, versionId: 'version-1', serverOrigin: 'https://server.example.test',
      organizationId: 'org-1', slug: 'example', version: '1.0.0'
    })
    let view = (await skillsService.getState({ projectPath: join(root, 'project') })).packages.find(item => item.id === installed.id)
    assert.deepEqual({ lifecycleStatus: view.server.lifecycleStatus, warning: view.server.warning, available: view.server.available }, {
      lifecycleStatus: 'ACTIVE', warning: null, available: true
    })
    const revoked = db.listServerSkillVersions().map(item => ({ ...item, lifecycleStatus: 'REVOKED' }))
    db.replaceServerSkillVersions({ connectionRevision: 1, versions: revoked })
    view = (await skillsService.getState({ projectPath: join(root, 'project') })).packages.find(item => item.id === installed.id)
    assert.deepEqual({ lifecycleStatus: view.server.lifecycleStatus, warning: view.server.warning, available: view.server.available }, {
      lifecycleStatus: 'REVOKED', warning: 'revoked', available: true
    })
    const staged = existsSync(stagingRoot)
      ? readdirSync(stagingRoot, { recursive: true }).filter(entry => String(entry).endsWith('.zip'))
      : []
    assert.deepEqual(staged, [])
    const download = requests.find(({ url }) => url.endsWith('/download'))
    assert.equal(download.options.headers.Authorization, 'Bearer test-access-token')
  } finally {
    await adapter.shutdown()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('catalog rejects query-bearing download URLs before any archive request', async () => {
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 1 }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
    db: { transaction: async work => work(), replaceServerSkillVersions() {}, listServerSkillVersions: () => [] },
    fetchImpl: async () => new Response(JSON.stringify([{
      id: 'version-1', version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
      publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
      skill: { slug: 'example', name: 'Example', description: 'Example skill' },
      downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download?secret=no'
    }]), { status: 200 })
  })
  await assert.rejects(adapter.sync(), error => error.code === 'SERVER_RESPONSE_INVALID')
  await adapter.shutdown()
})

test('stale connection identity reaches the internal install guard before a server archive can commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-'))
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let revision = 1
  let committed = false
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: revision }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const db = {
    transaction: async work => work(), replaceServerSkillVersions: ({ versions }) => { db.versions = versions },
    listServerSkillVersions: () => db.versions || []
  }
  const item = {
    id: 'version-1', version: '1.0.0', sha256, sizeBytes: bytes.length,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, stagingRoot: join(root, 'staging'), sourceLoader: {},
    skillsService: { installVerifiedServerArchive: async payload => { revision = 2; payload.guard(); committed = true } },
    fetchImpl: async url => url.endsWith('/catalog') ? new Response(JSON.stringify([item]))
      : url.endsWith('/revocations') ? new Response(JSON.stringify([]))
        : new Response(bytes, { headers: { 'content-type': 'application/zip', 'x-ucli-sha256': sha256 } })
  })
  try {
    await adapter.sync()
    await assert.rejects(adapter.install('version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' }),
      error => error.code === 'SERVER_SKILL_STALE')
    assert.equal(committed, false)
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test('substituted private staging root is rejected before a download request writes bytes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-staging-swap-'))
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const external = join(root, 'external')
  mkdirSync(external)
  let requests = 0
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 1 }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const item = {
    id: 'version-1', version: '1.0.0', sha256, sizeBytes: bytes.length,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  let swapped = false
  const adapter = createSkillsCatalogAdapter({
    connectionManager, stagingRoot: join(root, 'staging'), sourceLoader: {}, skillsService: {},
    db: { transaction: async work => work(), replaceServerSkillVersions() {}, listServerSkillVersions: () => [] },
    onStagingOpen({ root: privateRoot }) {
      rmSync(privateRoot, { recursive: true, force: true })
      swapped = symlinkOrSkip(t, external, privateRoot, process.platform === 'win32' ? 'junction' : 'dir')
    },
    fetchImpl: async url => {
      if (url.endsWith('/catalog')) return new Response(JSON.stringify([item]))
      if (url.endsWith('/revocations')) return new Response(JSON.stringify([]))
      requests += 1
      return new Response(bytes, { headers: { 'content-type': 'application/zip', 'x-ucli-sha256': sha256 } })
    }
  })
  try {
    await adapter.sync()
    if (!swapped) return
    await assert.rejects(adapter.install('version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' }),
      error => error.code === 'SERVER_SKILL_STAGING_INVALID')
    assert.equal(requests, 0)
    assert.deepEqual(readdirSync(external), [])
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale new server install removes its empty direct package parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-package-parent-'))
  let db
  try {
    ({ db } = await failNewServerInstallAfterPersistence(root, { packageId: 'stale-package' }))
    assert.equal(existsSync(join(root, 'user-data', 'skills', 'packages', 'stale-package', 'current')), false)
    assert.equal(existsSync(join(root, 'user-data', 'skills', 'packages', 'stale-package')), false)
  } finally {
    try { db?.close() } catch { /* test cleanup */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale new server install preserves a nonempty package parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-nonempty-package-parent-'))
  let db
  try {
    const result = await failNewServerInstallAfterPersistence(root, { packageId: 'nonempty-package', marker: true })
    db = result.db
    assert.equal(existsSync(join(result.packageParent, 'current')), false)
    assert.equal(existsSync(join(result.packageParent, 'keep')), true)
  } finally {
    try { db?.close() } catch { /* test cleanup */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale new server install preserves a drifted package parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-drifted-package-parent-'))
  let db
  try {
    const result = await failNewServerInstallAfterPersistence(root, { packageId: 'drifted-package', driftCurrent: true })
    db = result.db
    assert.equal(existsSync(join(result.packageParent, 'current')), true)
  } finally {
    try { db?.close() } catch { /* test cleanup */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale new server install never removes matching content behind a substituted package parent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-package-junction-'))
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const archivePath = join(root, 'server.zip')
  const packageId = 'substituted-package'
  const packageParent = join(root, 'user-data', 'skills', 'packages', packageId)
  const external = join(root, 'external-package')
  let db
  let externalCurrentIdentity
  let externalSkillContents
  try {
    writeFileSync(archivePath, bytes)
    db = await openDb(join(root, 'ucli.db'))
    let stale = false
    let identifiers = [packageId, 'stale-installation']
    const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
    const service = createSkillsService({
      db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
      uuid: () => identifiers.shift(),
      flush: async () => {
        const result = await db.flush()
        if (!stale) {
          mkdirSync(external)
          cpSync(join(packageParent, 'current'), join(external, 'current'), { recursive: true })
          externalCurrentIdentity = lstatSync(join(external, 'current'))
          externalSkillContents = readFileSync(join(external, 'current', 'SKILL.md'), 'utf8')
          rmSync(packageParent, { recursive: true, force: true })
          if (!symlinkOrSkip(t, external, packageParent, process.platform === 'win32' ? 'junction' : 'dir')) return result
          stale = true
        }
        return result
      }
    })

    await assert.rejects(service.installVerifiedServerArchive({
      archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256),
      targets: { targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project') },
      guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
    }), error => error.code === 'SERVER_SKILL_STALE')

    assert.equal(existsSync(join(external, 'current')), true)
    const current = lstatSync(join(external, 'current'))
    assert.equal(current.dev, externalCurrentIdentity.dev)
    assert.equal(current.ino, externalCurrentIdentity.ino)
    assert.equal(readFileSync(join(external, 'current', 'SKILL.md'), 'utf8'), externalSkillContents)
  } finally {
    try { db?.close() } catch { /* test cleanup */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale new server install preserves an out-of-root package directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-outside-package-parent-'))
  let db
  const outsidePackageId = join('..', 'outside-package-parent')
  const outsideParent = join(root, 'user-data', 'skills', 'outside-package-parent')
  try {
    ({ db } = await failNewServerInstallAfterPersistence(root, { packageId: outsidePackageId }))
    assert.equal(existsSync(join(outsideParent, 'current')), true)
    assert.equal(existsSync(outsideParent), true)
  } finally {
    try { db?.close() } catch { /* test cleanup */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale server install after flush removes its new database rows and projections durably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-install-'))
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const archivePath = join(root, 'server.zip')
  writeFileSync(archivePath, bytes)
  const db = await openDb(join(root, 'ucli.db'))
  let stale = false
  let triggerStale = false
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const service = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    flush: async () => {
      const result = await db.flush()
      if (triggerStale) stale = true
      return result
    }
  })
  try {
    triggerStale = true
    await assert.rejects(service.installVerifiedServerArchive({
      archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256),
      targets: { targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project') },
      guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
    }), error => error.code === 'SERVER_SKILL_STALE')
    assert.deepEqual(db.listSkillPackages(), [])
    assert.deepEqual(db.listSkillInstallations(), [])
    assert.deepEqual(db.listServerSkillPackagesForSkill({
      serverOrigin: 'https://server.example.test', organizationId: 'org-1', slug: 'example'
    }), [])
    db.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try {
      assert.deepEqual(reopened.listSkillPackages(), [])
      assert.deepEqual(reopened.listSkillInstallations(), [])
    } finally { reopened.close() }
  } finally {
    try { db.close() } catch { /* already closed for reopen verification */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed stale-install compensation remains recoverable by a later database flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-pending-install-'))
  const bytes = archive()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const archivePath = join(root, 'server.zip')
  writeFileSync(archivePath, bytes)
  const db = await openDb(join(root, 'ucli.db'))
  let stale = false
  let flushes = 0
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const service = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    flush: async () => {
      flushes += 1
      if (flushes === 2) return false
      const result = await db.flush()
      if (flushes === 1) stale = true
      return result
    }
  })
  try {
    await assert.rejects(service.installVerifiedServerArchive({
      archivePath, archiveIdentity: lstatSync(archivePath), source: serverSource(sha256),
      targets: { targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project') },
      guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
    }), error => error.code === 'SKILL_PERSISTENCE_PENDING')
    assert.deepEqual(db.listSkillPackages(), [])
    assert.deepEqual(db.listSkillInstallations(), [])
    await db.flush()
    db.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try {
      assert.deepEqual(reopened.listSkillPackages(), [])
      assert.deepEqual(reopened.listSkillInstallations(), [])
    } finally { reopened.close() }
  } finally {
    try { db.close() } catch { /* already closed for reopen verification */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed stale reuse compensation reports pending while a crash retains the durably inserted projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-pending-reuse-crash-'))
  let db
  try {
    const setup = await createFailedServerReuse(root)
    db = setup.db
    await assert.rejects(setup.installMissingProjection(), error => error.code === 'SKILL_PERSISTENCE_PENDING')
    assert.deepEqual(db.listSkillInstallations({ packageId: setup.initial.id }).map(item => item.targetAdapterId), ['codex'])

    // Do not call Db.close(): it flushes. Closing sql.js directly models a process
    // ending after the failed compensation flush, before the next scheduled retry.
    db.sql.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try {
      assert.deepEqual(
        reopened.listSkillInstallations({ packageId: setup.initial.id }).map(item => item.targetAdapterId).sort(),
        ['claude', 'codex']
      )
    } finally { reopened.sql.close() }
  } finally {
    try { db?.sql.close() } catch { /* simulated crash may have already closed it */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('a later flush converges failed stale reuse compensation before reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-pending-reuse-retry-'))
  let db
  try {
    const setup = await createFailedServerReuse(root)
    db = setup.db
    await assert.rejects(setup.installMissingProjection(), error => error.code === 'SKILL_PERSISTENCE_PENDING')
    assert.deepEqual(db.listSkillInstallations({ packageId: setup.initial.id }).map(item => item.targetAdapterId), ['codex'])
    await db.flush()
    db.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try {
      assert.deepEqual(reopened.listSkillInstallations({ packageId: setup.initial.id }).map(item => item.targetAdapterId), ['codex'])
    } finally { reopened.close() }
  } finally {
    try { db?.close() } catch { /* closed for reopen verification */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale enable after flush restores a disabled installation without its projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-skill-stale-enable-'))
  const db = await openDb(join(root, 'ucli.db'))
  let stale = false
  let triggerStale = false
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\n')
  const sourceLoader = createSkillSourceLoader({ stagingRoot: join(root, 'source-staging') })
  const service = createSkillsService({
    db, userDataPath: join(root, 'user-data'), home: join(root, 'home'), sourceLoader,
    flush: async () => {
      const result = await db.flush()
      if (triggerStale) stale = true
      return result
    }
  })
  try {
    const installed = await service.install({
      source: { type: 'local', path: source }, targetAdapterIds: ['codex'], scopeType: 'project', projectPath: join(root, 'project')
    })
    const installation = installed.installations[0]
    await service.setEnabled(installation.id, false)
    triggerStale = true
    await assert.rejects(service.setEnabled(installation.id, true, {
      guard: () => { if (stale) throw Object.assign(new Error('stale'), { code: 'SERVER_SKILL_STALE' }) }
    }), error => error.code === 'SERVER_SKILL_STALE')
    const restored = db.getSkillInstallation(installation.id)
    assert.equal(restored.enabled, false)
    assert.equal(restored.status, 'disabled')
    assert.equal(existsSync(restored.targetPath), false)
    db.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try {
      const persisted = reopened.getSkillInstallation(installation.id)
      assert.equal(persisted.enabled, false)
      assert.equal(existsSync(persisted.targetPath), false)
    } finally { reopened.close() }
  } finally {
    try { db.close() } catch { /* already closed for reopen verification */ }
    rmSync(root, { recursive: true, force: true })
  }
})
