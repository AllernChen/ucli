import assert from 'node:assert/strict'
import test from 'node:test'

import { createSkillsCatalogAdapter } from '../electron/serverConnection/skillsCatalogAdapter.js'

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
