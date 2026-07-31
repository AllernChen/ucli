import { createRequire } from 'node:module'

import {
  buildCompletionCard,
  buildDecisionCard,
  buildInterruptCard,
  buildNoticeCard,
  buildPlanDetailCard,
  buildPlanOverviewCard,
  buildQueueCard,
  buildRootCard
} from './feishuCards.js'

const ERROR_CODES = new Set([
  'permission_denied',
  'target_revoked',
  'rate_limited',
  'send_timeout',
  'not_connected'
])

const require = createRequire(import.meta.url)

function createOfficialLarkChannel(options) {
  return require('@larksuiteoapi/node-sdk').createLarkChannel(options)
}

function scheduleMicrotask(work) {
  queueMicrotask(work)
}

function normalizedError(error, fallback = 'unknown') {
  let code = ERROR_CODES.has(error?.code) ? error.code : fallback
  const status = error?.response?.status || error?.status
  if (status === 403) code = 'permission_denied'
  if (status === 404 || status === 410) code = 'target_revoked'
  if (status === 429) code = 'rate_limited'
  if (error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') {
    code = 'send_timeout'
  }
  return Object.assign(new Error(`Feishu Gateway operation failed: ${code}`), {
    code,
    cause: error
  })
}

function normalizeMessage(message) {
  const supported = message?.rawContentType === 'text'
  return {
    messageId: message?.messageId || '',
    chatId: message?.chatId || '',
    chatType: message?.chatType || 'p2p',
    senderOpenId: message?.senderId || '',
    senderName: typeof message?.senderName === 'string' ? message.senderName : '',
    text: supported && typeof message?.content === 'string' ? message.content : '',
    rawContentType: message?.rawContentType || 'unknown',
    supported,
    replyToMessageId: message?.replyToMessageId || null,
    rootId: message?.rootId || null,
    threadId: message?.threadId || null
  }
}

function normalizeAction(event) {
  const value = event?.action?.value
  const token = value?.integration === 'ucli-gateway' &&
    typeof value.token === 'string'
    ? value.token
    : null
  return {
    messageId: event?.messageId || '',
    chatId: event?.chatId || '',
    senderOpenId: event?.operator?.openId || '',
    token
  }
}

function safeBotIdentity(identity) {
  if (!identity) return null
  return {
    openId: typeof identity.openId === 'string' ? identity.openId : '',
    name: typeof identity.name === 'string' ? identity.name : ''
  }
}

export class FeishuChannel {
  constructor({
    createLarkChannel = createOfficialLarkChannel,
    schedule = scheduleMicrotask
  } = {}) {
    this.createLarkChannel = createLarkChannel
    this.schedule = schedule
    this.sdk = null
    this.targetId = null
    this.connected = false
    this.unsubscribeSdk = null
    this.messageListeners = new Set()
    this.actionListeners = new Set()
    this.statusListeners = new Set()
    this.reactionIds = new Map()
  }

