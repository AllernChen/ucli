import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  channelFingerprint,
  GatewayConfigService,
  normalizeGatewayConfig
} from '../electron/gateway/config.js'
import { GatewayManager } from '../electron/gateway/manager.js'
import { GatewayRuntime } from '../electron/gateway/runtime.js'
import { SecretStore } from '../electron/gateway/secretStore.js'
import { openDb } from '../electron/persistence/db.js'
import {
  createPort,
  MemoryRouteStore
} from './helpers/gatewayRuntimeHarness.mjs'

const UNBOUND_CONFIG = {
  channelType: 'feishu',
  appId: 'cli_example',
  target: null,
  operatorOpenIds: []
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`cipher:${value}`),
    decryptString: (value) => value.toString().replace(/^cipher:/, '')
  }
}

function bindingChannel() {
  const listeners = new Set()
  return {
    roots: [],
    notices: [],
    onUserMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onAction() { return () => {} },
    onStatus() { return () => {} },
    async resolveBindingCandidate(message) {
      return {
        target: {
          type: message.chatType === 'group' ? 'group' : 'user',
          id: message.chatType === 'group' ? message.chatId : message.senderOpenId,
          name: message.chatType === 'group' ? '研发群' : message.senderName
        },
        operator: {
          openId: message.senderOpenId,
          name: message.senderName
        }
      }
    },
    async sendBindingNotice(message, view) {
      this.notices.push({ message, view })
    },
    async sendSessionRoot(view) {
      this.roots.push(view)
      return { messageId: 'root-1' }
    }
  }
}

test('unbound Feishu configuration connects without manually entered target IDs', () => {
  assert.deepEqual(normalizeGatewayConfig(UNBOUND_CONFIG), UNBOUND_CONFIG)
  assert.equal(channelFingerprint(UNBOUND_CONFIG).length, 64)
})

test('an explicit Feishu bind message creates a local confirmation candidate without forwarding', async () => {
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = bindingChannel()
  const runtime = new GatewayRuntime({
    port: createPort([{
      id: 'session-1',
      adapterId: 'claude',
      status: 'idle'
    }]),
    routeStore: routes
  })

  await runtime.attachConnectedChannel({
    channel,
    config: UNBOUND_CONFIG,
    fingerprint: channelFingerprint(UNBOUND_CONFIG),
    botIdentity: { openId: 'ou_bot', name: 'UCLI' }
  })

  assert.equal(runtime.getState().phase, 'waiting_binding')
  assert.equal(channel.roots.length, 0)

  const result = await runtime.handleInboundMessage({
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_operator',
    senderName: '张三',
    text: '绑定 UCLI',
    rawContentType: 'text',
    supported: true
  })

  assert.deepEqual(result, {
    accepted: true,
    reason: 'binding_confirmation_required'
  })
  assert.deepEqual(runtime.getState().bindingCandidate, {
    id: runtime.getState().bindingCandidate.id,
    targetType: 'group',
    displayName: '研发群',
    operatorName: '张三',
    targetHint: 'oc_g…roup',
    operatorHint: 'ou_o…ator',
    confirmationCode: runtime.getState().bindingCandidate.confirmationCode,
    requestedAt: runtime.getState().bindingCandidate.requestedAt
  })
  assert.equal(runtime.getState().bindingCandidate.id.length > 20, true)
  assert.match(runtime.getState().bindingCandidate.confirmationCode, /^[A-Z0-9_-]{6}$/)
  assert.equal(channel.notices.length, 1)
  assert.equal(channel.roots.length, 0)

  const pending = runtime.getBindingCandidate(runtime.getState().bindingCandidate.id)
  assert.deepEqual(pending.target, {
    type: 'group',
    id: 'oc_group',
    name: '研发群'
  })
  assert.deepEqual(pending.operator, {
    openId: 'ou_operator',
    name: '张三'
  })
})

