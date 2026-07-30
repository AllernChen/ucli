import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  channelFingerprint,
  GatewayConfigService,
  normalizeGatewayConfig,
  redactGatewayConfig
} from '../electron/gateway/config.js'
import { SecretStore } from '../electron/gateway/secretStore.js'
import { openDb } from '../electron/persistence/db.js'

const CONFIG = {
  channelType: 'feishu',
  appId: 'cli_example',
  target: { type: 'user', id: 'ou_target', ignored: true },
  operatorOpenIds: ['ou_operator', 'ou_operator'],
  ignored: true
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`cipher:${value}`),
    decryptString: (value) => value.toString().replace(/^cipher:/, '')
  }
}

function channelFactory(channels, { failApply = false } = {}) {
  return () => {
    const channel = {
      disconnected: false,
      async connect(config) {
        channel.config = config
        if (failApply && channels.length === 2) throw new Error('candidate failed')
        return { openId: 'ou_bot', name: 'UCLI Bot' }
      },
      async disconnect() {
        channel.disconnected = true
      }
    }
    channels.push(channel)
    return channel
  }
}

test('Gateway config normalization is strict and fingerprints only channel identity', () => {
  const normalized = normalizeGatewayConfig(CONFIG)
  assert.deepEqual(normalized, {
    channelType: 'feishu',
    appId: 'cli_example',
    target: { type: 'user', id: 'ou_target' },
    operatorOpenIds: ['ou_operator']
  })
  assert.deepEqual(redactGatewayConfig(normalized, true), {
    ...normalized,
    hasAppSecret: true
  })
  assert.equal(
    channelFingerprint(normalized),
    channelFingerprint({ ...normalized, operatorOpenIds: ['ou_someone_else'] })
  )
  assert.notEqual(
    channelFingerprint(normalized),
    channelFingerprint({
      ...normalized,
      target: { type: 'group', id: 'oc_group' }
    })
  )
  assert.equal(
    normalizeGatewayConfig({
      ...CONFIG,
      target: {
        type: 'group',
        id: 'oc_group',
        name: '\u0000研发\n群\u007F'
      }
    }).target.name,
    '研发群'
  )
  assert.throws(() => normalizeGatewayConfig({ ...CONFIG, appId: 'bad' }), {
    code: 'INVALID_GATEWAY_CONFIG'
  })
  assert.throws(() => normalizeGatewayConfig({
    ...CONFIG,
    target: { type: 'group', id: 'ou_wrong' }
  }), { code: 'INVALID_GATEWAY_CONFIG' })
  assert.throws(() => normalizeGatewayConfig({ ...CONFIG, operatorOpenIds: [] }), {
    code: 'INVALID_GATEWAY_CONFIG'
  })
})

