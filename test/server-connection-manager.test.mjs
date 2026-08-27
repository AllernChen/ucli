import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectionManager } from '../electron/serverConnection/connectionManager.js'

const nowValue = Date.parse('2026-08-27T00:00:00.000Z')
const current = {
  id: 'connection-1', serverOrigin: 'https://server.example.test', refreshTokenCiphertext: 'ciphertext',
  accountId: 'account-1', accountDisplayName: 'Ada', organizationId: 'org-1', organizationName: 'Example',
  authorizationExpiresAt: null, serverTime: '2026-08-27T00:00:00.000Z', receivedLocalTime: nowValue,
  serverOffsetMs: 0, lastSyncedAt: nowValue, connectionRevision: 3, reminderState: {}
}

function createManager({ client = {}, credentials = {}, now = () => nowValue, timers, jitter } = {}) {
  const stored = { ...current }
  const store = {
    readCurrent: () => stored,
    decryptRefreshToken: () => 'old-refresh-token',
    replaceRefreshToken: async ({ refreshToken, authorization }) => Object.assign(stored, {
      refreshTokenCiphertext: `cipher:${refreshToken}`,
      authorizationExpiresAt: authorization.expiresAt,
      serverTime: authorization.serverTime,
      receivedLocalTime: now(),
      serverOffsetMs: Date.parse(authorization.serverTime) - now(),
      lastSyncedAt: now()
    }),
    retryPendingRefreshPersistence: async () => stored,
    disconnect: async () => {},
    ...credentials
  }
  const manager = new ConnectionManager({
    attempts: { create() {}, getPublic() {}, getSecret() {}, beginRedeem() {}, markRedeemAmbiguous() {}, finish() {}, cancel() {} },
    credentials: store,
    client: {
      refresh: async () => ({ accessToken: 'access-1', refreshToken: 'new-refresh-token', expiresIn: 900, authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } }),
      bootstrap: async () => ({ organization: { id: 'org-1', name: 'Example', timezone: 'UTC' }, gateway: { baseUrl: 'https://server.example.test/gateway' }, models: [], skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog', authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } }),
      ...client
    },
    platform: 'windows', deviceName: 'Workstation', now, timers, jitter
  })
  return { manager, store, stored }
}

function deferred() {
  let resolve
  const promise = new Promise(nextResolve => { resolve = nextResolve })
  return { promise, resolve }
}

test('startup refreshes then bootstraps and concurrent access-token calls share the refresh flight', async () => {
  const calls = []
  let releaseRefresh
  const refresh = new Promise(resolve => { releaseRefresh = resolve })
  const { manager } = createManager({
    client: {
      refresh: async args => { calls.push(['refresh', args.refreshToken]); return refresh },
      bootstrap: async args => { calls.push(['bootstrap', args.accessToken]); return { organization: { id: 'org-1', name: 'Example', timezone: 'UTC' }, gateway: { baseUrl: 'https://server.example.test/gateway' }, models: [], skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog', authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } } }
    }
  })

  const first = manager.start()
  const second = manager.getAccessToken()
  releaseRefresh({ accessToken: 'access-2', refreshToken: 'new-refresh-token', expiresIn: 900, authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } })
  assert.equal((await first).status, 'connected')
  assert.equal(await second, 'access-2')
  assert.deepEqual(calls, [['refresh', 'old-refresh-token'], ['bootstrap', 'access-2']])
  assert.equal(JSON.stringify(manager.getState()).includes('access-2'), false)
})

test('retryable recovery schedules the first injected, jittered backoff interval', async () => {
  const delays = []
  const { manager } = createManager({
    client: { refresh: async () => { throw Object.assign(new Error('offline'), { retryable: true }) } },
    timers: { setTimeout: (_callback, delay) => { delays.push(delay); return { unref() {} } }, clearTimeout: () => {} },
    jitter: delay => delay + 17
  })

  await assert.rejects(manager.getAccessToken(), error => error.retryable === true)
  assert.deepEqual(delays, [30_017])
  await manager.shutdown()
})

test('a rotated-token persistence failure blocks lifecycle work until only the pending flush succeeds', async () => {
  let writes = 0
  let flushRetries = 0
  const { manager } = createManager({
    credentials: {
      replaceRefreshToken: async () => { writes += 1; throw Object.assign(new Error('disk unavailable'), { code: 'PERSISTENCE_PENDING' }) },
      retryPendingRefreshPersistence: async () => { flushRetries += 1; return current }
    }
  })

  await assert.rejects(manager.getAccessToken(), { code: 'PERSISTENCE_PENDING' })
  const state = manager.getState()
  assert.equal(state.revision, 2)
  assert.equal(state.status, 'unreachable')
  assert.equal(state.reason, 'PERSISTENCE_PENDING')
  assert.equal(state.serverOrigin, current.serverOrigin)
  assert.deepEqual(state.account, { id: 'account-1', displayName: 'Ada' })
  assert.deepEqual(state.organization, { id: 'org-1', name: 'Example' })
  assert.equal(state.authorizationExpiresAt, null)
  assert.equal(state.lastSyncedAt, nowValue)
  assert.equal(state.retryable, true)
  await assert.rejects(manager.getBootstrap(), { code: 'PERSISTENCE_PENDING' })
  await manager.retry()
  assert.equal(writes, 1)
  assert.equal(flushRetries, 1)
})

test('terminal lifecycle errors clear credentials while disabled metadata is retained and mapped', async () => {
  let disconnects = 0
  const deleted = createManager({
    client: { refresh: async () => { throw Object.assign(new Error(), { code: 'grant_deleted' }) } },
    credentials: { disconnect: async () => { disconnects += 1 } }
  })
  await assert.rejects(deleted.manager.getAccessToken(), { code: 'grant_deleted' })
  assert.equal(disconnects, 1)
  assert.equal(deleted.manager.getState().status, 'disconnected')

  const disabled = createManager({ client: { refresh: async () => { throw Object.assign(new Error(), { code: 'grant_disabled' }) } } })
  await assert.rejects(disabled.manager.getAccessToken(), { code: 'grant_disabled' })
  assert.equal(disabled.manager.getState().status, 'disabled')
  assert.equal(disabled.manager.getState().serverOrigin, current.serverOrigin)
})

test('a stale refresh completion after disconnect cannot alter the disconnected state', async () => {
  const refresh = deferred()
  const { manager } = createManager({ client: { refresh: async () => refresh.promise } })

  const access = manager.getAccessToken()
  await manager.disconnect()
  refresh.resolve({ accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresIn: 900, authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } })
  await assert.rejects(access)
  assert.equal(manager.getState().status, 'disconnected')
  assert.equal(manager.getState().connection, null)
})

test('a replacement connection starts its own bootstrap while an old bootstrap is in flight', async () => {
  const oldBootstrap = deferred()
  const calls = []
  const { manager } = createManager({
    client: { bootstrap: async ({ serverOrigin }) => {
      calls.push(serverOrigin)
      if (serverOrigin === current.serverOrigin) return oldBootstrap.promise
      return { organization: { id: 'org-2', name: 'Replacement', timezone: 'UTC' }, gateway: { baseUrl: 'https://replacement.example.test/gateway' }, models: [], skillsCatalogUrl: 'https://replacement.example.test/api/v1/skills/catalog', authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } }
    } }
  })
  const original = manager.bootstrapWithAccessToken({ connection: manager.current, connectionEpoch: manager.connectionEpoch, accessToken: 'old-access' })
  const replacement = { ...current, id: 'connection-2', serverOrigin: 'https://replacement.example.test', connectionRevision: 4 }
  manager.current = replacement
  manager.connectionEpoch += 1
  const next = manager.bootstrapWithAccessToken({ connection: replacement, connectionEpoch: manager.connectionEpoch, accessToken: 'new-access' })
  oldBootstrap.resolve({ organization: { id: 'org-1', name: 'Example', timezone: 'UTC' }, gateway: { baseUrl: 'https://server.example.test/gateway' }, models: [], skillsCatalogUrl: 'https://server.example.test/api/v1/skills/catalog', authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } })
  await Promise.all([original, next])
  assert.deepEqual(calls, ['https://server.example.test', 'https://replacement.example.test'])
  assert.equal((await manager.getBootstrap()).gateway.baseUrl, 'https://replacement.example.test/gateway')
})

