import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GatewayManager } from '../electron/gateway/manager.js'
import { openDb } from '../electron/persistence/db.js'
import {
  createPort,
  FakeGatewayChannel,
  FEISHU_CONFIG,
  MemoryRouteStore,
  session
} from './helpers/gatewayRuntimeHarness.mjs'

function memoryDb() {
  const settings = new Map()
  const secrets = new Map()
  return {
    getGatewaySetting: (key) => settings.get(key) ?? null,
    saveGatewaySetting: (key, value) => settings.set(key, structuredClone(value)),
    getGatewaySecretCiphertext: (key) => secrets.get(key) ?? null,
    saveGatewaySecretCiphertext: (key, value) => secrets.set(key, value),
    getGatewayDiagnosticCounts: () => ({
      sessionRoutes: 2,
      messageRoutes: 0,
      decisionAudits: 0
    }),
    flush() {},
    async transaction(work) { return work() }
  }
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  }
}

class ConnectedFakeChannel extends FakeGatewayChannel {
  async connect(config) {
    this.connectedWith = {
      channelType: config.channelType,
      appId: config.appId,
      target: { ...config.target },
      operatorCount: config.operatorOpenIds.length,
      hasSecret: Boolean(config.appSecret)
    }
    return { openId: 'ou_bot', name: 'UCLI Bot' }
  }
}

