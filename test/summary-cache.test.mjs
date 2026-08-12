import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  cacheKeyForInvocation,
  createSummaryCacheService
} from '../electron/summaries/summaryCacheService.js'

class MemoryCacheRepository {
  constructor() {
    this.entries = new Map()
    this.onUpsert = null
  }

  getSummaryCacheEntry(key) {
    return this.entries.has(key) ? structuredClone(this.entries.get(key)) : null
  }

  upsertSummaryCacheEntry(entry) {
    this.onUpsert?.(entry)
    this.entries.set(entry.key, structuredClone(entry))
    return structuredClone(entry)
  }

  touchSummaryCacheEntry(key, at) {
    const entry = this.entries.get(key)
    if (!entry) return null
    entry.lastAccessedAt = at
    return structuredClone(entry)
  }

  listSummaryCacheEntries() {
    return [...this.entries.values()].map(entry => structuredClone(entry))
  }

  deleteSummaryCacheEntries(keys) {
    let removed = 0
    for (const key of new Set(keys)) removed += this.entries.delete(key) ? 1 : 0
    return removed
  }
}

async function harness(t, options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucli-summary-cache-test-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const root = join(temporaryRoot, 'summary')
  const repository = options.repository || new MemoryCacheRepository()
  return {
    root,
    repository,
    temporaryRoot,
    cache: createSummaryCacheService({ root, repository, ...options })
  }
}

const invocation = {
  stage: 'map',
  prompt: 'exact prompt',
  schema: {
    type: 'object',
    properties: { z: { type: 'number' }, a: { type: 'string' } }
  },
  executorId: 'claude',
  profileFingerprint: 'profile:abc',
  model: 'sonnet',
  promptVersion: 'summary-v2'
}

test('cache keys use stable canonical JSON and cover every semantic input', () => {
  const expected = 'sha256:59e0991b5e2d5b806976e6a9892e397f49ae1b7907af2c82e6e9ab4d8c7bd3b6'
  assert.equal(cacheKeyForInvocation(invocation), expected)
  assert.equal(cacheKeyForInvocation({
    ...invocation,
    schema: {
      properties: { a: { type: 'string' }, z: { type: 'number' } },
      type: 'object'
    }
  }), expected)

  for (const changed of [
    { stage: 'project' },
    { prompt: 'different prompt' },
    { schema: { type: 'array' } },
    { executorId: 'opencode' },
    { profileFingerprint: 'profile:def' },
    { model: 'opus' },
    { promptVersion: 'summary-v3' }
  ]) {
    assert.notEqual(cacheKeyForInvocation({ ...invocation, ...changed }), expected)
  }
})

test('put writes an immutable content-addressed file before safe metadata', async t => {
  const { root, repository, cache } = await harness(t, { now: () => 1000 })
  const key = cacheKeyForInvocation(invocation)
  let fileExistedAtUpsert = false
  repository.onUpsert = entry => {
    fileExistedAtUpsert = existsSync(join(root, 'cache', ...entry.relativePath.split('/')))
  }

  await cache.put({ key, kind: 'map', value: { project: 'A' } })

  assert.equal(fileExistedAtUpsert, true)
  assert.deepEqual(await cache.get(key), { project: 'A' })
  const [metadata] = repository.listSummaryCacheEntries()
  assert.deepEqual(metadata, {
    key,
    kind: 'map',
    relativePath: `map/${key.slice(7, 9)}/${key.slice(7)}.json`,
    sizeBytes: Buffer.byteLength('{"version":1,"value":{"project":"A"}}'),
    createdAt: 1000,
    lastAccessedAt: 1000,
    expiresAt: null
  })
  const serializedMetadata = JSON.stringify(metadata)
  assert.equal(serializedMetadata.includes('exact prompt'), false)
  assert.equal(serializedMetadata.includes('profile:abc'), false)
  assert.equal(serializedMetadata.includes('project'), false)
})

test('concurrent duplicate puts retain one final file and no temporary files', async t => {
  const { root, repository, cache } = await harness(t, { now: () => 1000 })
  const key = cacheKeyForInvocation(invocation)

  await Promise.all([
    cache.put({ key, kind: 'map', value: { project: 'A' } }),
    cache.put({ key, kind: 'map', value: { project: 'A' } })
  ])

  const directory = join(root, 'cache', 'map', key.slice(7, 9))
  assert.deepEqual(await readdir(directory), [`${key.slice(7)}.json`])
  assert.equal(repository.listSummaryCacheEntries().length, 1)
  assert.deepEqual(await cache.get(key), { project: 'A' })
})

