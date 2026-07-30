import { createHash, randomUUID } from 'node:crypto'

const APP_SECRET_KEY = 'gateway.feishu.appSecret'
const APPLIED_CONFIG_KEY = 'gateway.config'

function configError(message) {
  return Object.assign(new TypeError(message), {
    code: 'INVALID_GATEWAY_CONFIG'
  })
}

function requiredPrefix(value, prefix, field) {
  if (typeof value !== 'string' || !value.trim().startsWith(prefix)) {
    throw configError(`${field} must start with ${prefix}`)
  }
  return value.trim()
}

export function normalizeGatewayConfig(input) {
  if (!input || typeof input !== 'object' || input.channelType !== 'feishu') {
    throw configError('channelType must be feishu')
  }
  const appId = requiredPrefix(input.appId, 'cli_', 'appId')
  const targetType = input.target?.type
  if (targetType !== 'user' && targetType !== 'group') {
    throw configError('target.type must be user or group')
  }
  const targetId = requiredPrefix(
    input.target?.id,
    targetType === 'user' ? 'ou_' : 'oc_',
    'target.id'
  )
  if (!Array.isArray(input.operatorOpenIds)) {
    throw configError('operatorOpenIds are required')
  }
  const operatorOpenIds = [...new Set(input.operatorOpenIds.map((value) =>
    requiredPrefix(value, 'ou_', 'operatorOpenIds')
  ))]
  if (!operatorOpenIds.length) {
    throw configError('operatorOpenIds must contain at least one operator')
  }
  return {
    channelType: 'feishu',
    appId,
    target: { type: targetType, id: targetId },
    operatorOpenIds
  }
}

export function channelFingerprint(config) {
  const normalized = normalizeGatewayConfig(config)
  const identity = {
    channelType: normalized.channelType,
    appId: normalized.appId,
    target: {
      type: normalized.target.type,
      id: normalized.target.id
    }
  }
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
}

export function redactGatewayConfig(config, hasAppSecret = false) {
  if (!config) return null
  return {
    ...normalizeGatewayConfig(config),
    hasAppSecret: Boolean(hasAppSecret)
  }
}

function hashSecret(secretBuffer) {
  return createHash('sha256').update(secretBuffer).digest('hex')
}

function bindingHash(config, secretHash) {
  return createHash('sha256')
    .update(JSON.stringify(config))
    .update('\0')
    .update(secretHash)
    .digest('hex')
}

function connectionConfig(config, secretBuffer) {
  return {
    ...config,
    target: { ...config.target },
    operatorOpenIds: [...config.operatorOpenIds],
    appSecret: secretBuffer.toString('utf8')
  }
}

function safeBotIdentity(value) {
  if (!value || typeof value !== 'object') return null
  return {
    openId: typeof value.openId === 'string' ? value.openId : null,
    name: typeof value.name === 'string' ? value.name : null
  }
}

async function disconnect(channel) {
  try {
    await channel?.disconnect?.()
  } catch {
    // A candidate or replaced channel is already detached from the runtime.
  }
}

export class GatewayConfigService {
  constructor({ db, secretStore, createChannel, runtime }) {
    this.db = db
    this.secretStore = secretStore
    this.createChannel = createChannel
    this.runtime = runtime
    this._testedDrafts = new Map()
  }

  getAppliedConfig() {
    const config = this.db.getGatewaySetting(APPLIED_CONFIG_KEY)
    return config
      ? redactGatewayConfig(config, this.secretStore.hasSecret(APP_SECRET_KEY))
      : null
  }

  invalidateTests() {
    for (const entry of this._testedDrafts.values()) {
      entry.secretBuffer.fill(0)
    }
    this._testedDrafts.clear()
  }

  async testDraft({ config, appSecret }) {
    this.invalidateTests()
    const normalized = normalizeGatewayConfig(config)
    const secret = typeof appSecret === 'string' && appSecret.length
      ? appSecret
      : this.secretStore.getSecret(APP_SECRET_KEY)
    if (!secret) {
      throw Object.assign(new Error('App Secret is required'), {
        code: 'GATEWAY_SECRET_REQUIRED'
      })
    }
    const secretBuffer = Buffer.from(secret, 'utf8')
    const secretHash = hashSecret(secretBuffer)
    const candidate = this.createChannel()
    let botIdentity
    try {
      botIdentity = await candidate.connect(connectionConfig(normalized, secretBuffer))
    } catch (error) {
      secretBuffer.fill(0)
      await disconnect(candidate)
      throw error
    }
    await disconnect(candidate)

    const testId = randomUUID()
    this._testedDrafts.set(testId, {
      config: normalized,
      fingerprint: channelFingerprint(normalized),
      secretBuffer,
      secretHash,
      bindingHash: bindingHash(normalized, secretHash)
    })
    return {
      testId,
      fingerprint: channelFingerprint(normalized),
      botIdentity: safeBotIdentity(botIdentity)
    }
  }

  async applyTestedDraft({ testId }) {
    const entry = this._testedDrafts.get(testId)
    if (!entry) return { applied: false, reason: 'test_expired' }
    this._testedDrafts.delete(testId)

    const currentBinding = bindingHash(entry.config, hashSecret(entry.secretBuffer))
    if (currentBinding !== entry.bindingHash) {
      entry.secretBuffer.fill(0)
      return { applied: false, reason: 'test_expired' }
    }

    const candidate = this.createChannel()
    const oldChannel = this.runtime.getChannel()
    let swapped = false
    try {
      await candidate.connect(connectionConfig(entry.config, entry.secretBuffer))
      const ciphertext = this.secretStore.encryptSecret(entry.secretBuffer)
      await this.db.transaction(async () => {
        this.db.saveGatewaySecretCiphertext(APP_SECRET_KEY, ciphertext)
        this.db.saveGatewaySetting(APPLIED_CONFIG_KEY, entry.config)
        swapped = true
        this.runtime.setChannel(candidate)
      })
      if (oldChannel && oldChannel !== candidate) await disconnect(oldChannel)
      return redactGatewayConfig(entry.config, true)
    } catch (error) {
      if (swapped) {
        try { this.runtime.setChannel(oldChannel) } catch { /* retain original error */ }
      }
      await disconnect(candidate)
      throw error
    } finally {
      entry.secretBuffer.fill(0)
    }
  }

  async dispose() {
    this.invalidateTests()
  }
}