test('shutdown fences a pending refresh and scrubs runtime token, cache, and timers', async () => {
  const refresh = deferred()
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }
  const { manager } = createManager({ client: { refresh: async () => refresh.promise }, timers })
  const pending = manager.getAccessToken()
  const shutdown = manager.shutdown()
  refresh.resolve({ accessToken: 'late-access', refreshToken: 'late-refresh', expiresIn: 900, authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } })
  await shutdown
  await assert.rejects(pending)
  await assert.rejects(manager.getAccessToken(), { code: 'SERVER_CONNECTION_SHUTDOWN' })
  assert.equal(manager.accessToken, null)
  assert.equal(manager.bootstrapCache, null)
  assert.equal(manager.accessRefreshTimer, null)
})

test('metadata persistence failure gates lifecycle work and schedules a retry', async () => {
  const delays = []
  const { manager } = createManager({
    credentials: { updateConnectionMetadata: async () => { throw Object.assign(new Error('disk'), { code: 'PERSISTENCE_PENDING' }) } },
    timers: { setTimeout: (_callback, delay) => { delays.push(delay); return { unref() {} } }, clearTimeout: () => {} }
  })
  await assert.rejects(manager.getAccessToken(), { code: 'PERSISTENCE_PENDING' })
  assert.equal(manager.getState().reason, 'PERSISTENCE_PENDING')
  await assert.rejects(manager.getBootstrap(), { code: 'PERSISTENCE_PENDING' })
  assert.equal(delays.at(-1), 30_000)
})
