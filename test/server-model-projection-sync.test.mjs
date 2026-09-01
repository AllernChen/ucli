import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { createLocalGatewayProxy } from '../electron/serverConnection/localGatewayProxy.js'
import { createServerModelProjection } from '../electron/serverConnection/modelProjection.js'
import { createServerModelProjectionSynchronizer } from '../electron/serverConnection/projectionSynchronizer.js'
import { buildServiceProfileCatalog } from '../electron/serverConnection/serviceProfileCatalog.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function connectedState({ origin, organizationId, organizationName, connectionId, connectionRevision }) {
  return {
    revision: connectionRevision,
    status: 'connected',
    reason: null,
    serverOrigin: origin,
    organization: { id: organizationId, name: organizationName },
    connection: {
      id: connectionId,
      serverOrigin: origin,
      organization: { id: organizationId, name: organizationName },
      connectionRevision
    }
  }
}

function bootstrap(organization, model) {
  return {
    organization,
    models: [{ id: model, displayName: model, contextSize: 4096, protocols: ['openai_responses'] }]
  }
}

async function runReplacementRace({ rejectA }) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-projection-generation-'))
  const db = await openDb(join(root, 'ucli.db'))
  const deferredA = deferred()
  const deferredB = deferred()
  const a = connectedState({
    origin: 'https://a.example.test', organizationId: 'org-a', organizationName: 'Organization A',
    connectionId: 'connection-a', connectionRevision: 1
  })
  const b = connectedState({
    origin: 'https://b.example.test', organizationId: 'org-b', organizationName: 'Organization B',
    connectionId: 'connection-b', connectionRevision: 2
  })
  let current = a
  let bootstrapCalls = 0
  const manager = {
    getState: () => current,
    getRuntimeConnectionIdentity: () => ({
      connectionId: current.connection.id,
      connectionRevision: current.connection.connectionRevision
    }),
    getBootstrap: () => (++bootstrapCalls === 1 ? deferredA.promise : deferredB.promise)
  }
  const projection = createServerModelProjection({
    db,
    getRuntimeConnectionIdentity: manager.getRuntimeConnectionIdentity,
    flush: () => true
  })
  const clearEvents = []
  const clearOnlineState = projection.clearOnlineState.bind(projection)
  projection.clearOnlineState = async (...args) => {
    clearEvents.push({ origin: current.serverOrigin, organizationId: current.organization.id, args })
    return clearOnlineState(...args)
  }
  const runtimeEvents = []
  const synchronizer = createServerModelProjectionSynchronizer({
    manager,
    projection,
    db,
    buildCatalog: buildServiceProfileCatalog,
    refreshSessionRuntimes: () => runtimeEvents.push({
      origin: current.serverOrigin,
      organizationId: current.organization.id,
      profiles: projection.listProfiles()
    })
  })

  try {
    const syncA = synchronizer.sync()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bootstrapCalls, 1)
    current = b
    const syncB = synchronizer.sync()
    if (rejectA) deferredA.reject(Object.assign(new Error('stale A bootstrap failure'), { code: 'NETWORK_UNREACHABLE' }))
    else deferredA.resolve(bootstrap({ id: 'org-a', name: 'Organization A' }, 'model-a'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bootstrapCalls, 2)
    deferredB.resolve(bootstrap({ id: 'org-b', name: 'Organization B' }, 'model-b'))
    await Promise.all([syncA, syncB])

    const profiles = projection.listProfiles()
    assert.deepEqual(profiles.map(({ id, organization, canStart }) => ({ id, organizationId: organization.id, canStart })), [{
      id: 'https://b.example.test::org-b', organizationId: 'org-b', canStart: true
    }])
    assert.equal(db.listServerServiceProfiles().some(profile => profile.serverOrigin === 'https://a.example.test' && profile.organizationId === 'org-b'), false)
    assert.deepEqual(clearEvents, [])
    assert.deepEqual(runtimeEvents.map(({ origin, organizationId }) => ({ origin, organizationId })), [
      { origin: 'https://b.example.test', organizationId: 'org-b' }
    ])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('a stale successful projection cannot persist, clear, or publish over a replacement generation', async () => {
  await runReplacementRace({ rejectA: false })
})

test('a stale failed projection cannot clear or publish over a replacement generation', async () => {
  await runReplacementRace({ rejectA: true })
})

for (const transientStatus of ['connecting', 'unreachable']) {
  test(`${transientStatus} preserves a running service session authority for recovery`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ucli-projection-transient-'))
    const db = await openDb(join(root, 'ucli.db'))
    const connected = connectedState({
      origin: 'https://server.example.test', organizationId: 'org-1', organizationName: 'Organization',
      connectionId: 'connection-1', connectionRevision: 1
    })
    let current = connected
    const catalog = {
      organization: { id: 'org-1', name: 'Organization' },
      gateway: { baseUrl: 'https://server.example.test/gateway' },
      models: [{
        id: 'claude-model', displayName: 'Claude model', contextSize: 4096,
        protocols: ['anthropic_messages']
      }]
    }
    const manager = {
      getState: () => current,
      getRuntimeConnectionIdentity: () => ['connected', 'expiring'].includes(current.status)
        ? { connectionId: current.connection.id, connectionRevision: current.connection.connectionRevision }
        : null,
      getBootstrap: async () => catalog,
      getAccessToken: async () => 'server-access-token'
    }
    const proxy = createLocalGatewayProxy({
      connectionManager: manager,
      fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    await proxy.start()
    const projection = createServerModelProjection({
      db,
      proxy: {
        createSession: connection => proxy.createSession(connection),
        revokeSession: sessionId => proxy.revokeSession(sessionId)
      },
      getRuntimeConnectionIdentity: manager.getRuntimeConnectionIdentity,
      flush: () => true
    })
    const synchronizer = createServerModelProjectionSynchronizer({
      manager,
      projection,
      db,
      buildCatalog: buildServiceProfileCatalog
    })

    try {
      await synchronizer.sync()
      const [profile] = projection.listProfiles()
      const issued = projection.prepareRuntime({
        serviceProfileId: profile.id,
        modelId: 'claude-model',
        adapterId: 'claude',
        sessionId: 'claude-session'
      })

      current = { ...connected, status: transientStatus }
      await synchronizer.sync()
      assert.equal(projection.listProfiles()[0].canStart, false)

      current = connected
      await synchronizer.sync()
      const recovered = await fetch(`${issued.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json' },
        body: '{}'
      })
      assert.equal(recovered.status, 200)
    } finally {
      await proxy.shutdown()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
