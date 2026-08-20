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

test('selected ready sessions create and reuse one persistent root', async () => {
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

  assert.equal(channel.roots.length, 1)
  assert.equal(routes.routes[0].rootMessageId, 'root-1')
  assert.equal(routes.routes[0].rootThreadId, 'thread-1')
  assert.deepEqual(channel.threadStarters, [{
    messageId: 'thread-starter-1',
    route: routes.routes[0]
  }])
  const threadStarterRoute = routes.messageRoutes.find(
    (route) => route.messageId === 'thread-starter-1'
  )
  assert.equal(threadStarterRoute?.active, true)
  assert.equal(threadStarterRoute?.sessionId, 'session-1')
  assert.equal(threadStarterRoute?.routeKind, 'thread')
  assert.equal(threadStarterRoute?.channelFingerprint, 'fingerprint-1')
  assert.equal(JSON.stringify(channel.roots[0]).includes('terminal'), false)

  await runtime.resyncSession('session-1')
  assert.equal(channel.roots.length, 1)
  assert.equal(channel.threadStarters.length, 1)
  assert.equal(channel.rootUpdates.length, 1)
})

test('a revoked root is replaced atomically while relay selection remains enabled', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({
    sessionId: 'session-1',
    relayEnabled: true,
    channelFingerprint: 'fingerprint-1',
    targetId: 'oc_group',
    rootMessageId: 'recalled-root',
    rootThreadId: 'recalled-thread',
    routeStatus: 'ready'
  })
  const channel = new FakeGatewayChannel()
  channel.updateError = 'target_revoked'
  const runtime = new GatewayRuntime({ port, routeStore: routes })

  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })

  assert.equal(channel.roots.length, 1)
  assert.equal(routes.routes[0].relayEnabled, true)
  assert.equal(routes.routes[0].rootMessageId, 'root-1')
  assert.notEqual(routes.routes[0].rootMessageId, 'recalled-root')
})

test('stopping a session clears transient work but retains selection and root', async () => {
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
  const rootMessageId = routes.routes[0].rootMessageId

  await runtime.handleGatewayEvent({
    type: 'session_stopped',
    sessionId: 'session-1',
    occurredAt: 1
  })

  assert.equal(routes.routes[0].relayEnabled, true)
  assert.equal(routes.routes[0].rootMessageId, rootMessageId)
  assert.ok(channel.rootUpdates.length > 0)
})

test('stopping a disconnected selected session never creates a missing root', async () => {
  const value = session('session-stopped', {
    adapterId: 'deepseek-harness',
    status: 'offline',
    gatewayEligible: false,
    gatewayReason: 'DSH_TUI_UNAVAILABLE'
  })
  const port = createPort([value])
  const routes = new MemoryRouteStore()
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  routes.upsertSessionRoute({ sessionId: value.id, relayEnabled: true })

  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: value.id })

  assert.equal(channel.roots.length, 0)
  assert.equal(routes.routes[0].rootMessageId, null)
})

test('a root created by an old generation stays inert after stop and restart', async () => {
  let resolveRoot
  const rootSent = new Promise(resolve => { resolveRoot = resolve })
  const value = session('session-root-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([value])
  const routes = new MemoryRouteStore()
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  channel.sendSessionRoot = () => rootSent
  routes.upsertSessionRoute({ sessionId: value.id, relayEnabled: true })
  const syncing = runtime.resyncSession(value.id)
  await new Promise(resolve => setImmediate(resolve))
  port.sessions.set(value.id, {
    ...value, status: 'offline', gatewayEligible: false,
    gatewayReason: 'DSH_TUI_UNAVAILABLE'
  })
  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: value.id })
  port.sessions.set(value.id, { ...value, status: 'idle', gatewayEligible: true })
  resolveRoot({ messageId: 'old-root', threadId: 'old-thread' })
  await syncing

  assert.equal(routes.routes[0].rootMessageId, null)
  assert.equal(routes.messageRoutes.length, 0)
  assert.equal(channel.threadStarters.length, 0)
})
