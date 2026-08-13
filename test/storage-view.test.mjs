import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { createPinia, setActivePinia } from 'pinia'

const requests = []

globalThis.window = {
  ucli: {
    getStorageUsage() {
      return new Promise((resolve, reject) => requests.push({ type: 'load', resolve, reject }))
    },
    clearStorageCategory(categoryId) {
      return new Promise((resolve, reject) => requests.push({ type: 'clear', categoryId, resolve, reject }))
    }
  }
}

const { STORAGE_CATEGORY_PRESENTATION } = await import('../src/storageCategories.js')
const { useStorageStore } = await import(`../src/stores/storage.js?storage-store=${Date.now()}`)

function snapshot(revision, bytes) {
  return {
    revision,
    scannedAt: 1786554000000 + revision,
    totalBytes: bytes,
    reclaimableBytes: bytes,
    pendingRestart: [],
    categories: [{
      id: 'summary-cache', bytes, itemCount: 1, reclaimableBytes: bytes,
      status: 'ready', clearMode: 'immediate'
    }]
  }
}

function createStore() {
  requests.length = 0
  setActivePinia(createPinia())
  return useStorageStore()
}

test('storage presentation owns labels for every fixed category', () => {
  assert.deepEqual(Object.keys(STORAGE_CATEGORY_PRESENTATION), [
    'core-data', 'installed-skills', 'other-user-data',
    'summary-cache', 'summary-workspaces', 'browser-cache',
    'skill-staging', 'update-downloads', 'logs'
  ])
  for (const item of Object.values(STORAGE_CATEGORY_PRESENTATION)) {
    assert.equal(typeof item.label, 'string')
    assert.ok(item.label.length > 0)
    assert.equal(typeof item.description, 'string')
    assert.ok(item.description.length > 0)
  }
})

test('storage store ignores a stale load after a newer load completes', async () => {
  const store = createStore()
  const first = store.load()
  const second = store.load()

  requests[1].resolve(snapshot(2, 200))
  await second
  requests[0].resolve(snapshot(1, 100))
  await first

  assert.equal(store.snapshot.revision, 2)
  assert.equal(store.snapshot.totalBytes, 200)
  assert.equal(store.loading, false)
  assert.equal(store.error, null)
})

test('storage clear invalidates an earlier load and refreshes before completing', async () => {
  const store = createStore()
  const staleLoad = store.load()
  const clearing = store.clearCategory('summary-cache')
  assert.equal(store.clearingId, 'summary-cache')
  assert.deepEqual(requests.map(item => item.type), ['load', 'clear'])

  requests[1].resolve({
    categoryId: 'summary-cache', pendingRestart: false,
    removed: 1, bytes: 100, remainingBytes: 0, partial: false
  })
  await Promise.resolve()
  assert.deepEqual(requests.map(item => item.type), ['load', 'clear', 'load'])
  requests[2].resolve(snapshot(3, 0))
  await clearing

  requests[0].resolve(snapshot(1, 100))
  await staleLoad
  assert.equal(store.snapshot.revision, 3)
  assert.equal(store.snapshot.totalBytes, 0)
  assert.equal(store.clearingId, null)
})

test('a new load invalidates an older clear refresh sequence', async () => {
  const store = createStore()
  const clearing = store.clearCategory('logs')
  requests[0].resolve({
    categoryId: 'logs', pendingRestart: false,
    removed: 1, bytes: 50, remainingBytes: 0, partial: false
  })
  await Promise.resolve()
  assert.equal(requests[1].type, 'load')

  const latest = store.load()
  requests[2].resolve(snapshot(5, 25))
  await latest
  requests[1].resolve(snapshot(4, 0))
  await clearing

  assert.equal(store.snapshot.revision, 5)
  assert.equal(store.snapshot.totalBytes, 25)
})

test('storage management panel compiles and exposes safe policy-specific actions', () => {
  const source = readFileSync(
    new URL('../src/components/settings/StorageManagementPanel.vue', import.meta.url), 'utf8'
  )
  assert.deepEqual(parseSfc(source, { filename: 'StorageManagementPanel.vue' }).errors, [])
  assert.match(source, /useStorageStore/)
  assert.match(source, /Modal\.confirm/)
  assert.match(source, /clearMode === 'none'/)
  assert.match(source, /clearMode === 'restart'/)
  assert.match(source, /下次启动清理/)
  assert.match(source, /稍后重启 UCLI/)
  assert.match(source, /status === 'partial'/)
  assert.match(source, /status === 'unavailable'/)
  assert.match(source, /store\.clearCategory/)
  assert.match(source, /await store\.load\(\)/)
})

test('settings storage section mounts one inventory and keeps cache policy controls separate', () => {
  const view = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  const policy = readFileSync(
    new URL('../src/components/settings/SummaryCacheSettings.vue', import.meta.url), 'utf8'
  )
  assert.equal((view.match(/<StorageManagementPanel\b/g) || []).length, 1)
  assert.equal((view.match(/<SummaryCacheSettings\b/g) || []).length, 1)
  assert.doesNotMatch(policy, /getSummaryCacheStats|clearSummaryCache|Modal\.confirm|formatBytes/)
  assert.match(policy, /cacheEnabled/)
  assert.match(policy, /cacheMaxBytes/)
  assert.match(policy, /failedWorkspaceRetentionDays/)
  assert.match(policy, /mapConcurrency/)
})