  async connect(config) {
    if (this.connected && this.sdk) return safeBotIdentity(this.sdk.botIdentity)
    this.targetId = config.target?.id || null
    const bound = Boolean(this.targetId)
    this.sdk = this.createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: 'websocket',
      handshakeTimeoutMs: 15_000,
      policy: {
        requireMention: !bound,
        dmMode: bound ? 'allowlist' : 'open',
        dmAllowlist: [...config.operatorOpenIds],
        groupAllowlist: config.target?.type === 'group' ? [config.target.id] : [],
        respondToMentionAll: false
      },
      safety: {
        dedup: { ttl: 12 * 60 * 60 * 1000, maxEntries: 5000 },
        staleMessageWindowMs: 30 * 60 * 1000,
        chatQueue: { enabled: true }
      },
      includeRawInMessage: false,
      includeRawEvent: false,
      source: 'ucli-gateway'
    })
    this.unsubscribeSdk = this.sdk.on({
      message: (message) => {
        const normalized = normalizeMessage(message)
        this._dispatch(this.messageListeners, normalized)
      },
      cardAction: (event) => {
        this._dispatch(this.actionListeners, normalizeAction(event))
      },
      reconnecting: () => {
        this._dispatch(this.statusListeners, { type: 'reconnecting' })
      },
      reconnected: () => {
        this._dispatch(this.statusListeners, { type: 'reconnected' })
      },
      error: (error) => {
        const normalized = normalizedError(error)
        this._dispatch(this.statusListeners, {
          type: 'error',
          errorCode: normalized.code,
          errorMessage: normalized.message
        })
      }
    })
    try {
      await this.sdk.connect()
      this.connected = true
      return safeBotIdentity(this.sdk.botIdentity)
    } catch (error) {
      this.unsubscribeSdk?.()
      this.unsubscribeSdk = null
      this.sdk = null
      this.targetId = null
      throw normalizedError(error)
    }
  }

  async disconnect() {
    const sdk = this.sdk
    if (!sdk) return
    this.connected = false
    this.unsubscribeSdk?.()
    this.unsubscribeSdk = null
    this.sdk = null
    this.targetId = null
    this.reactionIds.clear()
    try {
      await sdk.disconnect()
    } catch {
      // The channel is already detached locally.
    }
  }

  onUserMessage(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onAction(listener) {
    this.actionListeners.add(listener)
    return () => this.actionListeners.delete(listener)
  }

  onStatus(listener) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  _dispatch(listeners, payload) {
    for (const listener of listeners) {
      this.schedule(() =>
        Promise.resolve()
          .then(() => listener(structuredClone(payload)))
          .catch(() => {})
      )
    }
  }

  _requireConnected({ targetRequired = true } = {}) {
    if (!this.connected || !this.sdk || (targetRequired && !this.targetId)) {
      throw normalizedError(null, 'not_connected')
    }
  }

  async resolveBindingCandidate(message) {
    this._requireConnected({ targetRequired: false })
    const group = message?.chatType === 'group'
    let targetName = group ? '' : message?.senderName || ''
    if (group && message?.chatId && this.sdk.getChatInfo) {
      try {
        const chat = await this.sdk.getChatInfo(message.chatId)
        targetName = typeof chat?.name === 'string' ? chat.name : ''
      } catch {
        // A name is helpful but the IDs from the signed inbound event are authoritative.
      }
    }
    return {
      target: {
        type: group ? 'group' : 'user',
        id: group ? message?.chatId || '' : message?.senderOpenId || '',
        name: targetName
      },
      operator: {
        openId: message?.senderOpenId || '',
        name: message?.senderName || ''
      }
    }
  }

  async sendBindingNotice(message, view) {
    this._requireConnected({ targetRequired: false })
    try {
      return await this.sdk.send(
        message.chatId,
        { card: buildNoticeCard(view) },
        {
          replyTo: message.messageId,
          replyInThread: message.chatType === 'group'
        }
      )
    } catch (error) {
      throw normalizedError(error)
    }
  }

  async sendCard(card, { replyTo } = {}) {
    this._requireConnected()
    try {
      return await this.sdk.send(
        this.targetId,
        { card },
        replyTo ? { replyTo, replyInThread: true } : undefined
      )
    } catch (error) {
      throw normalizedError(error)
    }
  }

  async updateCard(messageId, card) {
    this._requireConnected()
    try {
      await this.sdk.updateCard(messageId, card)
    } catch (error) {
      throw normalizedError(error)
    }
  }

  async sendSessionRoot(view) {
    return this.sendCard(buildRootCard(view))
  }

  async sendSessionThreadStarter(route) {
    return this.sendCard(buildNoticeCard({
      message: '会话话题已创建。请直接在此话题回复任务，UCLI 会转发到当前会话。'
    }), {
      replyTo: route.rootMessageId
    })
  }

  async updateSessionRoot(route, view) {
    await this.updateCard(route.rootMessageId, buildRootCard(view))
    return route
  }

  async sendDecision(route, view) {
    return this.sendCard(buildDecisionCard(view), {
      replyTo: route.rootMessageId
    })
  }

  async sendPlanReview(route, view) {
    return this.sendCard(buildPlanOverviewCard(view), {
      replyTo: route.rootMessageId
    })
  }

  async sendCompletion(route, view) {
    return this.sendCard(buildCompletionCard(view), {
      replyTo: route.rootMessageId
    })
  }

  async sendQueue(route, view) {
    return this.sendCard(buildQueueCard(view), {
      replyTo: route?.rootMessageId
    })
  }

  async sendInterrupt(route, view) {
    return this.sendCard(buildInterruptCard(view), {
      replyTo: route?.rootMessageId
    })
  }

  async sendDetail(route, view) {
    return this.sendCard(buildPlanDetailCard(view), {
      replyTo: route?.rootMessageId
    })
  }

  async sendNotice(messageId, view) {
    return this.sendCard(buildNoticeCard(view), {
      replyTo: messageId
    })
  }

  async markDecisionResolved(messageId, view) {
    return this.updateCard(messageId, buildDecisionCard({
      ...view,
      actions: []
    }))
  }

  async addReaction(messageId, emojiType) {
    if (!this.connected || !this.sdk) return null
    try {
      const reactionId = await this.sdk.addReaction(messageId, emojiType)
      this.reactionIds.set(`${messageId}:${emojiType}`, reactionId)
      return reactionId
    } catch {
      return null
    }
  }

  async removeReaction(messageId, emojiType) {
    if (!this.connected || !this.sdk) return false
    const key = `${messageId}:${emojiType}`
    const reactionId = this.reactionIds.get(key)
    if (!reactionId) return false
    try {
      await this.sdk.removeReaction(messageId, reactionId)
      this.reactionIds.delete(key)
      return true
    } catch {
      return false
    }
  }
}

export { normalizeAction as normalizeFeishuAction }
export { normalizeMessage as normalizeFeishuMessage }
