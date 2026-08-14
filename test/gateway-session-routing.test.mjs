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

test('DeepSeek routes fail closed before queue, route, or reaction mutation', async () => {
  const unavailable = session('dsh-tui', {
    adapterId: 'deepseek-harness',
    gatewayEligible: false,
    gatewayReason: 'DSH_BRIDGE_DISCONNECTED'
  })
  const ready = session('codex-ready')
  const port = createPort([unavailable, ready])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: unavailable.id, relayEnabled: true })
  routes.upsertSessionRoute({ sessionId: ready.id, relayEnabled: true })
  routes.saveMessageRoute({
    messageId: 'dsh-root',
    sessionId: unavailable.id,
    routeKind: 'root',
    channelFingerprint: 'fingerprint-1'
  })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  const routesBefore = structuredClone(routes.messageRoutes)

  assert.deepEqual(await runtime.handleInboundMessage(message({
    replyToMessageId: 'dsh-root'
  })), {
    accepted: false,
    reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  routes.setRelayEnabled(ready.id, false)
  assert.deepEqual(await runtime.handleInboundMessage(message({
    messageId: 'fallback-message'
  })), {
    accepted: false,
    reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.deepEqual(port.calls.turns, [])
  assert.deepEqual(channel.reactions, [])
  assert.deepEqual(routes.messageRoutes, routesBefore)
})

test('a stopped DSH session cannot publish a late completion after snapshot wait', async () => {
  let resolveSnapshot
  const snapshot = new Promise(resolve => { resolveSnapshot = resolve })
  const dsh = session('dsh-live', {
    adapterId: 'deepseek-harness',
    gatewayEligible: true,
    gatewayReason: null
  })
  const port = createPort([dsh])
  port.getLatestResultSnapshot = () => snapshot
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1'
  })
  await runtime.handleInboundMessage(message())

  const completing = runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: dsh.id, turnId: 'turn-late'
  })
  await new Promise(resolve => setImmediate(resolve))
  port.sessions.set(dsh.id, {
    ...dsh,
    status: 'offline',
    gatewayEligible: false,
    gatewayReason: 'DSH_BRIDGE_DISCONNECTED'
  })
  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: dsh.id })
  const completionCount = channel.completions.length
  const rootCount = channel.roots.length
  port.sessions.set(dsh.id, {
    ...dsh,
    status: 'idle',
    gatewayEligible: true,
    gatewayReason: null
  })
  resolveSnapshot({ title: 'late', markdown: 'must not be delivered' })
  await completing

  assert.equal(channel.completions.length, completionCount)
  assert.equal(channel.roots.length, rootCount)
  assert.equal(runtime.getSessionRelayState(dsh.id).queueCount, 0)
})