test('the first binding candidate stays locked until it is confirmed or dismissed', async () => {
  const runtime = new GatewayRuntime({
    port: createPort(),
    routeStore: new MemoryRouteStore()
  })
  const channel = bindingChannel()
  await runtime.attachConnectedChannel({
    channel,
    config: UNBOUND_CONFIG,
    fingerprint: channelFingerprint(UNBOUND_CONFIG)
  })

  await runtime.handleInboundMessage({
    messageId: 'message-a',
    chatId: 'oc_group_a',
    chatType: 'group',
    senderOpenId: 'ou_operator_a',
    senderName: '操作人 A',
    text: '绑定 UCLI',
    rawContentType: 'text',
    supported: true
  })
  const first = structuredClone(runtime.getState().bindingCandidate)

  assert.deepEqual(await runtime.handleInboundMessage({
    messageId: 'message-b',
    chatId: 'oc_group_b',
    chatType: 'group',
    senderOpenId: 'ou_operator_b',
    senderName: '操作人 B',
    text: '绑定 UCLI',
    rawContentType: 'text',
    supported: true
  }), {
    accepted: false,
    reason: 'binding_candidate_pending'
  })
  assert.deepEqual(runtime.getState().bindingCandidate, first)
  assert.equal(runtime.getBindingCandidate(first.id).target.id, 'oc_group_a')
})

test('installing another unbound channel invalidates candidates from the previous connection', async () => {
  const runtime = new GatewayRuntime({
    port: createPort(),
    routeStore: new MemoryRouteStore()
  })
  await runtime.attachConnectedChannel({
    channel: bindingChannel(),
    config: UNBOUND_CONFIG,
    fingerprint: channelFingerprint(UNBOUND_CONFIG)
  })
  await runtime.handleInboundMessage({
    messageId: 'message-a',
    chatId: 'oc_group_a',
    chatType: 'group',
    senderOpenId: 'ou_operator_a',
    senderName: '操作人 A',
    text: '绑定 UCLI',
    rawContentType: 'text',
    supported: true
  })
  const bindingId = runtime.getState().bindingCandidate.id

  await runtime.attachConnectedChannel({
    channel: bindingChannel(),
    config: UNBOUND_CONFIG,
    fingerprint: channelFingerprint(UNBOUND_CONFIG)
  })

  assert.equal(runtime.getState().bindingCandidate, null)
  assert.equal(runtime.getBindingCandidate(bindingId), null)
})

test('ordinary Feishu messages cannot become binding candidates', async () => {
  const runtime = new GatewayRuntime({
    port: createPort(),
    routeStore: new MemoryRouteStore()
  })
  const channel = bindingChannel()
  await runtime.attachConnectedChannel({
    channel,
    config: UNBOUND_CONFIG,
    fingerprint: channelFingerprint(UNBOUND_CONFIG)
  })

  assert.deepEqual(await runtime.handleInboundMessage({
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_operator',
    senderName: '张三',
    text: '执行测试',
    rawContentType: 'text',
    supported: true
  }), {
    accepted: false,
    reason: 'binding_command_required'
  })
  assert.equal(runtime.getState().bindingCandidate, null)
})

test('binding configuration mutations are single-flight and stale UI results are rejected', async () => {
  let resolveBinding
  const pendingBinding = new Promise((resolve) => {
    resolveBinding = resolve
  })
  const runtime = {
    getState: () => ({ desiredEnabled: true }),
    getBindingCandidate: () => ({
      target: { type: 'group', id: 'oc_group' },
      operator: { openId: 'ou_operator' }
    }),
    dismissBindingCandidate: () => ({ accepted: true })
  }
  const manager = new GatewayManager({
    db: {},
    safeStorage: {},
    port: createPort(),
    routeStore: new MemoryRouteStore(),
    secretStore: {},
    runtime,
    configService: {
      applyBindingCandidate: () => pendingBinding,
      clearBinding: async () => UNBOUND_CONFIG,
      dispose: async () => {}
    }
  })

  const first = manager.confirmBinding('binding-id')
  assert.deepEqual(await manager.confirmBinding('binding-id'), {
    accepted: false,
    reason: 'configuration_operation_in_progress'
  })
  assert.deepEqual(await manager.clearBinding(), {
    accepted: false,
    reason: 'configuration_operation_in_progress'
  })
  assert.deepEqual(manager.dismissBinding('binding-id'), {
    accepted: false,
    reason: 'configuration_operation_in_progress'
  })
  await assert.rejects(
    manager.setDesiredEnabled(false),
    { code: 'GATEWAY_CONFIG_BUSY' }
  )

  resolveBinding({ ...UNBOUND_CONFIG, target: { type: 'group', id: 'oc_group' } })
  assert.equal((await first).accepted, true)
})

