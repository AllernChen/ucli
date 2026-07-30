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

function optionalLabel(value) {
  if (typeof value !== 'string') return ''
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .normalize('NFC')
    .trim()
  return Array.from(normalized).slice(0, 100).join('')
}

export function normalizeGatewayConfig(input) {
  if (!input || typeof input !== 'object' || input.channelType !== 'feishu') {
    throw configError('channelType must be feishu')
  }
  const appId = requiredPrefix(input.appId, 'cli_', 'appId')
  let target = null
  if (input.target != null) {
    const targetType = input.target?.type
    if (targetType !== 'user' && targetType !== 'group') {
      throw configError('target.type must be user or group')
    }
    const targetId = requiredPrefix(
      input.target?.id,
      targetType === 'user' ? 'ou_' : 'oc_',
      'target.id'
    )
    target = {
      type: targetType,
      id: targetId
    }
    const name = optionalLabel(input.target?.name)
    if (name) target.name = name
  }
  if (!Array.isArray(input.operatorOpenIds)) {
    throw configError('operatorOpenIds are required')
  }
  const operatorOpenIds = [...new Set(input.operatorOpenIds.map((value) =>
    requiredPrefix(value, 'ou_', 'operatorOpenIds')
  ))]
  if (target && !operatorOpenIds.length) {
    throw configError('operatorOpenIds must contain at least one operator')
  }
  return {
    channelType: 'feishu',
    appId,
    target,
    operatorOpenIds
  }
}

export function channelFingerprint(config) {
  const normalized = normalizeGatewayConfig(config)
  const identity = {
    channelType: normalized.channelType,
    appId: normalized.appId,
    target: normalized.target
      ? {
          type: normalized.target.type,
          id: normalized.target.id
        }
      : null
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
    target: config.target ? { ...config.target } : null,
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
  constructor({
    db,
    secretStore,
    createChannel,
    runtime,
    shouldActivate = () => true
  }) {
    this.db = db
    this.secretStore = secretStore
    this.createChannel = createChannel
    this.runtime = runtime
    this.shouldActivate = shouldActivate
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
    const oldConnection = this.runtime.getConnection?.() || null
    let activationAttempted = false
    try {
      const botIdentity = safeBotIdentity(
        await candidate.connect(connectionConfig(entry.config, entry.secretBuffer))
      )
      const ciphertext = this.secretStore.encryptSecret(entry.secretBuffer)
      await this.db.transaction(async () => {
        this.db.saveGatewaySecretCiphertext(APP_SECRET_KEY, ciphertext)
        this.db.saveGatewaySetting(APPLIED_CONFIG_KEY, entry.config)
        if (this.shouldActivate()) {
          activationAttempted = true
          await this.runtime.setChannel(candidate, {
            config: entry.config,
            fingerprint: entry.fingerprint,
            botIdentity
          })
        } else {
          await disconnect(candidate)
        }
      })
      if (
        activationAttempted &&
        oldChannel &&
        oldChannel !== candidate
      ) {
        await disconnect(oldChannel)
      }
      return redactGatewayConfig(entry.config, true)
    } catch (error) {
      let failure = error
      if (activationAttempted) {
        failure = await this._restoreRuntimeOrFail({
          oldChannel,
          oldConnection,
          originalError: error
        })
      }
      await disconnect(candidate)
      throw failure
    } finally {
      entry.secretBuffer.fill(0)
    }
  }

  async applyBindingCandidate(candidate) {
    const current = this.db.getGatewaySetting(APPLIED_CONFIG_KEY)
    if (!current) {
      throw Object.assign(new Error('Gateway configuration is required'), {
        code: 'CONFIG_REQUIRED'
      })
    }
    const normalizedCurrent = normalizeGatewayConfig(current)
    const target = candidate?.target
    const operatorOpenId = candidate?.operator?.openId
    const next = normalizeGatewayConfig({
      ...normalizedCurrent,
      target: target
        ? {
            type: target.type,
            id: target.id,
            name: target.name
          }
        : null,
      operatorOpenIds: [
        ...normalizedCurrent.operatorOpenIds,
        operatorOpenId
      ].filter(Boolean)
    })
    return this._replaceAppliedConfig(next)
  }

  async clearBinding() {
    const current = this.db.getGatewaySetting(APPLIED_CONFIG_KEY)
    if (!current) {
      throw Object.assign(new Error('Gateway configuration is required'), {
        code: 'CONFIG_REQUIRED'
      })
    }
    const normalizedCurrent = normalizeGatewayConfig(current)
    return this._replaceAppliedConfig(normalizeGatewayConfig({
      ...normalizedCurrent,
      target: null,
      operatorOpenIds: []
    }))
  }

  async _replaceAppliedConfig(config) {
    const secret = this.secretStore.getSecret(APP_SECRET_KEY)
    if (!secret) {
      throw Object.assign(new Error('App Secret is required'), {
        code: 'GATEWAY_SECRET_REQUIRED'
      })
    }
    const normalized = normalizeGatewayConfig(config)
    const secretBuffer = Buffer.from(secret, 'utf8')
    const candidate = this.createChannel()
    const oldChannel = this.runtime.getChannel()
    const oldConnection = this.runtime.getConnection?.() || null
    let activationAttempted = false
    try {
      const botIdentity = safeBotIdentity(
        await candidate.connect(connectionConfig(normalized, secretBuffer))
      )
      await this.db.transaction(async () => {
        this.db.saveGatewaySetting(APPLIED_CONFIG_KEY, normalized)
        if (this.shouldActivate()) {
          activationAttempted = true
          await this.runtime.setChannel(candidate, {
            config: normalized,
            fingerprint: channelFingerprint(normalized),
            botIdentity
          })
        } else {
          await disconnect(candidate)
        }
      })
      if (activationAttempted && oldChannel && oldChannel !== candidate) {
        await disconnect(oldChannel)
      }
      return redactGatewayConfig(normalized, true)
    } catch (error) {
      let failure = error
      if (activationAttempted) {
        failure = await this._restoreRuntimeOrFail({
          oldChannel,
          oldConnection,
          originalError: error
        })
      }
      await disconnect(candidate)
      throw failure
    } finally {
      secretBuffer.fill(0)
    }
  }

  async dispose() {
    this.invalidateTests()
  }

  async _restoreRuntimeOrFail({
    oldChannel,
    oldConnection,
    originalError
  }) {
    try {
      await this.runtime.setChannel(oldChannel, oldConnection)
      return originalError
    } catch (restoreError) {
      const failure = Object.assign(
        new Error(
          'Gateway configuration failed and the previous connection could not be restored'
        ),
        {
          code: 'GATEWAY_ROLLBACK_FAILED',
          cause: originalError
        }
      )
      try {
        await this.runtime.setChannel(null, null)
      } catch {
        // Continue cleanup even if the runtime cannot detach cleanly.
      }
      await disconnect(oldChannel)
      try {
        this.runtime.reportConnectionError?.(failure)
      } catch {
        // The stable rollback error is still returned to the caller.
      }
      return failure
    }
  }
}
