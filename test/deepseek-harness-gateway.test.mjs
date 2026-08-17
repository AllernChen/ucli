import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGatewaySessionOperations,
  describeGatewaySessionEligibility
} from '../electron/gateway/orchestratorPort.js'
import { GatewayManager } from '../electron/gateway/manager.js'
import { GatewayRuntime } from '../electron/gateway/runtime.js'
import {
  createPort,
  FakeGatewayChannel,
  FEISHU_CONFIG,
  MemoryRouteStore,
  session
} from './helpers/gatewayRuntimeHarness.mjs'

const legacyCapabilities = Object.freeze({
  surface: 'terminal',
  permissionOwner: 'ucli',
  historyOwner: 'ucli',
  statsOwner: 'ucli',
  gateway: true,
  bridge: true
})

function dshSession(id, surfacePreference, overrides = {}) {
  return {
    id,
    adapterId: 'deepseek-harness',
    status: 'idle',
    adapterConfig: { surfacePreference },
    capabilities: surfacePreference === 'web'
      ? { ...legacyCapabilities, surface: 'web', gateway: false, bridge: false }
      : legacyCapabilities,
    bridgeLive: surfacePreference !== 'web',
    ...overrides
  }
}

test('DeepSeek Gateway is unavailable for Web and every legacy terminal generation', () => {
  assert.deepEqual(
    describeGatewaySessionEligibility(dshSession('web', 'web')),
    { eligible: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED' }
  )
  for (const session of [
    dshSession('legacy', 'legacy-tui'),
    dshSession('old-tui', 'tui'),
    dshSession('old-live', 'legacy-tui', { bridgeLive: true }),
    dshSession('old-untyped', undefined, { adapterConfig: {} })
  ]) {
    assert.deepEqual(
      describeGatewaySessionEligibility(session),
      { eligible: false, reason: 'DSH_TUI_UNAVAILABLE' }
    )
  }
  assert.deepEqual(
    describeGatewaySessionEligibility({ id: 'claude', adapterId: 'claude' }),
    { eligible: true, reason: null }
  )
})

test('Gateway operations never call a DSH adapter, including snapshot reads', async () => {
  const calls = []
  const entry = {
    status: 'idle',
    adapter: new Proxy({}, {
      get: (_target, property) => (...args) => {
        calls.push([property, ...args])
        return { accepted: true }
      }
    })
  }
  let session = dshSession('legacy', 'legacy-tui')
  const operations = createGatewaySessionOperations({
    getEntry: () => entry,
    getSession: () => session
  })

  assert.deepEqual(await operations.sendTurn(session.id, 'blocked'), {
    accepted: false, reason: 'DSH_TUI_UNAVAILABLE'
  })
  assert.deepEqual(await operations.interrupt(session.id), {
    accepted: false, reason: 'DSH_TUI_UNAVAILABLE'
  })
  assert.deepEqual(await operations.respondDecision(session.id, 'decision', {}), {
    accepted: false, reason: 'DSH_TUI_UNAVAILABLE'
  })
  assert.equal(operations.getDecisionContext(session.id, 'decision'), null)
  assert.equal(operations.getLatestPlanSnapshot(session.id, 'decision'), null)
  assert.equal(operations.getLatestResultSnapshot(session.id, 'turn'), null)

  session = dshSession('web', 'web')
  assert.deepEqual(await operations.sendTurn(session.id, 'blocked'), {
    accepted: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED'
  })
  assert.equal(operations.getLatestResultSnapshot(session.id, 'turn'), null)
  assert.deepEqual(calls, [])
})

test('Gateway manager exposes stable DSH reasons and rejects mutations before runtime', async () => {
  const sessions = [dshSession('web', 'web'), dshSession('legacy', 'legacy-tui')]
  let mutations = 0
  const runtime = {
    getState: () => ({}),
    getSessionRelayState: () => ({ queueCount: 0 }),
    async setSessionRelayEnabled() { mutations += 1; return { accepted: true } },
    async resyncSession() { mutations += 1 }
  }
  const manager = new GatewayManager({
    db: {},
    safeStorage: {},
    runtime,
    port: {
      listSessions: () => sessions,
      getSession: id => sessions.find(session => session.id === id) || null
    },
    routeStore: { listSessionRoutes: () => [] },
    secretStore: {},
    configService: { getAppliedConfig: () => null }
  })

  assert.deepEqual(manager.listSessions().map(({ id, gatewayEligible, gatewayReason }) => ({
    id, gatewayEligible, gatewayReason
  })), [
    { id: 'web', gatewayEligible: false, gatewayReason: 'DSH_WEB_GATEWAY_UNSUPPORTED' },
    { id: 'legacy', gatewayEligible: false, gatewayReason: 'DSH_TUI_UNAVAILABLE' }
  ])
  assert.deepEqual(await manager.setSessionRelayEnabled('web', true), {
    accepted: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED'
  })
  assert.deepEqual(await manager.setSessionRelayEnabled('legacy', true), {
    accepted: false, reason: 'DSH_TUI_UNAVAILABLE'
  })
  assert.deepEqual(await manager.resyncSession('legacy'), {
    accepted: false, reason: 'DSH_TUI_UNAVAILABLE'
  })
  assert.equal(mutations, 0)
})

test('Gateway restoration clears every unavailable DSH generation before routing', async () => {
  const web = session('dsh-web', {
    adapterId: 'deepseek-harness',
    gatewayEligible: false,
    gatewayReason: 'DSH_WEB_GATEWAY_UNSUPPORTED'
  })
  const legacy = session('dsh-legacy', {
    adapterId: 'deepseek-harness',
    gatewayEligible: false,
    gatewayReason: 'DSH_TUI_UNAVAILABLE'
  })
  const ordinary = session('claude-live')
  const port = createPort([web, legacy, ordinary])
  const routes = new MemoryRouteStore()
  for (const value of [web, legacy, ordinary]) {
    routes.upsertSessionRoute({ sessionId: value.id, relayEnabled: true })
  }
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  for (const value of [web, legacy, ordinary]) {
    runtime.taskQueue.enqueue(value.id, `${value.id}-message`, 'queued')
    runtime.decisionRegistry.register({
      decisionId: `${value.id}-decision`,
      kind: 'question',
      responseMode: 'free_text',
      options: []
    }, value.id)
    runtime.pendingDecisions.set(`${value.id}-pending`, {
      sessionId: value.id,
      decision: { decisionId: `${value.id}-decision` }
    })
    runtime.actions.set(`${value.id}-action`, { sessionId: value.id })
    runtime.latestCompletions.set(value.id, { sessionId: value.id })
  }

  const channel = new FakeGatewayChannel()
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-restored'
  })

  for (const value of [web, legacy]) {
    assert.equal(runtime.getSessionRelayState(value.id).queueCount, 0)
    assert.equal(runtime.decisionRegistry.listPendingForSession(value.id).length, 0)
    assert.equal([...runtime.pendingDecisions.values()].some(
      pending => pending.sessionId === value.id
    ), false)
    assert.equal([...runtime.actions.values()].some(
      action => action.sessionId === value.id
    ), false)
    assert.equal(runtime.latestCompletions.has(value.id), false)
    assert.equal(runtime.sessionGenerations.get(value.id), 1)
  }
  assert.equal(runtime.getSessionRelayState(ordinary.id).queueCount, 1)
  assert.equal(runtime.decisionRegistry.listPendingForSession(ordinary.id).length, 1)
  assert.equal(channel.roots.length, 1)
  assert.equal(channel.roots[0].view.shortSessionId, ordinary.id.slice(-8))
})