test('tested drafts are single-use and apply config plus encrypted secret atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-config-apply-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const channels = []
  const runtime = {
    channel: { id: 'old', disconnect: async () => { runtime.oldDisconnected = true } },
    getChannel() { return this.channel },
    setChannel(channel) { this.channel = channel }
  }
  const service = new GatewayConfigService({
    db,
    secretStore: new SecretStore({ db, safeStorage: fakeSafeStorage() }),
    createChannel: channelFactory(channels),
    runtime
  })

  try {
    const tested = await service.testDraft({ config: CONFIG, appSecret: 'top-secret' })
    assert.equal(tested.fingerprint, channelFingerprint(CONFIG))
    assert.deepEqual(tested.botIdentity, { openId: 'ou_bot', name: 'UCLI Bot' })
    assert.equal(channels[0].disconnected, true)

    const applied = await service.applyTestedDraft({ testId: tested.testId })
    assert.equal(applied.hasAppSecret, true)
    assert.deepEqual(db.getGatewaySetting('gateway.config'), normalizeGatewayConfig(CONFIG))
    assert.notEqual(db.getGatewaySecretCiphertext('gateway.feishu.appSecret'), 'top-secret')
    assert.equal(runtime.channel, channels[1])
    assert.equal(runtime.oldDisconnected, true)
    assert.deepEqual(
      await service.applyTestedDraft({ testId: tested.testId }),
      { applied: false, reason: 'test_expired' }
    )
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed fresh candidate leaves old persisted config, secret, and runtime intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-config-rollback-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const secretStore = new SecretStore({ db, safeStorage: fakeSafeStorage() })
  const oldConfig = normalizeGatewayConfig({
    ...CONFIG,
    appId: 'cli_old',
    target: { type: 'user', id: 'ou_old' }
  })
  db.saveGatewaySetting('gateway.config', oldConfig)
  secretStore.setSecret('gateway.feishu.appSecret', 'old-secret')
  const oldCiphertext = db.getGatewaySecretCiphertext('gateway.feishu.appSecret')
  const oldChannel = { disconnect: async () => { oldChannel.disconnected = true } }
  const runtime = {
    channel: oldChannel,
    getChannel() { return this.channel },
    setChannel(channel) { this.channel = channel }
  }
  const channels = []
  const service = new GatewayConfigService({
    db,
    secretStore,
    createChannel: channelFactory(channels, { failApply: true }),
    runtime
  })

  try {
    const tested = await service.testDraft({ config: CONFIG, appSecret: 'new-secret' })
    await assert.rejects(
      service.applyTestedDraft({ testId: tested.testId }),
      /candidate failed/
    )
    assert.deepEqual(db.getGatewaySetting('gateway.config'), oldConfig)
    assert.equal(db.getGatewaySecretCiphertext('gateway.feishu.appSecret'), oldCiphertext)
    assert.equal(runtime.channel, oldChannel)
    assert.notEqual(oldChannel.disconnected, true)
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new test and disable invalidate prior tested drafts', async () => {
  const channels = []
  const db = {
    getGatewaySecretCiphertext: () => null,
    saveGatewaySecretCiphertext: () => {},
    getGatewaySetting: () => null,
    saveGatewaySetting: () => {},
    async transaction(work) { return work() }
  }
  const service = new GatewayConfigService({
    db,
    secretStore: new SecretStore({ db, safeStorage: fakeSafeStorage() }),
    createChannel: channelFactory(channels),
    runtime: { getChannel: () => null, setChannel: () => {} }
  })

  const first = await service.testDraft({ config: CONFIG, appSecret: 'one' })
  await service.testDraft({ config: CONFIG, appSecret: 'two' })
  assert.deepEqual(
    await service.applyTestedDraft({ testId: first.testId }),
    { applied: false, reason: 'test_expired' }
  )
  const third = await service.testDraft({ config: CONFIG, appSecret: 'three' })
  service.invalidateTests()
  assert.deepEqual(
    await service.applyTestedDraft({ testId: third.testId }),
    { applied: false, reason: 'test_expired' }
  )
  await service.dispose()
})

test('a runtime swap failure rolls back staged config and restores the old channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-config-swap-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const secretStore = new SecretStore({ db, safeStorage: fakeSafeStorage() })
  const oldConfig = normalizeGatewayConfig({
    ...CONFIG,
    appId: 'cli_old',
    target: { type: 'user', id: 'ou_old' }
  })
  db.saveGatewaySetting('gateway.config', oldConfig)
  secretStore.setSecret('gateway.feishu.appSecret', 'old-secret')
  const oldCiphertext = db.getGatewaySecretCiphertext('gateway.feishu.appSecret')
  const oldChannel = { disconnect: async () => {} }
  const runtime = {
    channel: oldChannel,
    getChannel() { return this.channel },
    setChannel(channel) {
      this.channel = channel
      if (channel !== oldChannel) throw new Error('swap failed')
    }
  }
  const channels = []
  const service = new GatewayConfigService({
    db,
    secretStore,
    createChannel: channelFactory(channels),
    runtime
  })

  try {
    const tested = await service.testDraft({ config: CONFIG, appSecret: 'new-secret' })
    await assert.rejects(
      service.applyTestedDraft({ testId: tested.testId }),
      /swap failed/
    )
    assert.deepEqual(db.getGatewaySetting('gateway.config'), oldConfig)
    assert.equal(db.getGatewaySecretCiphertext('gateway.feishu.appSecret'), oldCiphertext)
    assert.equal(runtime.channel, oldChannel)
    assert.equal(channels[1].disconnected, true)
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed runtime restore disconnects both channels and reports an explicit rollback error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-config-restore-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const secretStore = new SecretStore({ db, safeStorage: fakeSafeStorage() })
  const oldConfig = normalizeGatewayConfig({
    ...CONFIG,
    appId: 'cli_old',
    target: { type: 'user', id: 'ou_old' }
  })
  db.saveGatewaySetting('gateway.config', oldConfig)
  secretStore.setSecret('gateway.feishu.appSecret', 'old-secret')
  const oldChannel = {
    async disconnect() { this.disconnected = true }
  }
  const runtime = {
    channel: oldChannel,
    attempts: 0,
    getChannel() { return this.channel },
    getConnection: () => ({
      config: oldConfig,
      fingerprint: channelFingerprint(oldConfig)
    }),
    async setChannel(channel) {
      this.attempts += 1
      if (this.attempts <= 2) throw new Error('runtime install failed')
      this.channel = channel
    },
    reportConnectionError(error) {
      this.reportedError = error
    }
  }
  const channels = []
  const service = new GatewayConfigService({
    db,
    secretStore,
    createChannel: channelFactory(channels),
    runtime
  })

  try {
    const tested = await service.testDraft({ config: CONFIG, appSecret: 'new-secret' })
    await assert.rejects(
      service.applyTestedDraft({ testId: tested.testId }),
      { code: 'GATEWAY_ROLLBACK_FAILED' }
    )
    assert.equal(runtime.channel, null)
    assert.equal(runtime.reportedError.code, 'GATEWAY_ROLLBACK_FAILED')
    assert.equal(oldChannel.disconnected, true)
    assert.equal(channels[1].disconnected, true)
    assert.deepEqual(db.getGatewaySetting('gateway.config'), oldConfig)
  } finally {
    await service.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
