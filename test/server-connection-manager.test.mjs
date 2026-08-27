import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectionManager } from '../electron/serverConnection/connectionManager.js'
import { createLocalGatewayProxy } from '../electron/serverConnection/localGatewayProxy.js'

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

function scheduler(start = nowValue) {
  let now = start
  let next = 0
  const timers = new Map()
  return {
    now: () => now,
    timers: {
      setTimeout(callback, delay) {
        const handle = { id: ++next, unref() {} }
        timers.set(handle, { callback, at: now + delay })
        return handle
      },
      clearTimeout(handle) { timers.delete(handle) }
    },
    async advance(ms) {
      now += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        await due[1].callback()
      }
    },
    get size() { return timers.size }
  }
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

test('disconnect invalidates runtime identity and bearer authority before credential deletion settles', async () => {
  const deletion = deferred()
  const revoked = []
  const { manager } = createManager({ credentials: { disconnect: async () => deletion.promise } })
  manager.installAccessToken('live-access', 900)
  manager.bootstrapCache = { value: { gateway: { baseUrl: 'https://server.example.test/gateway' } } }
  manager.revokeRuntimeRevision = identity => revoked.push(identity)
  let upstreamCalls = 0
  const proxy = createLocalGatewayProxy({
    connectionManager: manager,
    fetchImpl: async () => {
      upstreamCalls += 1
      return new Response('must not be reached')
    }
  })
  await proxy.start()
  const session = proxy.createSession({ sessionId: 'session-1', connectionId: 'connection-1', connectionRevision: 3 })

  const disconnecting = manager.disconnect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.getRuntimeConnectionIdentity(), null)
  assert.equal(manager.accessToken, null)
  assert.equal(manager.bootstrapCache, null)
  assert.deepEqual(revoked, [{ connectionId: 'connection-1', connectionRevision: 3 }])
  assert.equal((await fetch(`${session.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${session.bearer}` } })).status, 401)
  assert.equal(upstreamCalls, 0)
  deletion.resolve()
  await disconnecting
  await proxy.shutdown()
})

test('a failed disconnect flush remains detached and retries deletion without restoring runtime authority', async () => {
  let pending = false
  let disconnects = 0
  let flushes = 0
  const { manager } = createManager({
    credentials: {
      isPersistencePending: () => pending,
      disconnect: async () => {
        disconnects += 1
        if (disconnects === 1) {
          pending = true
          throw Object.assign(new Error('disk unavailable'), { code: 'PERSISTENCE_PENDING' })
        }
      },
      retryPendingPersistence: async () => {
        flushes += 1
        pending = false
      }
    }
  })

  await assert.rejects(manager.disconnect(), { code: 'PERSISTENCE_PENDING' })
  assert.equal(manager.getRuntimeConnectionIdentity(), null)
  assert.equal(manager.getState().status, 'disconnected')
  await manager.retry()
  assert.equal(flushes, 1)
  assert.equal(disconnects, 2)
  assert.equal(manager.getRuntimeConnectionIdentity(), null)
  assert.equal(manager.getState().status, 'disconnected')
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

test('proactively refreshes once when an in-memory token crosses below sixty seconds', async () => {
  const clock = scheduler()
  let refreshes = 0
  const { manager } = createManager({ now: clock.now, timers: clock.timers, client: { refresh: async () => {
    refreshes += 1
    return { accessToken: 'renewed', refreshToken: 'renewed-refresh', expiresIn: 900, authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' } }
  } } })
  manager.installAccessToken('short-lived', 120)
  await clock.advance(60_001)
  assert.equal(refreshes, 1)
  await clock.advance(1)
  assert.equal(refreshes, 1)
  await manager.shutdown()
})

test('manager expiry timer notifies 7, 3, 1, and 0 day thresholds and clears on permanent, disconnect, and shutdown', async () => {
  const clock = scheduler(0)
  const notices = []
  const { manager } = createManager({ now: clock.now, timers: clock.timers })
  manager.reminder = { evaluate: ({ authorizationExpiresAt, reminderState = {} }) => {
    if (!authorizationExpiresAt) return {}
    const thresholds = [7, 3, 1, 0]
    const crossed = new Set(reminderState.crossedThresholds || [])
    const remaining = Date.parse(authorizationExpiresAt) - clock.now()
    const due = thresholds.filter(days => remaining <= days * 86_400_000 && !crossed.has(days))
    if (due.length) notices.push(Math.min(...due))
    due.forEach(day => crossed.add(day))
    return { authorizationExpiresAt, crossedThresholds: thresholds.filter(day => crossed.has(day)) }
  } }
  const authorization = { expiresAt: new Date(8 * 86_400_000).toISOString(), serverTime: new Date(0).toISOString() }
  await manager.updateAuthorizationState(authorization)
  await clock.advance(86_400_001)
  for (let day = 0; day < 9; day += 1) await clock.advance(86_400_001)
  assert.deepEqual(notices, [7, 3, 1, 0])
  assert.equal(manager.current.serverTime, authorization.serverTime)
  assert.equal(manager.current.receivedLocalTime, 0)
  assert.equal(manager.current.serverOffsetMs, 0)
  assert.equal(manager.current.lastSyncedAt, 0)
  await manager.updateAuthorizationState({ ...authorization, expiresAt: null })
  assert.equal(manager.expiryTimer, null)
  await manager.disconnect()
  assert.equal(manager.expiryTimer, null)
  await manager.shutdown()
  assert.equal(clock.size, 0)
})

test('expired pending rotation refreshes only with the rotated token before bootstrap', async () => {
  const clock = scheduler()
  const tokens = []
  let token = 'old-refresh-token'
  let first = true
  const { manager, stored } = createManager({
    now: clock.now, timers: clock.timers,
    credentials: {
      decryptRefreshToken: () => token,
      replaceRefreshToken: async ({ refreshToken }) => { token = refreshToken; Object.assign(stored, { refreshTokenCiphertext: `cipher:${refreshToken}` }); if (first) { first = false; throw Object.assign(new Error('disk'), { code: 'PERSISTENCE_PENDING' }) } return stored },
      retryPendingPersistence: async () => stored
    },
    client: { refresh: async ({ refreshToken }) => {
      tokens.push(refreshToken)
      return tokens.length === 1
        ? { accessToken: 'first-access', refreshToken: 'rotated-refresh', expiresIn: 30, authorization: { expiresAt: null, serverTime: new Date(clock.now()).toISOString() } }
        : { accessToken: 'second-access', refreshToken: 'second-refresh', expiresIn: 900, authorization: { expiresAt: null, serverTime: new Date(clock.now()).toISOString() } }
    } }
  })
  await assert.rejects(manager.getAccessToken(), { code: 'PERSISTENCE_PENDING' })
  manager.clearOwnedTimers()
  await clock.advance(31_000)
  await manager.retry()
  assert.deepEqual(tokens, ['old-refresh-token', 'rotated-refresh'])
  await manager.shutdown()
})
