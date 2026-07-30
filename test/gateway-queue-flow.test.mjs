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

function inbound(index) {
  return {
    messageId: `message-${index}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'ou_operator',
    text: `task ${index}`,
    rawContentType: 'text',
    supported: true,
    replyToMessageId: null,
    rootId: null,
    threadId: null
  }
}

test('runtime starts one task, queues five, rejects the sixth waiting item, and advances on completion', async () => {
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

  for (let index = 0; index <= 5; index++) {
    assert.equal((await runtime.handleInboundMessage(inbound(index))).accepted, true)
  }
  assert.deepEqual(await runtime.handleInboundMessage(inbound(6)), {
    accepted: false,
    reason: 'queue_full'
  })
  assert.deepEqual(channel.notices.at(-1).view, {
    reason: 'queue_full',
    message: '当前会话最多等待 5 个任务，请稍后重试。'
  })
  assert.equal(port.calls.turns.length, 1)
  assert.equal(channel.cards.length, 6)
  assert.equal(channel.reactions.length, 6)

  await runtime.handleGatewayEvent({
    type: 'turn_started',
    sessionId: 'session-1',
    turnId: 'turn-1',
    occurredAt: 1
  })
  await runtime.handleGatewayEvent({
    type: 'turn_completed',
    sessionId: 'session-1',
    turnId: 'turn-1',
    occurredAt: 2
  })
  assert.equal(channel.completions.length, 1)
  assert.equal(port.calls.turns.length, 2)
  assert.equal(port.calls.turns[1].text, 'task 1')
})

test('remote interrupt pauses the queue, continue resumes its head, and clear reports cancellation', async () => {
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
  await runtime.handleInboundMessage(inbound(0))
  await runtime.handleInboundMessage(inbound(1))
  await runtime.handleInboundMessage(inbound(2))
  const interruptToken = channel.rootUpdates.at(-1).view.interruptToken

  await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: interruptToken
  })
  assert.deepEqual(port.calls.interrupts, ['session-1'])
  const interruptCard = channel.cards.at(-1)
  const actionTokens = interruptCard.card.body.elements
    .flatMap((element) => element.behaviors || [])
    .map((behavior) => behavior.value?.token)
    .filter(Boolean)
  const [continueToken, clearToken] = actionTokens
  await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: continueToken
  })
  assert.equal(port.calls.turns.at(-1).text, 'task 1')
  assert.deepEqual(await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: clearToken
  }), { accepted: true, cancelled: 2 })
  assert.equal(runtime.getState().queuedTaskCount, 0)
})

test('a Feishu task waits behind an already-running desktop turn', async () => {
  const port = createPort([session('session-1', {
    status: 'running',
    turnActive: true
  })])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })

  const accepted = await runtime.handleInboundMessage(inbound(1))
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.position, 1)
  assert.equal(port.calls.turns.length, 0)

  await runtime.handleGatewayEvent({
    type: 'turn_started',
    sessionId: 'session-1',
    turnId: 'desktop-turn',
    occurredAt: 1
  })
  await runtime.handleGatewayEvent({
    type: 'turn_completed',
    sessionId: 'session-1',
    turnId: 'desktop-turn',
    occurredAt: 2
  })

  assert.deepEqual(port.calls.turns, [{
    sessionId: 'session-1',
    text: 'task 1'
  }])
})
