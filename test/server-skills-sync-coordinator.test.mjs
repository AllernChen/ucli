import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrganizationSkillsSyncCoordinator } from '../electron/serverConnection/skillsSyncCoordinator.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function connectionState({
  status = 'connected', connectionId = 'connection-1', connectionRevision = 1,
  serverOrigin = 'https://server.example.test', organizationId = 'org-1'
} = {}) {
  return {
    status,
    serverOrigin: connectionId ? serverOrigin : null,
    organization: connectionId ? { id: organizationId, name: 'Example organization' } : null,
    connection: connectionId ? { id: connectionId, connectionRevision } : null
  }
}

test('uses a five-minute catalog TTL unless a caller forces a refresh', async () => {
  let now = 1_000
  let state = connectionState()
  let syncCalls = 0
  const coordinator = createOrganizationSkillsSyncCoordinator({
    connectionManager: { getState: () => state },
    catalog: { sync: async () => { syncCalls += 1 } },
    now: () => now,
    ttlMs: 5 * 60_000,
    onChanged: () => {}
  })

  await coordinator.ensureFresh()
  now += 4 * 60_000
  await coordinator.ensureFresh()
  assert.equal(syncCalls, 1)

  now += 61_000
  await coordinator.ensureFresh()
  assert.equal(syncCalls, 2)

  await coordinator.ensureFresh({ force: true })
  assert.equal(syncCalls, 3)
})

test('coalesces matching refreshes and emits only safe catalog change metadata', async () => {
  const pending = deferred()
  let syncCalls = 0
  const events = []
  const coordinator = createOrganizationSkillsSyncCoordinator({
    connectionManager: { getState: () => connectionState() },
    catalog: { sync: async () => { syncCalls += 1; await pending.promise } },
    now: () => 12_345,
    onChanged: event => events.push(event)
  })

  const first = coordinator.ensureFresh()
  const second = coordinator.ensureFresh({ force: true })
  assert.equal(syncCalls, 1)
  pending.resolve()
  await Promise.all([first, second])

  assert.deepEqual(events, [{
    connectionId: 'connection-1', connectionRevision: 1, catalogRevision: 1,
    lastSyncedAt: 12_345, status: 'ready'
  }])
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'catalogRevision', 'connectionId', 'connectionRevision', 'lastSyncedAt', 'status'
  ])
})

test('rejects an old revision completion after synchronizing the replacement connection', async () => {
  const oldSync = deferred()
  const newSync = deferred()
  const events = []
  let state = connectionState()
  let calls = 0
  const coordinator = createOrganizationSkillsSyncCoordinator({
    connectionManager: { getState: () => state },
    catalog: { sync: async () => { calls += 1; return calls === 1 ? oldSync.promise : newSync.promise } },
    now: () => 10,
    onChanged: event => events.push(event)
  })

  const oldRefresh = coordinator.ensureFresh()
  state = connectionState({ connectionRevision: 2 })
  coordinator.handleConnectionState(state)
  await new Promise(resolve => setImmediate(resolve))
  newSync.resolve()
  await new Promise(resolve => setImmediate(resolve))
  oldSync.resolve()
  await oldRefresh

  assert.equal(calls, 2)
  assert.deepEqual(events, [{
    connectionId: 'connection-1', connectionRevision: 2, catalogRevision: 1,
    lastSyncedAt: 10, status: 'ready'
  }])
})

test('keeps the last successful catalog state while temporarily unreachable but resets on explicit disconnect', async () => {
  let state = connectionState()
  let syncCalls = 0
  const coordinator = createOrganizationSkillsSyncCoordinator({
    connectionManager: { getState: () => state },
    catalog: { sync: async () => { syncCalls += 1 } },
    now: () => 25,
    onChanged: () => {}
  })

  await coordinator.ensureFresh()
  state = connectionState({ status: 'unreachable' })
  coordinator.handleConnectionState(state)
  await coordinator.ensureFresh()
  assert.deepEqual(coordinator.getState(), {
    status: 'stale', lastSyncedAt: 25, catalogRevision: 1, error: null
  })
  assert.equal(syncCalls, 1)

  state = connectionState({ status: 'disconnected', connectionId: null })
  coordinator.handleConnectionState(state)
  assert.deepEqual(coordinator.getState(), {
    status: 'idle', lastSyncedAt: null, catalogRevision: 0, error: null
  })
})

test('suppresses a deferred completion after shutdown and delegates cancellation to the catalog authority', async () => {
  const pending = deferred()
  let shutdownCalls = 0
  const events = []
  const coordinator = createOrganizationSkillsSyncCoordinator({
    connectionManager: { getState: () => connectionState() },
    catalog: {
      sync: async () => pending.promise,
      shutdown: async () => { shutdownCalls += 1 }
    },
    onChanged: event => events.push(event)
  })

  const refresh = coordinator.ensureFresh()
  const shutdown = coordinator.shutdown()
  pending.resolve()
  await Promise.all([refresh, shutdown])

  assert.equal(shutdownCalls, 1)
  assert.deepEqual(events, [])
  assert.equal(coordinator.getState().status, 'idle')
})
