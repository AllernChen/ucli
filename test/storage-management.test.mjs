import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createStorageManagementService } from '../electron/storage/storageManagementService.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ucli-storage-management-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  const userData = join(root, 'user-data')
  await mkdir(userData, { recursive: true })
  return {
    root,
    markerPath: join(userData, 'storage-cleanup.json'),
    roots: {
      userData,
      logs: join(userData, 'ucli.log'),
      descriptors: [
        { id: 'core-data', roots: [{ path: userData }] },
        { id: 'summary-cache', roots: [{ path: join(root, 'cache') }] },
        { id: 'summary-workspaces', roots: [{ path: join(root, 'workspaces') }] },
        { id: 'browser-cache', roots: [{ path: join(root, 'browser') }] },
        { id: 'skill-staging', roots: [{ path: join(userData, 'skills', '.source-staging') }] },
        { id: 'update-downloads', roots: [{ path: join(root, 'ucli-updater') }] },
        { id: 'logs', roots: [{ path: join(userData, 'ucli.log') }] }
      ]
    }
  }
}

function scannerFor(sizes = {}) {
  return async descriptors => descriptors.map(({ id }) => ({
    id,
    bytes: sizes[id] || 0,
    itemCount: sizes[id] ? 1 : 0,
    status: 'ready'
  }))
}

test('protected and unknown categories are rejected without invoking cleanup', async t => {
  const { roots } = await fixture(t)
  let cleared = false
  const service = createStorageManagementService({
    scanner: scannerFor(), roots,
    summaryCache: { async clear() { cleared = true } },
    summaryWorkspaces: { async clearDerived() { cleared = true } },
    logger: { async truncate() { cleared = true } }
  })
  await assert.rejects(() => service.clear({ categoryId: 'core-data' }), error =>
    error?.code === 'STORAGE_CATEGORY_PROTECTED')
  for (const categoryId of ['../browser-cache', 'C:\\cache', '/tmp/cache', 'unknown']) {
    await assert.rejects(() => service.clear({ categoryId }), error =>
      error?.code === 'STORAGE_CATEGORY_UNKNOWN')
  }
  assert.equal(cleared, false)
})

test('usage snapshots expose fixed policies, safe totals, revisions, and scheduled status only', async t => {
  const { roots, markerPath } = await fixture(t)
  await writeFile(markerPath, JSON.stringify({ version: 1, categories: ['browser-cache'] }))
  const service = createStorageManagementService({
    roots, now: () => 123,
    scanner: async descriptors => descriptors.map(({ id }) => ({
      id, bytes: id === 'core-data' ? 7 : id === 'browser-cache' ? 11 : 0,
      itemCount: 1, status: 'ready', path: 'must-not-leak'
    })),
    summaryCache: { clear: async () => ({ removed: 0, bytes: 0 }) },
    summaryWorkspaces: { clearDerived: async () => ({ removed: 0, bytes: 0 }) },
    logger: { truncate: async () => {} }
  })
  const first = await service.getUsage()
  const second = await service.getUsage()
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.equal(first.scannedAt, 123)
  assert.equal(first.totalBytes, 18)
  assert.equal(first.reclaimableBytes, 11)
  assert.deepEqual(first.pendingRestart, ['browser-cache'])
  assert.equal(first.categories.find(item => item.id === 'core-data').clearMode, 'none')
  assert.equal(first.categories.find(item => item.id === 'browser-cache').status, 'scheduled')
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|path/i)
})

test('restart cleanup writes only fixed category IDs to one atomic marker', async t => {
  const { roots, markerPath } = await fixture(t)
  const service = createStorageManagementService({
    scanner: scannerFor(), roots,
    summaryCache: { clear: async () => ({ removed: 0, bytes: 0 }) },
    summaryWorkspaces: { clearDerived: async () => ({ removed: 0, bytes: 0 }) },
    logger: { truncate: async () => {} }
  })
  assert.deepEqual(await service.clear({ categoryId: 'browser-cache' }), {
    categoryId: 'browser-cache', pendingRestart: true
  })
  await service.clear({ categoryId: 'skill-staging' })
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), {
    version: 1,
    categories: ['browser-cache', 'skill-staging']
  })
})

