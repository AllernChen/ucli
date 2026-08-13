import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

let listener = null
let getResolve = null
const calls = []

globalThis.window = {
  ucli: {
    onUpdateState(handler) {
      calls.push('subscribe')
      listener = handler
      return () => { calls.push('unsubscribe'); listener = null }
    },
    getUpdateState() {
      calls.push('get')
      return new Promise(resolve => { getResolve = resolve })
    },
    async checkForUpdates() { calls.push('check'); return { revision: 6, status: 'not-available' } },
    async downloadUpdate() { calls.push('download'); return { revision: 7, status: 'downloading' } },
    async installUpdate() { calls.push('install'); return true }
  }
}

const { useUpdatesStore } = await import(`../src/stores/updates.js?updates-store=${Date.now()}`)

function createStore() {
  calls.length = 0
  listener = null
  getResolve = null
  setActivePinia(createPinia())
  return useUpdatesStore()
}

test('update store ignores snapshots older than its current revision', () => {
  const store = createStore()
  store.applySnapshot({ revision: 4, status: 'available', availableVersion: '0.10.2' })
  store.applySnapshot({ revision: 3, status: 'idle', availableVersion: null })

  assert.equal(store.revision, 4)
  assert.equal(store.status, 'available')
  assert.equal(store.availableVersion, '0.10.2')
})

test('initialize subscribes before get and rejects a stale initial response', async () => {
  const store = createStore()
  const initializing = store.initialize()
  assert.deepEqual(calls, ['subscribe', 'get'])

  listener({ revision: 5, status: 'available', availableVersion: '0.10.2' })
  getResolve({ revision: 4, status: 'idle', availableVersion: null })
  await initializing

  assert.equal(store.revision, 5)
  assert.equal(store.status, 'available')
})

test('actions apply returned snapshots without letting stale action responses win', async () => {
  const store = createStore()
  store.applySnapshot({ revision: 8, status: 'downloaded' })

  await store.check()
  await store.download()
  assert.equal(store.revision, 8)
  assert.equal(store.status, 'downloaded')
  assert.equal(await store.install(), true)
  assert.deepEqual(calls, ['check', 'download', 'install'])
})

test('dispose removes the shared update subscription', async () => {
  const store = createStore()
  const initializing = store.initialize()
  getResolve({ revision: 1, status: 'idle' })
  await initializing
  store.dispose()

  assert.deepEqual(calls, ['subscribe', 'get', 'unsubscribe'])
  assert.equal(listener, null)
})
