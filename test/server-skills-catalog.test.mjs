import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSkillsCatalogAdapter } from '../electron/serverConnection/skillsCatalogAdapter.js'
import { openDb } from '../electron/persistence/db.js'

test('sync requests the catalog without a cursor, then advances from the final createdAt value', async () => {
  const requests = []
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 7 }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'access-token'
  }
  const db = {
    transaction: async work => work(),
    replaceServerSkillVersions: ({ versions }) => { db.versions = versions },
    listServerSkillVersions: () => db.versions || []
  }
  const page = Array.from({ length: 100 }, (_value, index) => {
    const createdAt = new Date(Date.UTC(2026, 7, 27, 0, 0, index)).toISOString()
    return {
      id: `version-${index}`, version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
      publishedAt: createdAt, createdAt,
      skill: { slug: `example-${index}`, name: 'Example', description: 'Example skill' },
      downloadUrl: `https://server.example.test/api/v1/skills/version-${index}/download`
    }
  })
  const pages = [page, [], []]
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })

  const items = await adapter.sync()

  assert.equal(items.length, 100)
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://server.example.test/api/v1/skills/catalog',
    'https://server.example.test/api/v1/skills/catalog?cursor=2026-08-27T00%3A01%3A39.000Z',
    'https://server.example.test/api/v1/skills/revocations'
  ])
  assert.equal(requests.every(({ options }) => options.redirect === 'manual' && options.headers.Authorization === 'Bearer access-token'), true)
})

test('catalog rejects non-monotonic rows, duplicate IDs, and a repeated full page before publication', async () => {
  const makeItem = (id, createdAt) => ({
    id, version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
    publishedAt: createdAt, createdAt,
    skill: { slug: id, name: 'Example', description: 'Example skill' },
    downloadUrl: `https://server.example.test/api/v1/skills/${id}/download`
  })
  const fullPage = Array.from({ length: 100 }, (_value, index) => makeItem(
    `version-${index}`, new Date(Date.UTC(2026, 7, 27, 0, 0, index)).toISOString()
  ))
  const cases = [
    {
      name: 'non-monotonic createdAt',
      pages: [[
        makeItem('version-2', '2026-08-27T00:00:02.000Z'),
        makeItem('version-1', '2026-08-27T00:00:01.000Z')
      ]]
    },
    {
      name: 'duplicate version ID',
      pages: [[
        makeItem('version-1', '2026-08-27T00:00:01.000Z'),
        makeItem('version-1', '2026-08-27T00:00:02.000Z')
      ]]
    },
    { name: 'repeated full page and cursor', pages: [fullPage, fullPage] }
  ]

  for (const scenario of cases) {
    let calls = 0
    const db = {
      versions: [{ versionId: 'previous' }],
      transaction: async work => work(),
      replaceServerSkillVersions: ({ versions }) => { db.versions = versions },
      listServerSkillVersions: () => db.versions
    }
    const connectionManager = {
      getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 1 }),
      getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
      getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
      getAccessToken: async () => 'token'
    }
    const adapter = createSkillsCatalogAdapter({
      connectionManager, db, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
      fetchImpl: async url => {
        if (url.endsWith('/revocations')) assert.fail(`${scenario.name} reached revocations`)
        return new Response(JSON.stringify(scenario.pages[calls++]), { headers: { 'content-type': 'application/json' } })
      }
    })
    try {
      await assert.rejects(adapter.sync(), error => error.code === 'SERVER_SKILL_RESPONSE_INVALID')
      assert.deepEqual(db.versions, [{ versionId: 'previous' }])
      if (scenario.name === 'repeated full page and cursor') assert.equal(calls, 2)
    } finally {
      await adapter.shutdown()
    }
  }
})

test('shutdown aborts a hanging catalog body before it can publish', async () => {
  let aborts = 0
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 1 }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const db = { transaction: async work => work(), replaceServerSkillVersions() {}, listServerSkillVersions: () => [] }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
    fetchImpl: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => { aborts += 1; controller.error(new Error('aborted')) }, { once: true })
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const sync = adapter.sync()
  const rejected = assert.rejects(sync, error => error.code === 'SERVER_SKILL_SHUTDOWN')
  await new Promise(resolve => setImmediate(resolve))
  await adapter.shutdown()
  await rejected
  assert.equal(aborts, 1)
})

