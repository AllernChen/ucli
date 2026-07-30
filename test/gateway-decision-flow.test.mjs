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

function decisionEvent(kind = 'permission') {
  return {
    type: 'decision_required',
    sessionId: 'session-1',
    turnId: 'turn-1',
    occurredAt: 1,
    decision: {
      decisionId: 'decision-1',
      kind,
      title: kind === 'plan_review' ? 'Gateway plan' : 'Run tests?',
      summary: kind === 'plan_review' ? '# Gateway plan' : 'npm test',
      options: kind === 'plan_review'
        ? [
            { id: 'execute', label: '执行方案' },
            { id: 'reject', label: '拒绝' }
          ]
        : [
            { id: 'allow_once', label: 'Allow once' },
            { id: 'deny', label: 'Deny' }
          ],
      responseMode: kind === 'plan_review' ? 'plan_review' : 'single'
    }
  }
}

test('authorized opaque decision actions resolve exactly once and persist metadata only', async () => {
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
  await runtime.handleGatewayEvent(decisionEvent())
  const token = channel.decisions[0].view.actions[0].token

  assert.deepEqual(await runtime.handleInboundAction({
    messageId: 'decision-message-1',
    chatId: 'oc_group',
    senderOpenId: 'ou_operator',
    token
  }), { accepted: true })
  assert.deepEqual(await runtime.handleInboundAction({
    messageId: 'decision-message-1',
    chatId: 'oc_group',
    senderOpenId: 'ou_operator',
    token
  }), { accepted: false, reason: 'invalid_action_token' })
  assert.equal(port.calls.decisions.length, 1)
  assert.equal(routes.audits.length, 1)
  assert.equal(JSON.stringify(routes.audits).includes('npm test'), false)
})

test('plan overview expands from memory and only final detail exposes execute actions', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({
    port,
    routeStore: routes,
    snapshotChunkSize: 20
  })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  await runtime.handleGatewayEvent(decisionEvent('plan_review'))
  assert.equal(channel.plans.length, 1)
  const viewToken = channel.plans[0].view.viewToken
  await runtime.handleInboundAction({
    messageId: 'plan-message-1',
    chatId: 'oc_group',
    senderOpenId: 'ou_operator',
    token: viewToken
  })

  assert.ok(channel.cards.length > 1)
  const encodedBeforeLast = JSON.stringify(channel.cards.slice(0, -1))
  assert.equal(encodedBeforeLast.includes('执行方案'), false)
  assert.equal(JSON.stringify(channel.cards.at(-1)).includes('执行方案'), true)
})

test('a routed plan reply submits revision text through the decision API', async () => {
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
  await runtime.handleGatewayEvent(decisionEvent('plan_review'))

  const result = await runtime.handleInboundMessage({
    messageId: 'revision-message',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_operator',
    text: '请补上回滚步骤',
    rawContentType: 'text',
    supported: true,
    replyToMessageId: channel.plans[0].messageId,
    rootId: null,
    threadId: null
  })

  assert.deepEqual(result, { accepted: true })
  assert.deepEqual(port.calls.decisions[0].response, {
    action: 'revise',
    text: '请补上回滚步骤'
  })
  assert.equal(port.calls.turns.length, 0)
})

test('large safe decisions expose full content from memory without persisting it', async () => {
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
  const event = decisionEvent()
  event.decision.summary = 'x'.repeat(1200)
  await runtime.handleGatewayEvent(event)
  const viewAction = channel.decisions[0].view.actions
    .find((action) => action.id === 'view_full')

  assert.ok(viewAction?.token)
  await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: viewAction.token
  })
  assert.equal(JSON.stringify(channel.cards.at(-1)).includes('x'.repeat(100)), true)
  assert.equal(JSON.stringify(routes).includes('x'.repeat(100)), false)
  assert.equal(port.calls.decisions.length, 0)
})

test('a winning desktop response resolves the provider and invalidates every remote button', async () => {
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
  await runtime.handleGatewayEvent(decisionEvent())
  const oldToken = channel.decisions[0].view.actions[0].token

  assert.deepEqual(await runtime.respondDesktopDecision(
    'session-1',
    'decision-1',
    { action: 'deny' }
  ), { accepted: true })
  assert.deepEqual(port.calls.decisions[0].response, { action: 'deny' })
  assert.equal(channel.cardUpdates.length, 1)
  assert.deepEqual(await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: oldToken
  }), { accepted: false, reason: 'invalid_action_token' })
})

test('relay disable and fingerprint changes invalidate scoped remote actions', async () => {
  const port = createPort([
    session('session-1'),
    session('session-2')
  ])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  routes.upsertSessionRoute({ sessionId: 'session-2', relayEnabled: true })
  const first = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel: first,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  await runtime.handleGatewayEvent(decisionEvent())
  const disabledToken = first.decisions[0].view.actions[0].token

  first.updateError = 'network_error'
  await runtime.setSessionRelayEnabled('session-1', false)
  assert.equal(routes.routes[0].rootMessageId, null)
  assert.equal(
    routes.messageRoutes
      .filter((route) => route.sessionId === 'session-1')
      .every((route) => route.active === false),
    true
  )
  assert.deepEqual(await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: disabledToken
  }), { accepted: false, reason: 'invalid_action_token' })
  assert.equal(port.calls.decisions.length, 0)

  first.updateError = null
  const secondEvent = decisionEvent()
  secondEvent.sessionId = 'session-2'
  secondEvent.decision.decisionId = 'decision-2'
  await runtime.handleGatewayEvent(secondEvent)
  const migratedToken = first.decisions.at(-1).view.actions[0].token
  await runtime.attachConnectedChannel({
    channel: new FakeGatewayChannel(),
    config: {
      ...FEISHU_CONFIG,
      target: { type: 'group', id: 'oc_new_group' }
    },
    fingerprint: 'fingerprint-2'
  })
  assert.deepEqual(await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: migratedToken
  }), { accepted: false, reason: 'invalid_action_token' })
  assert.equal(port.calls.decisions.length, 0)
})

test('native desktop input wins a pending plan decision and invalidates Feishu', async () => {
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
  await runtime.handleGatewayEvent(decisionEvent('plan_review'))
  const oldToken = channel.plans[0].view.viewToken

  assert.deepEqual(await runtime.respondDesktopInput('session-1'), {
    accepted: true,
    decisionId: 'decision-1'
  })
  assert.deepEqual(await runtime.handleInboundAction({
    senderOpenId: 'ou_operator',
    token: oldToken
  }), { accepted: false, reason: 'invalid_action_token' })
  assert.equal(port.calls.decisions.length, 0)
  assert.equal(channel.cardUpdates.length, 1)
})