test('confirming an inbound candidate persists the target and first operator atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-binding-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const secretStore = new SecretStore({ db, safeStorage: safeStorage() })
  db.saveGatewaySetting('gateway.config', UNBOUND_CONFIG)
  secretStore.setSecret('gateway.feishu.appSecret', 'top-secret')
  const oldChannel = { disconnect: async () => { oldChannel.disconnected = true } }
  const runtime = {
    channel: oldChannel,
    getChannel() { return this.channel },
    getConnection: () => ({
      config: UNBOUND_CONFIG,
      fingerprint: channelFingerprint(UNBOUND_CONFIG)
    }),
    async setChannel(channel, connection) {
      this.channel = channel
      this.connection = connection
    }
  }
  const channels = []
  const service = new GatewayConfigService({
    db,
    secretStore,
    runtime,
    shouldActivate: () => true,
    createChannel: () => {
      const channel = {
        async connect(config) {
          channel.config = config
          return { openId: 'ou_bot', name: 'UCLI' }
        },
        async disconnect() {
          channel.disconnected = true
        }
      }
      channels.push(channel)
      return channel
    }
  })

  try {
    const applied = await service.applyBindingCandidate({
      target: { type: 'group', id: 'oc_group', name: '研发群' },
      operator: { openId: 'ou_operator', name: '张三' }
    })

    assert.deepEqual(applied.target, {
      type: 'group',
      id: 'oc_group',
      name: '研发群'
    })
    assert.deepEqual(applied.operatorOpenIds, ['ou_operator'])
    assert.deepEqual(db.getGatewaySetting('gateway.config'), {
      channelType: 'feishu',
      appId: 'cli_example',
      target: { type: 'group', id: 'oc_group', name: '研发群' },
      operatorOpenIds: ['ou_operator']
    })
    assert.equal(channels[0].config.appSecret, 'top-secret')
    assert.equal(runtime.connection.fingerprint, channelFingerprint(applied))
    assert.equal(oldChannel.disconnected, true)
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearing a binding keeps credentials and reconnects in discovery mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-unbind-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const secretStore = new SecretStore({ db, safeStorage: safeStorage() })
  db.saveGatewaySetting('gateway.config', {
    channelType: 'feishu',
    appId: 'cli_example',
    target: { type: 'user', id: 'ou_operator', name: '张三' },
    operatorOpenIds: ['ou_operator']
  })
  secretStore.setSecret('gateway.feishu.appSecret', 'top-secret')
  const oldChannel = { disconnect: async () => { oldChannel.disconnected = true } }
  const runtime = {
    channel: oldChannel,
    getChannel() { return this.channel },
    getConnection: () => null,
    async setChannel(channel, connection) {
      this.channel = channel
      this.connection = connection
    }
  }
  const service = new GatewayConfigService({
    db,
    secretStore,
    runtime,
    shouldActivate: () => true,
    createChannel: () => ({
      async connect(config) {
        this.config = config
        return { openId: 'ou_bot', name: 'UCLI' }
      },
      async disconnect() {}
    })
  })

  try {
    const applied = await service.clearBinding()
    assert.deepEqual(applied, {
      channelType: 'feishu',
      appId: 'cli_example',
      target: null,
      operatorOpenIds: [],
      hasAppSecret: true
    })
    assert.equal(runtime.connection.config.target, null)
    assert.equal(oldChannel.disconnected, true)
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
