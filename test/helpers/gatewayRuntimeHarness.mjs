import {
  buildDecisionCard,
  buildInterruptCard,
  buildNoticeCard,
  buildPlanDetailCard,
  buildQueueCard
} from '../../electron/gateway/channels/feishuCards.js'

export class MemoryRouteStore {
  constructor() {
    this.routes = []
    this.messageRoutes = []
    this.audits = []
  }

  listSessionRoutes() {
    return this.routes.map((route) => ({ ...route }))
  }

  upsertSessionRoute(value) {
    const index = this.routes.findIndex((route) => route.sessionId === value.sessionId)
    const route = {
      ...(index >= 0 ? this.routes[index] : {
        relayEnabled: false,
        channelFingerprint: null,
        targetId: null,
        rootMessageId: null,
        rootThreadId: null,
        routeStatus: 'waiting'
      }),
      ...value,
      updatedAt: Date.now()
    }
    if (index >= 0) this.routes[index] = route
    else this.routes.push(route)
    return { ...route }
  }

  setRelayEnabled(sessionId, enabled) {
    return this.upsertSessionRoute({ sessionId, relayEnabled: enabled })
  }

  saveMessageRoute(route) {
    const index = this.messageRoutes.findIndex((item) => item.messageId === route.messageId)
    const value = { active: true, createdAt: Date.now(), ...route }
    if (index >= 0) this.messageRoutes[index] = value
    else this.messageRoutes.push(value)
  }

  resolveMessageRoute(messageId, fingerprint) {
    const value = this.messageRoutes.find((route) =>
      route.messageId === messageId &&
      route.channelFingerprint === fingerprint &&
      route.active
    )
    return value ? { ...value } : null
  }

  deactivateSession(sessionId) {
    const route = this.routes.find((item) => item.sessionId === sessionId)
    if (route) {
      Object.assign(route, {
        relayEnabled: false,
        routeStatus: 'inactive',
        rootMessageId: null,
        rootThreadId: null
      })
    }
    for (const value of this.messageRoutes) {
      if (value.sessionId === sessionId) value.active = false
    }
  }

  deactivateFingerprint(fingerprint) {
    for (const route of this.routes) {
      if (route.channelFingerprint === fingerprint) {
        Object.assign(route, {
          routeStatus: 'inactive',
          rootMessageId: null,
          rootThreadId: null
        })
      }
    }
    for (const value of this.messageRoutes) {
      if (value.channelFingerprint === fingerprint) value.active = false
    }
  }

  saveDecisionAudit(record) {
    this.audits.push({ ...record })
  }
}

export class FakeGatewayChannel {
  constructor() {
    this.rootCounter = 0
    this.roots = []
    this.threadStarters = []
    this.rootUpdates = []
    this.decisions = []
    this.plans = []
    this.completions = []
    this.notices = []
    this.cards = []
    this.cardUpdates = []
    this.reactions = []
    this.removedReactions = []
    this.messageListeners = new Set()
    this.actionListeners = new Set()
    this.statusListeners = new Set()
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

  async sendSessionRoot(view) {
    const messageId = `root-${++this.rootCounter}`
    this.roots.push({ messageId, view: structuredClone(view) })
    return { messageId, threadId: `thread-${this.rootCounter}` }
  }

  async updateSessionRoot(route, view) {
    if (this.updateError) throw Object.assign(new Error(this.updateError), {
      code: this.updateError
    })
    this.rootUpdates.push({ route: { ...route }, view: structuredClone(view) })
  }

  async sendSessionThreadStarter(route) {
    const messageId = `thread-starter-${this.threadStarters.length + 1}`
    this.threadStarters.push({ messageId, route: { ...route } })
    return { messageId }
  }

  async sendDecision(route, view) {
    const messageId = `decision-message-${this.decisions.length + 1}`
    this.decisions.push({ messageId, route: { ...route }, view: structuredClone(view) })
    return { messageId }
  }

  async sendPlanReview(route, view) {
    const messageId = `plan-message-${this.plans.length + 1}`
    this.plans.push({ messageId, route: { ...route }, view: structuredClone(view) })
    return { messageId }
  }

  async sendCompletion(route, view) {
    const messageId = `completion-message-${this.completions.length + 1}`
    this.completions.push({ messageId, route: { ...route }, view: structuredClone(view) })
    return { messageId }
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
    this.notices.push({
      messageId,
      view: structuredClone(view)
    })
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

  async sendCard(card, options = {}) {
    const messageId = `card-${this.cards.length + 1}`
    this.cards.push({ messageId, card: structuredClone(card), options: { ...options } })
    return { messageId }
  }

  async updateCard(messageId, card) {
    this.cardUpdates.push({ messageId, card: structuredClone(card) })
  }

  async addReaction(messageId, emojiType) {
    const reactionId = `reaction-${this.reactions.length + 1}`
    this.reactions.push({ messageId, emojiType, reactionId })
    return reactionId
  }

  async removeReaction(messageId, emojiType) {
    this.removedReactions.push({ messageId, emojiType })
    return true
  }

  async disconnect() {
    this.disconnectCount = (this.disconnectCount || 0) + 1
  }

  async emitMessage(message) {
    return Promise.all([...this.messageListeners].map((listener) => listener(message)))
  }

  async emitAction(action) {
    return Promise.all([...this.actionListeners].map((listener) => listener(action)))
  }

  async emitStatus(status) {
    return Promise.all([...this.statusListeners].map((listener) => listener(status)))
  }
}

export function createPort(sessions = []) {
  const values = new Map(sessions.map((session) => [session.id, { ...session }]))
  const gatewayListeners = new Set()
  const calls = {
    turns: [],
    interrupts: [],
    decisions: []
  }
  return {
    calls,
    sessions: values,
    listSessions: () => [...values.values()].map((value) => ({ ...value })),
    getSession: (sessionId) => {
      const value = values.get(sessionId)
      return value ? { ...value } : null
    },
    async sendTurn(sessionId, text) {
      calls.turns.push({ sessionId, text })
      return true
    },
    async interrupt(sessionId) {
      calls.interrupts.push(sessionId)
      return true
    },
    async respondDecision(sessionId, decisionId, response) {
      calls.decisions.push({ sessionId, decisionId, response })
      return { accepted: true }
    },
    getDecisionContext: () => null,
    async getLatestPlanSnapshot(sessionId, decisionId) {
      return {
        kind: 'plan_review',
        title: 'Gateway plan',
        markdown: '# Gateway plan\n\n## Goal\nConnect Feishu.\n\n## Steps\n1. Route.',
        provider: 'codex',
        nativeSessionId: 'native-secret',
        decisionId,
        capturedAt: 1
      }
    },
    async getLatestResultSnapshot(sessionId, turnId) {
      return {
        kind: 'result',
        title: 'Gateway result',
        markdown: 'Gateway completed.\n\nAll tests passed.',
        provider: 'codex',
        nativeSessionId: 'native-secret',
        turnId,
        capturedAt: 2
      }
    },
    subscribeGatewayEvents(listener) {
      gatewayListeners.add(listener)
      return () => gatewayListeners.delete(listener)
    },
    emitGatewayEvent(event) {
      return Promise.all([...gatewayListeners].map((listener) => listener(event)))
    }
  }
}

export function session(id, overrides = {}) {
  return {
    id,
    name: `Session ${id}`,
    adapterId: 'codex',
    provider: 'openai',
    status: 'idle',
    ...overrides
  }
}

export const FEISHU_CONFIG = {
  channelType: 'feishu',
  appId: 'cli_example',
  target: { type: 'group', id: 'oc_group' },
  operatorOpenIds: ['ou_operator']
}