test('a published cache key remains immutable when a later value differs', async t => {
  const { repository, cache } = await harness(t, { now: () => 1000 })
  const key = cacheKeyForInvocation(invocation)
  await cache.put({ key, kind: 'map', value: { project: 'first' } })
  const original = repository.getSummaryCacheEntry(key)

  await cache.put({ key, kind: 'map', value: { project: 'replacement' } })

  assert.deepEqual(await cache.get(key), { project: 'first' })
  assert.equal(repository.getSummaryCacheEntry(key).sizeBytes, original.sizeBytes)
})

test('put restores metadata for a valid file orphaned before database indexing', async t => {
  const { root, repository, cache } = await harness(t, { now: () => 2000 })
  const key = cacheKeyForInvocation(invocation)
  const hex = key.slice(7)
  const directory = join(root, 'cache', 'map', hex.slice(0, 2))
  const target = join(directory, `${hex}.json`)
  const encoded = '{"version":1,"value":{"project":"survived"}}'
  await mkdir(directory, { recursive: true })
  await writeFile(target, encoded)

  assert.deepEqual(
    await cache.put({ key, kind: 'map', value: { project: 'replacement' } }),
    { project: 'survived' }
  )
  assert.deepEqual(await cache.get(key), { project: 'survived' })
  assert.equal(repository.getSummaryCacheEntry(key).sizeBytes, Buffer.byteLength(encoded))
})

test('put rejects entries over the injected limit without a file or index row', async t => {
  const { root, repository, cache } = await harness(t, {
    now: () => 1000,
    maxEntryBytes: 32
  })
  const key = cacheKeyForInvocation(invocation)

  await assert.rejects(
    cache.put({ key, kind: 'map', value: { text: 'too large for this fixture' } }),
    error => error?.code === 'SUMMARY_CACHE_ENTRY_LIMIT'
  )

  assert.equal(repository.getSummaryCacheEntry(key), null)
  assert.equal(existsSync(join(root, 'cache', 'map', key.slice(7, 9), `${key.slice(7)}.json`)), false)
})

test('get removes missing, oversized, corrupt, and wrong-version entries as misses', async t => {
  const { root, repository, cache } = await harness(t, {
    now: () => 2000,
    maxEntryBytes: 80
  })
  const cases = [
    { suffix: 'missing', content: null },
    { suffix: 'oversized', content: 'x'.repeat(81) },
    { suffix: 'corrupt', content: '{broken' },
    { suffix: 'version', content: '{"version":2,"value":{"ok":true}}' }
  ]
  for (const [index, fixture] of cases.entries()) {
    const key = cacheKeyForInvocation({ ...invocation, prompt: fixture.suffix })
    const hex = key.slice(7)
    const relativePath = `map/${hex.slice(0, 2)}/${hex}.json`
    const target = join(root, 'cache', ...relativePath.split('/'))
    if (fixture.content !== null) {
      await mkdir(join(root, 'cache', 'map', hex.slice(0, 2)), { recursive: true })
      await writeFile(target, fixture.content)
    }
    repository.upsertSummaryCacheEntry({
      key, kind: 'map', relativePath,
      sizeBytes: fixture.content === null ? 12 : Buffer.byteLength(fixture.content),
      createdAt: 1000 + index, lastAccessedAt: 1000 + index, expiresAt: null
    })

    assert.equal(await cache.get(key), null)
    assert.equal(repository.getSummaryCacheEntry(key), null)
    assert.equal(existsSync(target), false)
  }
})

test('get rejects out-of-root metadata without touching the external file', async t => {
  const { root, temporaryRoot, repository, cache } = await harness(t)
  const key = cacheKeyForInvocation(invocation)
  const outside = join(temporaryRoot, 'keep.json')
  await writeFile(outside, 'keep')
  repository.entries.set(key, {
    key,
    kind: 'map',
    relativePath: '../keep.json',
    sizeBytes: 4,
    createdAt: 1000,
    lastAccessedAt: 1000,
    expiresAt: null
  })

  assert.equal(await cache.get(key), null)
  assert.equal(await readFile(outside, 'utf8'), 'keep')
  assert.equal(repository.getSummaryCacheEntry(key), null)
  assert.equal(existsSync(root), false)
})

