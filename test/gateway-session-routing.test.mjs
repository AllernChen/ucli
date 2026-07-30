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

function message(overrides = {}) {
  return {
    messageId: 'message-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'ou_operator',
    text: 'Run tests',
    rawContentType: 'text',
    supported: true,
    replyToMessageId: null,
    rootId: null,
    threadId: null,
    ...overrides
  }
}

test('private unquoted text routes only when exactly one selected session is ready', async () => {
  const port = createPort([session('session-1'), session('session-2')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  routes.upsertSessionRoute({ sessionId: 'session-2', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })

  assert.deepEqual(await runtime.handleInboundMessage(message()), {
    accepted: false,
    reason: 'ambiguous_session'
  })
  assert.deepEqual(port.calls.turns, [])

  routes.setRelayEnabled('session-2', false)
  assert.equal((await runtime.handleInboundMessage(message())).accepted, true)
  assert.deepEqual(port.calls.turns, [{
    sessionId: 'session-1',
    text: 'Run tests'
  }])
})

test('known reply routes beat fallback and group messages never use unquoted fallback', async () => {
  const port = createPort([session('session-1'), session('session-2')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  routes.upsertSessionRoute({ sessionId: 'session-2', relayEnabled: true })
  routes.saveMessageRoute({
    messageId: 'known-root',
    sessionId: 'session-2',
    routeKind: 'root',
    channelFingerprint: 'fingerprint-1'
  })
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel: new FakeGatewayChannel(),
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })

  assert.equal((await runtime.handleInboundMessage(message({
    replyToMessageId: 'known-root'
  }))).accepted, true)
  assert.equal(port.calls.turns[0].sessionId, 'session-2')
  assert.deepEqual(await runtime.handleInboundMessage(message({
    messageId: 'group-message',
    chatType: 'group',
    replyToMessageId: null
  })), { accepted: false, reason: 'route_required' })
  assert.deepEqual(await runtime.handleInboundMessage(message({
    messageId: 'unauthorized',
    senderOpenId: 'ou_intruder'
  })), { accepted: false, reason: 'unauthorized_operator' })
})