test('a bridge disconnect during turn RPC rolls back before route or reaction side effects', async () => {
  const dsh = session('dsh-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  port.sendTurn = async () => ({
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  const routesBefore = structuredClone(routes.messageRoutes)

  assert.deepEqual(await runtime.handleInboundMessage(message()), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.equal(runtime.getSessionRelayState(dsh.id).queueCount, 0)
  assert.deepEqual(routes.messageRoutes, routesBefore)
  assert.deepEqual(channel.reactions, [])
})

test('a bridge disconnect during interrupt RPC preserves the running queue without cards', async () => {
  const dsh = session('dsh-interrupt-race', {
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
  await runtime.handleInboundMessage(message())
  const reactionCount = channel.reactions.length
  const cardCount = channel.cards.length
  port.interrupt = async () => ({
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })

  assert.deepEqual(await runtime._interrupt(dsh.id), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.equal(runtime.getSessionRelayState(dsh.id).queueCount, 1)
  assert.equal(channel.reactions.length, reactionCount)
  assert.equal(channel.cards.length, cardCount)
})

test('a stopped DSH generation cannot publish a late plan decision after restart', async () => {
  let resolvePlan
  const plan = new Promise(resolve => { resolvePlan = resolve })
  const dsh = session('dsh-decision-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  port.getLatestPlanSnapshot = () => plan
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  const actionCount = runtime.actions.size
  const messageRouteCount = routes.messageRoutes.length
  const deciding = runtime.handleGatewayEvent({
    type: 'decision_required',
    sessionId: dsh.id,
    turnId: 'turn-plan',
    decision: {
      decisionId: 'decision-late',
      kind: 'plan_review',
      title: 'Approve plan',
      summary: 'Run it',
      options: [{ id: 'allow_once', label: 'Allow' }],
      responseMode: 'plan_review'
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  port.sessions.set(dsh.id, {
    ...dsh, status: 'offline', gatewayEligible: false,
    gatewayReason: 'DSH_BRIDGE_DISCONNECTED'
  })
  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: dsh.id })
  port.sessions.set(dsh.id, { ...dsh, status: 'idle', gatewayEligible: true })
  resolvePlan({ markdown: '# Old plan' })
  await deciding

  assert.equal(channel.plans.length, 0)
  assert.equal(runtime.actions.size, actionCount)
  assert.equal(routes.messageRoutes.length, messageRouteCount)
  assert.equal(runtime.pendingDecisions.size, 0)
})

test('continue clears a resumed queue when the bridge refuses the next turn', async () => {
  const dsh = session('dsh-continue-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  port.sendTurn = async () => {
    throw Object.assign(new Error('gone'), { code: 'DSH_BRIDGE_DISCONNECTED' })
  }
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel: new FakeGatewayChannel(), config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  runtime.taskQueue.enqueue(dsh.id, 'current', 'current')
  runtime.taskQueue.enqueue(dsh.id, 'waiting', 'waiting')
  runtime.taskQueue.interrupt(dsh.id)
  const token = runtime._issueAction({ kind: 'continue', sessionId: dsh.id })

  assert.deepEqual(await runtime.handleInboundAction({
    token, senderOpenId: 'ou_operator'
  }), { accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED' })
  assert.equal(runtime.getSessionRelayState(dsh.id).queueCount, 0)
})

test('completion clears a queued next turn when its bridge start is refused', async () => {
  const dsh = session('dsh-next-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel: new FakeGatewayChannel(), config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  await runtime.handleInboundMessage(message({ messageId: 'current' }))
  await runtime.handleInboundMessage(message({ messageId: 'waiting' }))
  port.sendTurn = async () => {
    throw Object.assign(new Error('gone'), { code: 'DSH_BRIDGE_DISCONNECTED' })
  }

  await runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: dsh.id, turnId: 'current-turn'
  })
  assert.equal(runtime.getSessionRelayState(dsh.id).queueCount, 0)
})

test('a completion sent by an old generation stays inert after stop and restart', async () => {
  let resolveCompletion
  const completionSent = new Promise(resolve => { resolveCompletion = resolve })
  const dsh = session('dsh-completion-send-race', {
    adapterId: 'deepseek-harness', gatewayEligible: true, gatewayReason: null
  })
  const port = createPort([dsh])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: dsh.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  channel.sendCompletion = () => completionSent
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  const completing = runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: dsh.id, turnId: 'old-turn'
  })
  await new Promise(resolve => setImmediate(resolve))
  port.sessions.set(dsh.id, {
    ...dsh, status: 'offline', gatewayEligible: false,
    gatewayReason: 'DSH_BRIDGE_DISCONNECTED'
  })
  await runtime.handleGatewayEvent({ type: 'session_stopped', sessionId: dsh.id })
  port.sessions.set(dsh.id, { ...dsh, status: 'idle', gatewayEligible: true })
  const actionCount = runtime.actions.size
  const routeCount = routes.messageRoutes.length
  const rootUpdateCount = channel.rootUpdates.length
  resolveCompletion({ messageId: 'old-completion-message' })
  await completing

  assert.equal(runtime.actions.size, actionCount)
  assert.equal(routes.messageRoutes.length, routeCount)
  assert.equal(channel.rootUpdates.length, rootUpdateCount)
})

test('a completion pending during relay disable cannot restore routes or actions', async () => {
  let resolveCompletion
  const completionSent = new Promise(resolve => { resolveCompletion = resolve })
  const value = session('relay-disable-race')
  const port = createPort([value])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: value.id, relayEnabled: true })
  const channel = new FakeGatewayChannel()
  channel.sendCompletion = () => completionSent
  const runtime = new GatewayRuntime({ port, routeStore: routes })
  await runtime.attachConnectedChannel({
    channel, config: FEISHU_CONFIG, fingerprint: 'fingerprint-1'
  })
  const completing = runtime.handleGatewayEvent({
    type: 'turn_completed', sessionId: value.id, turnId: 'disabled-turn'
  })
  await new Promise(resolve => setImmediate(resolve))
  await runtime.setSessionRelayEnabled(value.id, false)
  const actionCount = runtime.actions.size
  const routeCount = routes.messageRoutes.length
  resolveCompletion({ messageId: 'disabled-completion-message' })
  await completing

  assert.equal(runtime.actions.size, actionCount)
  assert.equal(routes.messageRoutes.length, routeCount)
  assert.equal(routes.routes[0].relayEnabled, false)
})