function inbound(index) {
  return {
    messageId: `inbound-${index}`,
    chatId: 'oc_group',
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

function decisionEvent(decisionId, kind = 'permission') {
  const plan = kind === 'plan_review'
  return {
    type: 'decision_required',
    sessionId: 'ready-session',
    turnId: 'turn-1',
    occurredAt: Date.now(),
    decision: {
      decisionId,
      kind,
      title: plan ? 'Review implementation plan' : 'Run command?',
      summary: plan ? '# Gateway plan' : 'npm test',
      options: plan
        ? [
            { id: 'execute', label: '执行方案' },
            { id: 'reject', label: '拒绝' }
          ]
        : [
            { id: 'allow_once', label: 'Allow once' },
            { id: 'deny', label: 'Deny' }
          ],
      responseMode: plan ? 'plan_review' : 'single'
    }
  }
}

function cardActionTokens(card) {
  return card.body.elements
    .flatMap((element) => element.behaviors || [])
    .map((behavior) => behavior.value?.token)
    .filter(Boolean)
}

test('global Gateway runs the complete fake Feishu lifecycle without persisting content', async () => {
  const db = memoryDb()
  const routes = new MemoryRouteStore()
  const port = createPort([
    session('ready-session'),
    session('offline-session', { status: 'stopped' })
  ])
  const channels = []
  const createChannel = () => {
    const channel = new ConnectedFakeChannel()
    channels.push(channel)
    return channel
  }
  const manager = new GatewayManager({
    db,
    safeStorage: fakeSafeStorage(),
    port,
    routeStore: routes,
    createChannel
  })

  await manager.start()
  const tested = await manager.testDraft({
    config: FEISHU_CONFIG,
    appSecret: 'local-test-secret'
  })
  assert.ok(tested.testId)
  assert.equal((await manager.applyDraft(tested.testId)).hasAppSecret, true)
  await manager.setSessionRelayEnabled('ready-session', true)
  await manager.setSessionRelayEnabled('offline-session', true)
  await manager.setDesiredEnabled(true)

  const channel = channels.at(-1)
  assert.equal(manager.getState().phase, 'connected')
  assert.equal(manager.getState().selectedSessionCount, 2)
  assert.equal(manager.getState().readySessionCount, 1)
  assert.equal(channel.roots.length, 1)
  assert.equal(channel.roots[0].view.displayName, 'Session ready-session')

  assert.deepEqual(await manager.resyncSession('ready-session'), {
    accepted: true
  })
  assert.equal(channel.roots.length, 1, 'the existing root is reused')

  assert.equal((await channel.emitMessage(inbound(1)))[0].accepted, true)
  for (let index = 2; index <= 6; index += 1) {
    assert.equal((await channel.emitMessage(inbound(index)))[0].accepted, true)
  }
  assert.deepEqual((await channel.emitMessage(inbound(7)))[0], {
    accepted: false,
    reason: 'queue_full'
  })
  assert.equal(port.calls.turns.length, 1)

  await port.emitGatewayEvent(decisionEvent('plan-revision', 'plan_review'))
  const firstPlan = channel.plans.at(-1)
  await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: firstPlan.view.viewToken
  })
  assert.ok(channel.cards.length > 0, 'full plan is available without an LLM')
  assert.deepEqual((await channel.emitMessage({
    ...inbound('revision'),
    chatType: 'group',
    replyToMessageId: firstPlan.messageId,
    text: '补充回滚步骤'
  }))[0], { accepted: true })
  assert.deepEqual(port.calls.decisions.at(-1).response, {
    action: 'revise',
    text: '补充回滚步骤'
  })

  await port.emitGatewayEvent(decisionEvent('plan-execute', 'plan_review'))
  await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: channel.plans.at(-1).view.viewToken
  })
  const executeToken = cardActionTokens(channel.cards.at(-1).card)[0]
  assert.deepEqual((await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: executeToken
  }))[0], { accepted: true })
  assert.equal(port.calls.decisions.at(-1).response.action, 'execute')

  await port.emitGatewayEvent(decisionEvent('decision-race'))
  const remoteToken = channel.decisions.at(-1).view.actions[0].token
  const [desktop, remote] = await Promise.all([
    manager.respondDesktopDecision(
      'ready-session',
      'decision-race',
      { action: 'deny' }
    ),
    channel.emitAction({
      senderOpenId: 'ou_operator',
      token: remoteToken
    })
  ])
  assert.deepEqual(desktop, { accepted: true })
  assert.equal(remote[0].accepted, false)
  assert.match(remote[0].reason, /^(already_resolved|invalid_action_token)$/)
  assert.equal(
    port.calls.decisions.filter((call) => call.decisionId === 'decision-race').length,
    1
  )

  await port.emitGatewayEvent({
    type: 'turn_started',
    sessionId: 'ready-session',
    turnId: 'turn-1',
    occurredAt: 1
  })
  await port.emitGatewayEvent({
    type: 'turn_completed',
    sessionId: 'ready-session',
    turnId: 'turn-1',
    occurredAt: 2
  })
  assert.equal(channel.completions.length, 1)
  const beforeResultCards = channel.cards.length
  await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: channel.completions[0].view.resultToken
  })
  assert.ok(channel.cards.length > beforeResultCards)
  assert.equal(port.calls.turns.at(-1).text, 'task 2')

  const interruptToken = channel.rootUpdates.at(-1).view.interruptToken
  await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: interruptToken
  })
  assert.deepEqual(port.calls.interrupts, ['ready-session'])
  const [continueToken, clearToken] = cardActionTokens(channel.cards.at(-1).card)
  await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: continueToken
  })
  assert.equal(port.calls.turns.at(-1).text, 'task 3')
  assert.deepEqual((await channel.emitAction({
    senderOpenId: 'ou_operator',
    token: clearToken
  }))[0], { accepted: true, cancelled: 4 })

  await port.emitGatewayEvent(decisionEvent('pending-at-reconnect'))
  const beforeReconnect = {
    roots: channel.rootUpdates.length,
    decisions: channel.decisions.length,
    completions: channel.completions.length,
    turns: port.calls.turns.length
  }
  await channel.emitStatus({ type: 'reconnecting' })
  await channel.emitStatus({ type: 'reconnected' })
  assert.ok(channel.rootUpdates.length > beforeReconnect.roots)
  assert.ok(channel.decisions.length > beforeReconnect.decisions)
  assert.ok(channel.completions.length > beforeReconnect.completions)
  assert.equal(port.calls.turns.length, beforeReconnect.turns)

  await manager.setDesiredEnabled(false)
  assert.equal(manager.getState().phase, 'off')
  assert.equal(port.getSession('ready-session').status, 'idle')
  assert.equal(port.getSession('offline-session').status, 'stopped')
  await manager.shutdown()

  const restarted = new GatewayManager({
    db,
    safeStorage: fakeSafeStorage(),
    port,
    routeStore: routes,
    createChannel
  })
  await restarted.start()
  assert.equal(restarted.getState().desiredEnabled, false)
  assert.equal(restarted.getState().phase, 'off')
  assert.equal(restarted.listSessions().filter((value) => value.relayEnabled).length, 2)
  assert.equal(channels.length, 3, 'disabled restart does not open a channel')
  assert.doesNotMatch(
    JSON.stringify({ routes: routes.routes, messages: routes.messageRoutes, audits: routes.audits }),
    /local-test-secret|task [1-7]|Gateway plan|补充回滚|All tests passed/
  )
  await restarted.shutdown()
})

