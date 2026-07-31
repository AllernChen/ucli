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
