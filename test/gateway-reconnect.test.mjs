import assert from 'node:assert/strict'
import test from 'node:test'

import { GatewayRuntime } from '../electron/gateway/runtime.js'
import {
  createPort,
  FakeGatewayChannel,
  FEISHU_CONFIG,
  MemoryRouteStore,
  session
} from './helpers/gatewayRuntimeHarness.mjs'

test('reconnect syncs current roots, pending decisions, and latest completion without replaying tasks', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  await runtime.handleGatewayEvent({
    type: 'decision_required',
    sessionId: 'session-1',
    turnId: 'turn-1',
    occurredAt: 1,
    decision: {
      decisionId: 'decision-1',
      kind: 'permission',
      title: 'Run tests?',
      summary: 'npm test',
      options: [{ id: 'allow_once', label: 'Allow once' }],
      responseMode: 'single'
    }
  })
  await runtime.handleGatewayEvent({
    type: 'turn_completed',
    sessionId: 'session-1',
    turnId: 'turn-1',
    occurredAt: 2
  })
  const before = {
    roots: channel.rootUpdates.length,
    decisions: channel.decisions.length,
    completions: channel.completions.length,
    turns: port.calls.turns.length
  }

  await channel.emitStatus({ type: 'reconnecting' })
  await channel.emitStatus({ type: 'reconnected' })

  assert.ok(channel.rootUpdates.length > before.roots)
  assert.ok(channel.decisions.length > before.decisions)
  assert.ok(channel.completions.length > before.completions)
  assert.equal(port.calls.turns.length, before.turns)
})

test('intentional off invalidates remote actions but retains selections and decisions', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const persisted = []
  const runtime = new GatewayRuntime({
    port,
    routeStore: routes,
    saveDesiredEnabled: (value) => persisted.push(value)
  })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  await runtime.setDesiredEnabled(false)

  assert.equal(runtime.getState().phase, 'off')
  assert.equal(channel.disconnectCount, 1)
  assert.equal(routes.routes[0].relayEnabled, true)
  assert.deepEqual(persisted, [false])
})

test('global off fails closed when remote root updates fail', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  channel.updateError = 'network_error'

  await runtime.setDesiredEnabled(false)

  assert.equal(runtime.getState().phase, 'off')
  assert.equal(channel.disconnectCount, 1)
  assert.deepEqual(await runtime.handleInboundMessage({
    messageId: 'late-message',
    senderOpenId: 'ou_operator'
  }), { accepted: false, reason: 'gateway_not_accepting' })
})

test('a stopped then restarted DSH session never replays its prior completion on reconnect', async () => {
  const dsh = session('dsh-session', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  await runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: dsh.id, turnId: 'old-turn'
  })
  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: dsh.id })
  const completionCount = channel.completions.length
  const actionCount = runtime.actions.size
  port.sessions.set(dsh.id, { ...dsh, status: 'idle', gatewayEligible: true })

  await channel.emitStatus({ type: 'reconnecting' })
  await channel.emitStatus({ type: 'reconnected' })

  assert.equal(channel.completions.length, completionCount)
  assert.equal(runtime.actions.size, actionCount)
})

test('a reconnect completion pending during relay disable cannot restore routes or actions', async () => {
  let resolveCompletion
  const completionSent = new Promise(resolve => { resolveCompletion = resolve })
  const value = session('reconnect-relay-disable-race')
  const port = createPort([value])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: value.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  await runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: value.id, turnId: 'completed-turn'
  })
  channel.sendCompletion = () => completionSent
  const reconnecting = channel.emitStatus({ type: 'reconnected' })
  await new Promise(resolve => setImmediate(resolve))
  await runtime.setSessionRelayEnabled(value.id, false)
  const actionCount = runtime.actions.size
  const routeCount = routes.messageRoutes.length
  resolveCompletion({ messageId: 'late-reconnect-completion' })
  await reconnecting

  assert.equal(runtime.actions.size, actionCount)
  assert.equal(routes.messageRoutes.length, routeCount)
  assert.equal(routes.routes[0].relayEnabled, false)
})