test('prune removes least-recent entries with stable tie breaking until within quota', async t => {
  const encodedSize = Buffer.byteLength('{"version":1,"value":{"n":1}}')
  const { repository, cache } = await harness(t, {
    now: () => 5000,
    quotaBytes: encodedSize * 2
  })
  const keys = ['c', 'a', 'b'].map(prompt => cacheKeyForInvocation({ ...invocation, prompt }))
  for (const key of keys) {
    await cache.put({ key, kind: 'map', value: { n: 1 } })
    const entry = repository.getSummaryCacheEntry(key)
    repository.upsertSummaryCacheEntry({ ...entry, createdAt: 1000, lastAccessedAt: 1000 })
  }

  const expectedRemoved = [...keys].sort()[0]
  assert.deepEqual(await cache.prune(), { removed: 1, bytes: encodedSize * 2 })
  assert.equal(repository.getSummaryCacheEntry(expectedRemoved), null)
  assert.deepEqual(await cache.stats(), {
    bytes: encodedSize * 2,
    entries: 2,
    quotaBytes: encodedSize * 2
  })
})

test('clear deletes only the guarded cache subtree and all cache metadata', async t => {
  const { root, temporaryRoot, repository, cache } = await harness(t)
  const key = cacheKeyForInvocation(invocation)
  await cache.put({ key, kind: 'map', value: { project: 'A' } })
  const outside = join(temporaryRoot, 'keep.txt')
  await writeFile(outside, 'keep')
  await mkdir(join(root, 'cache', 'orphan'), { recursive: true })
  await writeFile(join(root, 'cache', 'orphan', 'stale.txt'), 'stale')

  assert.deepEqual(await cache.clear(), { removed: 1, bytes: 0 })
  assert.equal(existsSync(join(root, 'cache')), false)
  assert.equal(await readFile(outside, 'utf8'), 'keep')
  assert.deepEqual(repository.listSummaryCacheEntries(), [])
})

test('evict removes one validated cache entry and safely ignores missing metadata', async t => {
  const { root, repository, cache } = await harness(t)
  const key = cacheKeyForInvocation(invocation)
  await cache.put({ key, kind: 'map', value: { project: 'A' } })
  const target = join(root, 'cache', 'map', key.slice(7, 9), `${key.slice(7)}.json`)

  assert.equal(await cache.evict(key), true)
  assert.equal(existsSync(target), false)
  assert.equal(repository.getSummaryCacheEntry(key), null)
  assert.equal(await cache.evict(key), false)
})

test('evict drops unsafe metadata without touching an external file', async t => {
  const { temporaryRoot, repository, cache } = await harness(t)
  const key = cacheKeyForInvocation(invocation)
  const outside = join(temporaryRoot, 'keep.json')
  await writeFile(outside, 'keep')
  repository.entries.set(key, {
    key, kind: 'map', relativePath: '../keep.json', sizeBytes: 4,
    createdAt: 1000, lastAccessedAt: 1000, expiresAt: null
  })

  assert.equal(await cache.evict(key), true)
  assert.equal(await readFile(outside, 'utf8'), 'keep')
  assert.equal(repository.getSummaryCacheEntry(key), null)
})

test('verify removes corrupt metadata best-effort and returns only bounded counters', async t => {
  const { root, repository, cache } = await harness(t)
  const keys = ['a', 'b', 'c'].map(prompt => cacheKeyForInvocation({ ...invocation, prompt }))
  await cache.put({ key: keys[0], kind: 'map', value: { ok: true } })
  await cache.put({ key: keys[1], kind: 'final', value: { ok: true } })
  const broken = repository.getSummaryCacheEntry(keys[1])
  await writeFile(join(root, 'cache', ...broken.relativePath.split('/')), '{broken')
  repository.upsertSummaryCacheEntry({
    key: keys[2], kind: 'project', relativePath: `project/${keys[2].slice(7, 9)}/${keys[2].slice(7)}.json`,
    sizeBytes: 12, createdAt: 1, lastAccessedAt: 1, expiresAt: null
  })

  const result = await cache.verify()
  assert.deepEqual(result, { checked: 3, removed: 2, bytes: 33 })
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'checked', 'removed'])
  assert.equal(repository.getSummaryCacheEntry(keys[0]) !== null, true)
  assert.equal(repository.getSummaryCacheEntry(keys[1]), null)
  assert.equal(repository.getSummaryCacheEntry(keys[2]), null)
})