test('restart cleanup refuses to replace an invalid existing marker', async t => {
  const { roots, markerPath } = await fixture(t)
  await writeFile(markerPath, JSON.stringify({ version: 1, categories: ['../browser-cache'] }))
  const service = createStorageManagementService({
    scanner: scannerFor(), roots,
    summaryCache: { clear: async () => ({ removed: 0, bytes: 0 }) },
    summaryWorkspaces: { clearDerived: async () => ({ removed: 0, bytes: 0 }) },
    logger: { truncate: async () => {} }
  })
  await assert.rejects(
    service.clear({ categoryId: 'browser-cache' }),
    error => error?.code === 'STORAGE_CLEANUP_MARKER_INVALID'
  )
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), {
    version: 1, categories: ['../browser-cache']
  })
})

test('immediate cleanup delegates to owners, protects active workspaces, and reports actual remaining bytes', async t => {
  const { roots } = await fixture(t)
  const protectedChecks = []
  let cacheBytes = 8
  let workspaceBytes = 13
  let logBytes = 5
  const service = createStorageManagementService({
    scanner: scannerFor(), roots,
    summaryCache: { async clear() { cacheBytes = 0; return { removed: 2, bytes: 999 } } },
    summaryWorkspaces: {
      async clearDerived({ isProtected }) {
        protectedChecks.push(await isProtected('active'), await isProtected('inactive'))
        workspaceBytes = 3
        return { removed: 2, bytes: 10 }
      }
    },
    isWorkspaceProtected: id => id === 'active',
    logger: { async truncate() { logBytes = 0 } },
    scanner: async descriptors => descriptors.map(({ id }) => ({
      id,
      bytes: id === 'summary-cache' ? cacheBytes : id === 'summary-workspaces' ? workspaceBytes : id === 'logs' ? logBytes : 0,
      itemCount: 0,
      status: 'ready'
    }))
  })
  assert.deepEqual(await service.clear({ categoryId: 'summary-cache' }), {
    categoryId: 'summary-cache', pendingRestart: false, removed: 2, bytes: 8,
    remainingBytes: 0, partial: false
  })
  assert.deepEqual(await service.clear({ categoryId: 'summary-workspaces' }), {
    categoryId: 'summary-workspaces', pendingRestart: false, removed: 2, bytes: 10,
    remainingBytes: 3, partial: true
  })
  assert.deepEqual(protectedChecks, [true, false])
  assert.equal((await service.clear({ categoryId: 'logs' })).remainingBytes, 0)
})

test('a locked immediate entry reports partial cleanup with its actual remaining bytes', async t => {
  const { roots } = await fixture(t)
  const service = createStorageManagementService({
    roots,
    scanner: async descriptors => descriptors.map(({ id }) => ({
      id, bytes: id === 'summary-cache' ? 7 : 0, itemCount: 1, status: 'ready'
    })),
    summaryCache: { async clear() { throw Object.assign(new Error('locked path'), { code: 'EPERM' }) } },
    summaryWorkspaces: { clearDerived: async () => ({ removed: 0, bytes: 0 }) },
    logger: { truncate: async () => {} }
  })
  assert.deepEqual(await service.clear({ categoryId: 'summary-cache' }), {
    categoryId: 'summary-cache', pendingRestart: false, removed: 0, bytes: 0,
    remainingBytes: 7, partial: true
  })
})

test('log cleanup uses only the injected UCLI logger target', async t => {
  const { roots } = await fixture(t)
  const sibling = join(roots.userData, 'keep.log')
  await writeFile(sibling, 'keep')
  let truncated = 0
  const service = createStorageManagementService({
    scanner: scannerFor(), roots,
    summaryCache: { clear: async () => ({ removed: 0, bytes: 0 }) },
    summaryWorkspaces: { clearDerived: async () => ({ removed: 0, bytes: 0 }) },
    logger: { async truncate() { truncated += 1 } }
  })
  await service.clear({ categoryId: 'logs' })
  assert.equal(truncated, 1)
  assert.equal(await readFile(sibling, 'utf8'), 'keep')
})
