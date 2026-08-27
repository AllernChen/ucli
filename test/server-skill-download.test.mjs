import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { openDb } from '../electron/persistence/db.js'
import { createSkillsService } from '../electron/skills/service.js'
import { createSkillSourceLoader } from '../electron/skills/sourceLoader.js'
import { createSkillsCatalogAdapter } from '../electron/serverConnection/skillsCatalogAdapter.js'

function archive() {
  const zip = new AdmZip()
  zip.addFile('example/SKILL.md', Buffer.from('---\nname: example\ndescription: Example skill\n---\n\n# Example\n'))
  return zip.toBuffer()
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
