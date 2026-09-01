import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
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