test('real database restart retains only Gateway configuration, routes, and audit metadata', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-e2e-'))
  const path = join(dir, 'ucli.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = await openDb(path)
  const port = createPort([session('persist-session')])
  const channels = []
  const manager = new GatewayManager({
    db,
    safeStorage: fakeSafeStorage(),
    port,
    createChannel: () => {
      const channel = new ConnectedFakeChannel()
      channels.push(channel)
      return channel
    }
  })

  await manager.start()
  const tested = await manager.testDraft({
    config: FEISHU_CONFIG,
    appSecret: 'database-secret-plaintext'
  })
  await manager.applyDraft(tested.testId)
  await manager.setSessionRelayEnabled('persist-session', true)
  await manager.setDesiredEnabled(true)
  const channel = channels.at(-1)
  await channel.emitMessage({
    ...inbound('persist'),
    messageId: 'persist-message',
    text: 'database-private-task-body'
  })
  await port.emitGatewayEvent({
    ...decisionEvent('persist-decision'),
    sessionId: 'persist-session',
    decision: {
      ...decisionEvent('persist-decision').decision,
      summary: 'database-private-decision-body'
    }
  })
  await port.emitGatewayEvent({
    type: 'turn_started',
    sessionId: 'persist-session',
    turnId: 'persist-turn',
    occurredAt: 1
  })
  await port.emitGatewayEvent({
    type: 'turn_completed',
    sessionId: 'persist-session',
    turnId: 'persist-turn',
    occurredAt: 2
  })
  await manager.setDesiredEnabled(false)
  await manager.shutdown()
  db.close()

  const reopened = await openDb(path)
  try {
    assert.equal(reopened.getGatewaySetting('gateway.desiredEnabled'), false)
    assert.equal(
      reopened.listGatewaySessionRoutes()
        .find((route) => route.sessionId === 'persist-session')
        ?.relayEnabled,
      true
    )
    const persisted = JSON.stringify(reopened.sql.exec(`
      SELECT * FROM gateway_session_routes;
      SELECT * FROM gateway_message_routes;
      SELECT * FROM gateway_decision_audit;
      SELECT * FROM gateway_secrets;
      SELECT * FROM settings WHERE key LIKE 'gateway.%';
    `))
    for (const forbidden of [
      'database-secret-plaintext',
      'database-private-task-body',
      'database-private-decision-body',
      'Gateway plan',
      'Gateway completed',
      'All tests passed'
    ]) {
      assert.doesNotMatch(persisted, new RegExp(forbidden))
    }
    assert.deepEqual(reopened.getGatewayDiagnosticCounts(), {
      sessionRoutes: 1,
      messageRoutes: 6,
      decisionAudits: 0
    })
  } finally {
    reopened.close()
  }
})