test('stale catalog publication restores the prior durable catalog after flush', async () => {
  let revision = 1
  let flushes = 0
  const previous = [{ versionId: 'old', serverOrigin: 'https://server.example.test', organizationId: 'org-1', connectionRevision: 1 }]
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: revision }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const db = {
    versions: previous,
    transaction: async work => work(),
    replaceServerSkillVersions: ({ versions }) => { db.versions = versions },
    listServerSkillVersions: () => db.versions,
    flush: async () => { flushes += 1; if (flushes === 1) revision = 2; return true }
  }
  const item = {
    id: 'version-1', version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/revocations') ? [] : [item]))
  })
  await assert.rejects(adapter.sync(), error => error.code === 'SERVER_SKILL_STALE')
  assert.deepEqual(db.versions, previous)
  assert.equal(flushes, 2)
  await adapter.shutdown()
})

test('catalog compensation reports persistence pending when its durable restore fails', async () => {
  let revision = 1
  let flushes = 0
  const previous = [{ versionId: 'old', serverOrigin: 'https://server.example.test', organizationId: 'org-1', connectionRevision: 1 }]
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: revision }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const db = {
    versions: previous,
    transaction: async work => work(),
    replaceServerSkillVersions: ({ versions }) => { db.versions = versions },
    listServerSkillVersions: () => db.versions,
    flush: async () => { flushes += 1; if (flushes === 1) revision = 2; return flushes !== 2 }
  }
  const item = {
    id: 'version-1', version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db, stagingRoot: '.ucli-test-staging', sourceLoader: {}, skillsService: {},
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/revocations') ? [] : [item]))
  })
  await assert.rejects(adapter.sync(), error => error.code === 'SERVER_SKILL_PERSISTENCE_PENDING')
  assert.deepEqual(db.versions, previous)
  assert.equal(flushes, 2)
  await adapter.shutdown()
})

test('stale catalog compensation restores the prior catalog after reopening the database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-catalog-reopen-'))
  let revision = 1
  let flushes = 0
  const previous = {
    versionId: 'old', serverOrigin: 'https://server.example.test', organizationId: 'org-1', slug: 'old', version: '1.0.0',
    name: 'Old', description: 'Old skill', sha256: 'b'.repeat(64), sizeBytes: 1,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    downloadUrl: 'https://server.example.test/api/v1/skills/old/download', lifecycleStatus: 'ACTIVE', connectionRevision: 1
  }
  const db = await openDb(join(root, 'ucli.db'))
  db.replaceServerSkillVersions({ connectionRevision: 1, versions: [previous] })
  await db.flush()
  const wrappedDb = Object.create(db)
  wrappedDb.flush = async () => {
    flushes += 1
    const result = await db.flush()
    if (flushes === 1) revision = 2
    return result
  }
  const connectionManager = {
    getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: revision }),
    getState: () => ({ serverOrigin: 'https://server.example.test', organization: { id: 'org-1' } }),
    getBootstrap: async () => ({ organization: { id: 'org-1' }, skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog' }),
    getAccessToken: async () => 'token'
  }
  const item = {
    id: 'version-1', version: '1.0.0', sha256: 'a'.repeat(64), sizeBytes: 1,
    publishedAt: '2026-08-27T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z',
    skill: { slug: 'example', name: 'Example', description: 'Example skill' },
    downloadUrl: 'https://server.example.test/api/v1/skills/version-1/download'
  }
  const adapter = createSkillsCatalogAdapter({
    connectionManager, db: wrappedDb, stagingRoot: join(root, 'staging'), sourceLoader: {}, skillsService: {},
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/revocations') ? [] : [item]))
  })
  try {
    await assert.rejects(adapter.sync(), error => error.code === 'SERVER_SKILL_STALE')
    db.close()
    const reopened = await openDb(join(root, 'ucli.db'))
    try { assert.deepEqual(reopened.listServerSkillVersions(), [previous]) } finally { reopened.close() }
  } finally {
    await adapter.shutdown()
    try { db.close() } catch { /* closed for reopen verification */ }
    rmSync(root, { recursive: true, force: true })
  }
})
