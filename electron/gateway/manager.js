import { channelFingerprint, GatewayConfigService } from './config.js'
import { FeishuChannel } from './channels/feishuChannel.js'
import { GatewayRouteStore } from './routeStore.js'
import { GatewayRuntime } from './runtime.js'
import { SecretStore } from './secretStore.js'

const DESIRED_ENABLED_KEY = 'gateway.desiredEnabled'
const APPLIED_CONFIG_KEY = 'gateway.config'
const APP_SECRET_KEY = 'gateway.feishu.appSecret'

function configRequired() {
  return Object.assign(new Error('Gateway configuration is required'), {
    code: 'CONFIG_REQUIRED'
  })
}

export class GatewayManager {
  constructor({
    db,
    safeStorage,
    port,
    publishState = () => {},
    createChannel = () => new FeishuChannel(),
    routeStore = new GatewayRouteStore(db),
    secretStore = new SecretStore({ db, safeStorage }),
    runtime = null,
    configService = null
  }) {
    this.db = db
    this.port = port
    this.createChannel = createChannel
    this.routeStore = routeStore
    this.secretStore = secretStore
    this.runtime = runtime || new GatewayRuntime({
      port,
      routeStore,
      publishState,
      saveDesiredEnabled: (value) => {
        this.db.saveGatewaySetting(DESIRED_ENABLED_KEY, Boolean(value))
        this.db.flush?.()
      }
    })
    this.configService = configService || new GatewayConfigService({
      db,
      secretStore,
      createChannel,
      runtime: this.runtime,
      shouldActivate: () => this.runtime.getState().desiredEnabled
    })
    this.unsubscribeEvents = null
    this.started = false
  }

  getState() {
    return this.runtime.getState()
  }

  getConfiguration() {
    return this.configService.getAppliedConfig()
  }

  async start() {
    if (this.started) return this.getState()
    this.started = true
    this.unsubscribeEvents = this.port.subscribeGatewayEvents((event) => {
      Promise.resolve(this.runtime.handleGatewayEvent(event)).catch(() => {})
    })
    const config = this.db.getGatewaySetting(APPLIED_CONFIG_KEY)
    const desired = this.db.getGatewaySetting(DESIRED_ENABLED_KEY) === true
    this.runtime.restoreDesiredEnabled(desired, config)
    if (desired) await this._connectApplied(config, false)
    return this.getState()
  }

  async setDesiredEnabled(enabled) {
    if (!enabled) {
      this.configService.invalidateTests?.()
      await this.runtime.setDesiredEnabled(false)
      return this.getState()
    }
    const config = this.db.getGatewaySetting(APPLIED_CONFIG_KEY)
    const secret = this.secretStore.getSecret(APP_SECRET_KEY)
    if (!config || !secret) throw configRequired()
    await this.runtime.setDesiredEnabled(true)
    await this._connectApplied(config, true, secret)
    return this.getState()
  }

  async testDraft(draft) {
    return this.configService.testDraft(draft)
  }

  async applyDraft(testId) {
    return this.configService.applyTestedDraft({ testId })
  }

  listSessions() {
    const routes = new Map(
      this.routeStore.listSessionRoutes().map((route) => [route.sessionId, route])
    )
    return this.port.listSessions().map((session) => {
      const route = routes.get(session.id)
      const relay = this.runtime.getSessionRelayState(session.id)
      return {
        id: session.id,
        name: session.name || null,
        adapterId: session.adapterId,
        provider: session.provider || null,
        status: session.status,
        relayEnabled: Boolean(route?.relayEnabled),
        routeStatus: route?.routeStatus || 'waiting',
        queueCount: relay.queueCount
      }
    })
  }

  async setSessionRelayEnabled(sessionId, enabled) {
    if (!this.port.getSession(sessionId)) {
      return { accepted: false, reason: 'session_not_found' }
    }
    return this.runtime.setSessionRelayEnabled(sessionId, enabled)
  }

  async resyncSession(sessionId) {
    if (!this.port.getSession(sessionId)) {
      return { accepted: false, reason: 'session_not_found' }
    }
    await this.runtime.resyncSession(sessionId)
    return { accepted: true }
  }

  async respondDesktopDecision(sessionId, decisionId, response) {
    return this.runtime.respondDesktopDecision(sessionId, decisionId, response)
  }

  async shutdown() {
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    await this.runtime.shutdown()
    await this.configService.dispose()
    this.started = false
  }

  async _connectApplied(config, rethrow, existingSecret = null) {
    let channel = null
    try {
      const secret = existingSecret || this.secretStore.getSecret(APP_SECRET_KEY)
      if (!config || !secret) throw configRequired()
      this.runtime.markConnecting(config)
      channel = this.createChannel()
      const botIdentity = await channel.connect({
        ...config,
        target: { ...config.target },
        operatorOpenIds: [...config.operatorOpenIds],
        appSecret: secret
      })
      await this.runtime.attachConnectedChannel({
        channel,
        config,
        fingerprint: channelFingerprint(config),
        botIdentity
      })
      return true
    } catch (error) {
      await channel?.disconnect?.()
      this.runtime.reportConnectionError(error)
      if (rethrow) {
        const state = this.runtime.getState()
        throw Object.assign(new Error(state.errorMessage), {
          code: state.errorCode
        })
      }
      return false
    }
  }
}

export {
  APP_SECRET_KEY,
  APPLIED_CONFIG_KEY,
  DESIRED_ENABLED_KEY
}
