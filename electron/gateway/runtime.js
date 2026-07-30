import { randomBytes } from 'node:crypto'

import {
  buildDecisionCard,
  buildInterruptCard,
  buildPlanDetailCard,
  buildQueueCard
} from './channels/feishuCards.js'
import { DecisionRegistry } from './decisionRegistry.js'
import { prepareDecisionSummary, redactDisplayText } from './redaction.js'
import { SnapshotStore } from './snapshotStore.js'
import { GatewayTaskQueue } from './taskQueue.js'

const READY_SESSION_STATES = new Set(['idle', 'running'])
const MAX_INBOUND_CODE_POINTS = 20_000

function opaqueToken() {
  return randomBytes(32).toString('base64url')
}

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function sanitizeInboundText(value) {
  if (typeof value !== 'string') return null
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .trim()
  if (!normalized || Array.from(normalized).length > MAX_INBOUND_CODE_POINTS) {
    return null
  }
  return normalized
}

function targetIdOf(config) {
  return config?.target?.id || null
}

function publicErrorMessage(code) {
  if (!code) return ''
  const messages = {
    permission_denied: 'Gateway 权限不足，请检查飞书应用权限。',
    not_connected: 'Gateway 当前未连接。',
    target_revoked: '原会话入口已失效，正在重新创建。'
  }
  return messages[code] || 'Gateway 连接异常，请在设置中检查配置。'
}

function actionResponse(action) {
  if (action === 'execute') return { action: 'execute' }
  if (action === 'reject') return { action: 'reject' }
  if (action === 'revise') return { action: 'revise' }
  return { optionId: action }
}

export class GatewayRuntime {
  constructor({
    port,
    routeStore,
    publishState = () => {},
    saveDesiredEnabled = () => {},
    taskQueue = new GatewayTaskQueue(),
    snapshotChunkSize = 3000
  }) {
    if (!port || !routeStore) {
      throw new TypeError('Gateway port and route store are required')
    }
    this.port = port
    this.routeStore = routeStore
    this.publishState = publishState
    this.saveDesiredEnabled = saveDesiredEnabled
    this.taskQueue = taskQueue
    this.snapshotChunkSize = Math.max(1, Math.floor(snapshotChunkSize))
    this.snapshotStore = new SnapshotStore({ chunkSize: snapshotChunkSize })
    this.decisionRegistry = new DecisionRegistry({
      routeStore,
      responder: (sessionId, decisionId, response) =>
        this.port.respondDecision(sessionId, decisionId, response)
    })
    this.channel = null
    this.acceptingInbound = false
    this.config = null
    this.fingerprint = null
    this.botIdentity = null
    this.unsubscribers = []
    this.actions = new Map()
    this.pendingDecisions = new Map()
    this.decisionDetails = new Map()
    this.latestCompletions = new Map()
    this.turnTasks = new Map()
    this.state = {
      desiredEnabled: false,
      phase: 'off',
      channelType: null,
      targetLabel: '',
      errorCode: null,
      errorMessage: '',
      selectedSessionCount: 0,
      readySessionCount: 0,
      pendingDecisionCount: 0,
      queuedTaskCount: 0,
      lastConnectedAt: null
    }
  }

  getState() {
    return {
      ...this.state,
      ...this._counts()
    }
  }

  getChannel() {
    return this.channel
  }

  getConnection() {
    if (!this.channel || !this.config || !this.fingerprint) return null
    return {
      config: structuredClone(this.config),
      fingerprint: this.fingerprint,
      botIdentity: this.botIdentity ? structuredClone(this.botIdentity) : null
    }
  }

  async setChannel(channel, connection = null) {
    if (!channel) {
      this._unbindChannel()
      this.channel = null
      return
    }
    if (connection?.config && connection?.fingerprint) {
      await this.attachConnectedChannel({ channel, ...connection })
      return
    }
    this.channel = channel
  }

  restoreDesiredEnabled(value, config = null) {
    this._setState({
      desiredEnabled: Boolean(value),
      phase: value ? 'connecting' : 'off',
      channelType: config?.channelType || this.state.channelType,
      targetLabel: targetIdOf(config) || this.state.targetLabel
    })
  }

  markConnecting(config) {
    this._setState({
      desiredEnabled: true,
      phase: 'connecting',
      channelType: config?.channelType || 'feishu',
      targetLabel: targetIdOf(config) || '',
      errorCode: null,
      errorMessage: ''
    })
  }

  reportConnectionError(error) {
    const errorCode = safeText(error?.code, 'connection_error')
    this._setState({
      desiredEnabled: true,
      phase: 'error',
      errorCode,
      errorMessage: publicErrorMessage(errorCode)
    })
  }

  async attachConnectedChannel({
    channel,
    config,
    fingerprint,
    botIdentity = null
  }) {
    this._unbindChannel()
    if (this.fingerprint && this.fingerprint !== fingerprint) {
      this.routeStore.deactivateFingerprint(this.fingerprint)
    }
    this.channel = channel
    this.acceptingInbound = true
    this.config = structuredClone(config)
    this.fingerprint = fingerprint
    this.botIdentity = botIdentity ? structuredClone(botIdentity) : null
    this._bindChannel(channel)
    this._setState({
      desiredEnabled: true,
      phase: 'connected',
      channelType: config?.channelType || 'feishu',
      targetLabel: targetIdOf(config) || '',
      errorCode: null,
      errorMessage: '',
      lastConnectedAt: Date.now()
    })
    await this._syncSelectedRoots()
    this._publish()
  }

  async setDesiredEnabled(value) {
    const enabled = Boolean(value)
    await this.saveDesiredEnabled(enabled)
    if (enabled) {
      this._setState({ desiredEnabled: true })
      return
    }
    if (this.channel) {
      for (const route of this._selectedRoutes()) {
        await this._updateRoot(route.sessionId, {
          pausedByGateway: true,
          stateLabel: 'Gateway 已暂停',
          interruptToken: null
        })
      }
    }
    this.decisionRegistry.invalidateRemoteTokens('gateway_off')
    this.actions.clear()
    this.acceptingInbound = false
    if (this.channel) {
      await this.channel.disconnect()
    }
    this._unbindChannel()
    this.channel = null
    this._setState({
      desiredEnabled: false,
      phase: 'off',
      errorCode: null,
      errorMessage: ''
    })
  }

  async resyncSession(sessionId) {
    if (!this.channel || !this._isSelected(sessionId)) return null
    return this._ensureRoot(sessionId)
  }

  async setSessionRelayEnabled(sessionId, enabled) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { accepted: false, reason: 'invalid_session' }
    }
    if (enabled) {
      this.routeStore.setRelayEnabled(sessionId, true)
      await this.resyncSession(sessionId)
    } else {
      if (this._isSelected(sessionId)) {
        await this._updateRoot(sessionId, {
          stateLabel: '已停止转发',
          interruptToken: null
        })
      }
      this.taskQueue.onRelayDisabled(sessionId)
      this.routeStore.setRelayEnabled(sessionId, false)
    }
    this._publish()
    return { accepted: true }
  }

  async respondDesktopDecision(sessionId, decisionId, response) {
    const pending = this.decisionRegistry.listPendingForSession(sessionId)
      .find((entry) => entry.decision.decisionId === decisionId)
    if (!pending) return { accepted: false, reason: 'already_resolved' }
    const result = await this.decisionRegistry.resolve({
      decisionId,
      response,
      source: 'desktop'
    })
    if (result.accepted) {
      await this._markDecisionResolved(decisionId)
      this.pendingDecisions.delete(decisionId)
      await this._updateRoot(sessionId)
      this._publish()
    }
    return result
  }

  async shutdown() {
    this.acceptingInbound = false
    this.decisionRegistry.invalidateRemoteTokens('gateway_shutdown')
    this.actions.clear()
    this._unbindChannel()
    const channel = this.channel
    this.channel = null
    await channel?.disconnect?.()
  }

  async handleInboundMessage(message) {
    if (!this.acceptingInbound) {
      return { accepted: false, reason: 'gateway_not_accepting' }
    }
    if (!this._isAuthorized(message?.senderOpenId)) {
      return { accepted: false, reason: 'unauthorized_operator' }
    }
    const explicitRoute = this._resolveExplicitMessageRoute(message)
    const sessionId = explicitRoute?.sessionId || this._resolveMessageSession(message)
    if (!sessionId) {
      return {
        accepted: false,
        reason: message?.chatType === 'group'
          ? 'route_required'
          : this._fallbackCandidates().length === 1
            ? 'route_required'
            : 'ambiguous_session'
      }
    }
    if (!message?.supported || message?.rawContentType !== 'text') {
      return { accepted: false, reason: 'unsupported_content' }
    }
    const text = sanitizeInboundText(message.text)
    if (!text) return { accepted: false, reason: 'invalid_task' }
    if (explicitRoute?.decisionId) {
      const pending = this.pendingDecisions.get(explicitRoute.decisionId)
      if (pending) {
        const response = pending.decision.kind === 'plan_review'
          ? { action: 'revise', text }
          : pending.decision.responseMode === 'free_text'
            ? { text }
            : null
        if (response) {
          const result = await this.decisionRegistry.resolve({
            decisionId: explicitRoute.decisionId,
            response,
            source: 'feishu'
          })
          if (result.accepted) {
            await this._markDecisionResolved(explicitRoute.decisionId)
            this.pendingDecisions.delete(explicitRoute.decisionId)
            await this._updateRoot(sessionId)
            this._publish()
          }
          return result
        }
      }
    }

    const queued = this.taskQueue.enqueue(sessionId, message.messageId, text)
    if (!queued.accepted) return queued
    this.routeStore.saveMessageRoute({
      messageId: message.messageId,
      sessionId,
      relayTaskId: queued.task.relayTaskId,
      routeKind: 'task',
      channelFingerprint: this.fingerprint
    })
    await this.channel?.addReaction(message.messageId, 'OnIt')
    if (queued.position === 0) {
      await this._startTask(queued.task)
    } else {
      const route = this._routeFor(sessionId)
      await this.channel?.sendCard(buildQueueCard({
        sessionLabel: this.port.getSession(sessionId)?.name,
        position: queued.position
      }), { replyTo: route?.rootMessageId })
    }
    await this._updateRoot(sessionId)
    this._publish()
    return {
      accepted: true,
      relayTaskId: queued.task.relayTaskId,
      position: queued.position
    }
  }

  async handleInboundAction(action) {
    if (!this.acceptingInbound) {
      return { accepted: false, reason: 'gateway_not_accepting' }
    }
    if (!this._isAuthorized(action?.senderOpenId)) {
      return { accepted: false, reason: 'unauthorized_operator' }
    }
    const binding = this.actions.get(action?.token)
    if (!binding) return { accepted: false, reason: 'invalid_action_token' }
    this.actions.delete(action.token)

    if (binding.kind === 'decision') {
      const result = await this.decisionRegistry.resolve({
        decisionId: binding.decisionId,
        response: {
          ...actionResponse(binding.action),
          actionToken: binding.decisionToken
        },
        source: 'feishu'
      })
      if (result.accepted) {
        await this._markDecisionResolved(binding.decisionId)
        this.pendingDecisions.delete(binding.decisionId)
        await this._updateRoot(binding.sessionId)
        this._publish()
      }
      return result
    }
    if (binding.kind === 'view_plan') {
      return this._sendPlanDetails(binding)
    }
    if (binding.kind === 'view_result') {
      return this._sendResultDetails(binding)
    }
    if (binding.kind === 'view_decision') {
      return this._sendDecisionDetails(binding)
    }
    if (binding.kind === 'interrupt') {
      return this._interrupt(binding.sessionId)
    }
    if (binding.kind === 'continue') {
      const next = this.taskQueue.continue(binding.sessionId)
      if (next) await this._startTask(next)
      await this._updateRoot(binding.sessionId)
      this._publish()
      return { accepted: true }
    }
    if (binding.kind === 'clear') {
      const cancelled = this.taskQueue.clear(binding.sessionId)
      await this._updateRoot(binding.sessionId)
      this._publish()
      return { accepted: true, cancelled }
    }
    return { accepted: false, reason: 'invalid_action_token' }
  }

  async handleGatewayEvent(event) {
    if (!event?.sessionId) return { accepted: false, reason: 'invalid_event' }
    if (event.type === 'decision_required') {
      await this._handleDecision(event)
    } else if (event.type === 'turn_started') {
      const running = this.taskQueue.getState(event.sessionId).running
      if (running) this.turnTasks.set(event.turnId, running)
      await this._updateRoot(event.sessionId)
    } else if (
      event.type === 'turn_completed' ||
      event.type === 'turn_failed'
    ) {
      await this._finishTurn(event)
    } else if (event.type === 'turn_interrupted') {
      await this._handleProviderInterruption(event)
    } else if (event.type === 'session_stopped') {
      this.taskQueue.onSessionStopped(event.sessionId)
      this.decisionRegistry.cancelForSession(event.sessionId, 'session_stopped')
      this.routeStore.deactivateSession(event.sessionId)
    }
    this._publish()
    return { accepted: true }
  }

  _bindChannel(channel) {
    this.unsubscribers = [
      channel.onUserMessage?.((message) => this.handleInboundMessage(message)),
      channel.onAction?.((action) => this.handleInboundAction(action)),
      channel.onStatus?.((status) => this._handleChannelStatus(status))
    ].filter(Boolean)
  }

  _unbindChannel() {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
  }

  async _handleChannelStatus(status) {
    if (status?.type === 'reconnecting') {
      this._setState({ phase: 'reconnecting', errorCode: null, errorMessage: '' })
      return
    }
    if (status?.type === 'reconnected') {
      this.decisionRegistry.invalidateRemoteTokens('channel_reconnected')
      this.actions.clear()
      this._setState({
        phase: 'connected',
        errorCode: null,
        errorMessage: '',
        lastConnectedAt: Date.now()
      })
      await this._resyncAfterReconnect()
      return
    }
    if (status?.type === 'error') {
      const errorCode = safeText(status.errorCode, 'connection_error')
      this._setState({
        phase: 'error',
        errorCode,
        errorMessage: publicErrorMessage(errorCode)
      })
    }
  }

  async _resyncAfterReconnect() {
    await this._syncSelectedRoots()
    for (const route of this._selectedRoutes()) {
      for (const pending of this.decisionRegistry.listPendingForSession(route.sessionId)) {
        await this._sendDecision(pending.sessionId, pending.decision)
      }
      const completion = this.latestCompletions.get(route.sessionId)
      if (completion) await this._sendCompletion(completion)
    }
  }

  async _syncSelectedRoots() {
    for (const route of this._selectedRoutes()) {
      const session = this.port.getSession(route.sessionId)
      if (session && READY_SESSION_STATES.has(session.status)) {
        await this._ensureRoot(route.sessionId)
      }
    }
  }

  async _ensureRoot(sessionId) {
    const stored = this._routeFor(sessionId)
    const view = this._rootView(sessionId)
    if (
      stored?.rootMessageId &&
      stored.channelFingerprint === this.fingerprint
    ) {
      try {
        await this.channel.updateSessionRoot(stored, view)
        return stored
      } catch (error) {
        if (error?.code !== 'target_revoked') throw error
      }
    }
    const created = await this.channel.sendSessionRoot(view)
    const route = this.routeStore.upsertSessionRoute({
      sessionId,
      relayEnabled: true,
      channelFingerprint: this.fingerprint,
      targetId: targetIdOf(this.config),
      rootMessageId: created.messageId,
      rootThreadId: created.threadId || null,
      routeStatus: 'ready'
    })
    this.routeStore.saveMessageRoute({
      messageId: created.messageId,
      sessionId,
      routeKind: 'root',
      channelFingerprint: this.fingerprint
    })
    if (created.threadId) {
      this.routeStore.saveMessageRoute({
        messageId: created.threadId,
        sessionId,
        routeKind: 'thread',
        channelFingerprint: this.fingerprint
      })
    }
    return route
  }

  async _updateRoot(sessionId, overrides = {}) {
    if (!this.channel || !this._isSelected(sessionId)) return
    const route = this._routeFor(sessionId)
    if (!route?.rootMessageId) {
      await this._ensureRoot(sessionId)
      return
    }
    try {
      await this.channel.updateSessionRoot(route, {
        ...this._rootView(sessionId),
        ...overrides
      })
    } catch (error) {
      if (error?.code === 'target_revoked') await this._ensureRoot(sessionId)
      else throw error
    }
  }

  _rootView(sessionId) {
    const value = this.port.getSession(sessionId) || {}
    const queue = this.taskQueue.getState(sessionId)
    let interruptToken = null
    if (queue.running) {
      interruptToken = this._issueAction({
        kind: 'interrupt',
        sessionId
      })
    }
    return {
      displayName: safeText(value.name, '未命名会话'),
      adapterLabel: safeText(value.adapterId || value.provider, '-'),
      shortSessionId: String(sessionId).slice(-8),
      stateLabel: queue.paused
        ? '已暂停'
        : this.decisionRegistry.listPendingForSession(sessionId).length
          ? '等待用户决策'
          : queue.running
            ? '运行中'
            : safeText(value.status, '等待同步'),
      queueCount: queue.waiting.length,
      currentTaskLabel: queue.running ? '正在处理飞书任务' : '',
      latestCompletionLabel: this.latestCompletions.has(sessionId)
        ? '最近任务已结束'
        : '',
      interruptToken
    }
  }

  _resolveMessageSession(message) {
    const explicit = this._resolveExplicitMessageRoute(message)
    if (explicit) return explicit.sessionId
    if (message?.chatType !== 'p2p') return null
    const candidates = this._fallbackCandidates()
    return candidates.length === 1 ? candidates[0].id : null
  }

  _resolveExplicitMessageRoute(message) {
    for (const routeId of [
      message?.replyToMessageId,
      message?.rootId,
      message?.threadId
    ]) {
      if (!routeId) continue
      const route = this.routeStore.resolveMessageRoute(routeId, this.fingerprint)
      if (route && this._isSelected(route.sessionId)) return route
    }
    return null
  }

  _fallbackCandidates() {
    return this._selectedRoutes()
      .map((route) => this.port.getSession(route.sessionId))
      .filter((value) => value && READY_SESSION_STATES.has(value.status))
  }

  async _startTask(task) {
    await this.port.sendTurn(task.sessionId, task.text)
  }

  async _finishTurn(event) {
    const queue = this.taskQueue.getState(event.sessionId)
    const task = this.turnTasks.get(event.turnId) || queue.running
    if (task) {
      await this.channel?.removeReaction(task.sourceMessageId, 'OnIt')
      await this.channel?.addReaction(
        task.sourceMessageId,
        event.type === 'turn_failed' ? 'CrossMark' : 'DONE'
      )
    }
    const snapshot = await this.port.getLatestResultSnapshot(
      event.sessionId,
      event.turnId
    )
    const stored = this.snapshotStore.storeResult(snapshot?.markdown)
    const completion = {
      sessionId: event.sessionId,
      turnId: event.turnId,
      failed: event.type === 'turn_failed',
      title: event.type === 'turn_failed' ? '任务失败' : '任务完成',
      summary: redactDisplayText(
        snapshot?.title || (event.type === 'turn_failed' ? '任务执行失败。' : '任务已完成。')
      ).text,
      resultSnapshotId: stored.available ? stored.resultSnapshotId : null
    }
    this.latestCompletions.set(event.sessionId, completion)
    await this._sendCompletion(completion)
    this.turnTasks.delete(event.turnId)
    const next = this.taskQueue.completeCurrent(
      event.sessionId,
      task?.relayTaskId
    )
    if (next) await this._startTask(next)
    await this._updateRoot(event.sessionId)
  }

  async _sendCompletion(completion) {
    const route = this._routeFor(completion.sessionId)
    if (!route?.rootMessageId || !this.channel) return
    const resultToken = completion.resultSnapshotId
      ? this._issueAction({
          kind: 'view_result',
          sessionId: completion.sessionId,
          snapshotId: completion.resultSnapshotId
        })
      : null
    const sent = await this.channel.sendCompletion(route, {
      title: completion.title,
      summary: completion.summary,
      failed: completion.failed,
      resultToken
    })
    if (sent?.messageId) {
      this.routeStore.saveMessageRoute({
        messageId: sent.messageId,
        sessionId: completion.sessionId,
        routeKind: 'completion',
        channelFingerprint: this.fingerprint
      })
    }
  }

  async _handleProviderInterruption(event) {
    const task = this.taskQueue.interrupt(event.sessionId)
    if (task) {
      await this.channel?.removeReaction(task.sourceMessageId, 'OnIt')
      await this.channel?.addReaction(task.sourceMessageId, 'CrossMark')
    }
    await this._sendInterruptCard(event.sessionId, task)
    await this._updateRoot(event.sessionId)
  }

  async _interrupt(sessionId) {
    await this.port.interrupt(sessionId)
    const task = this.taskQueue.interrupt(sessionId)
    if (task) {
      await this.channel?.removeReaction(task.sourceMessageId, 'OnIt')
      await this.channel?.addReaction(task.sourceMessageId, 'CrossMark')
    }
    await this._sendInterruptCard(sessionId, task)
    await this._updateRoot(sessionId)
    this._publish()
    return { accepted: true }
  }

  async _sendInterruptCard(sessionId, task) {
    const route = this._routeFor(sessionId)
    const continueToken = this._issueAction({ kind: 'continue', sessionId })
    const clearToken = this._issueAction({ kind: 'clear', sessionId })
    await this.channel?.sendCard(buildInterruptCard({
      cancelledTaskLabel: task ? '当前任务已中断。' : '队列已暂停。',
      continueToken,
      clearToken
    }), { replyTo: route?.rootMessageId })
  }

  async _handleDecision(event) {
    this.decisionRegistry.register(event.decision, event.sessionId)
    this.pendingDecisions.set(event.decision.decisionId, {
      sessionId: event.sessionId,
      decision: structuredClone(event.decision)
    })
    await this._sendDecision(event.sessionId, event.decision)
    await this._updateRoot(event.sessionId)
  }

  async _sendDecision(sessionId, decision) {
    const route = this._routeFor(sessionId)
    if (!route?.rootMessageId || !this.channel) return
    if (decision.kind === 'plan_review') {
      const snapshot = await this.port.getLatestPlanSnapshot(
        sessionId,
        decision.decisionId
      )
      const stored = this.snapshotStore.storePlan(
        snapshot?.markdown || decision.summary
      )
      const viewToken = stored.available
        ? this._issueAction({
            kind: 'view_plan',
            sessionId,
            decisionId: decision.decisionId,
            snapshotId: stored.planSnapshotId
          })
        : null
      const sent = await this.channel.sendPlanReview(route, {
        overview: stored.overview || {
          title: decision.title,
          preview: '请在 UCLI 中处理。'
        },
        viewToken
      })
      this._rememberDecisionMessage(decision.decisionId, sent?.messageId)
      this._saveDecisionRoute(sent, sessionId, decision.decisionId, 'plan')
      return
    }
    const summary = prepareDecisionSummary(decision.summary || '')
    const actions = []
    if (summary.truncated && !summary.desktopOnly) {
      const detailId = opaqueToken()
      const points = Array.from(redactDisplayText(decision.summary || '').text)
      const chunks = []
      for (let index = 0; index < points.length; index += this.snapshotChunkSize) {
        chunks.push(points.slice(index, index + this.snapshotChunkSize).join(''))
      }
      this.decisionDetails.set(detailId, { sessionId, chunks })
      actions.push({
        id: 'view_full',
        label: '查看完整内容',
        token: this._issueAction({
          kind: 'view_decision',
          sessionId,
          detailId
        })
      })
    }
    if (!summary.desktopOnly) {
      for (const option of decision.options || []) {
        const decisionToken = this.decisionRegistry.issueActionToken(
          decision.decisionId,
          option.id
        )
        if (!decisionToken) continue
        const token = this._issueAction({
          kind: 'decision',
          sessionId,
          decisionId: decision.decisionId,
          action: option.id,
          decisionToken
        })
        actions.push({
          id: option.id,
          label: option.label,
          token,
          type: option.id === 'allow_once' ? 'primary' : 'default'
        })
      }
    }
    const sent = await this.channel.sendDecision(route, {
      title: decision.title,
      summary: summary.summary,
      desktopOnly: summary.desktopOnly,
      actions
    })
    this._rememberDecisionMessage(decision.decisionId, sent?.messageId)
    this._saveDecisionRoute(sent, sessionId, decision.decisionId, 'decision')
  }

  _rememberDecisionMessage(decisionId, messageId) {
    const pending = this.pendingDecisions.get(decisionId)
    if (pending && messageId) pending.messageId = messageId
  }

  async _markDecisionResolved(decisionId) {
    const pending = this.pendingDecisions.get(decisionId)
    for (const [token, binding] of this.actions) {
      if (binding.decisionId === decisionId) this.actions.delete(token)
    }
    if (!pending?.messageId || !this.channel?.updateCard) return
    try {
      await this.channel.updateCard(
        pending.messageId,
        buildDecisionCard({
          title: pending.decision.title,
          summary: '该决策已处理。',
          actions: []
        })
      )
    } catch {
      // The provider response already won; a stale remote card cannot undo it.
    }
  }

  _saveDecisionRoute(sent, sessionId, decisionId, routeKind) {
    if (!sent?.messageId) return
    this.routeStore.saveMessageRoute({
      messageId: sent.messageId,
      sessionId,
      decisionId,
      routeKind,
      channelFingerprint: this.fingerprint
    })
  }

  async _sendPlanDetails(binding) {
    const chunks = this.snapshotStore.getPlanChunks(binding.snapshotId)
    if (!chunks) return { accepted: false, reason: 'snapshot_unavailable' }
    const route = this._routeFor(binding.sessionId)
    for (const chunk of chunks) {
      const actions = []
      for (const action of chunk.actions) {
        const decisionToken = this.decisionRegistry.issueActionToken(
          binding.decisionId,
          action.id
        )
        if (!decisionToken) continue
        actions.push({
          ...action,
          token: this._issueAction({
            kind: 'decision',
            sessionId: binding.sessionId,
            decisionId: binding.decisionId,
            action: action.id,
            decisionToken
          })
        })
      }
      await this.channel.sendCard(buildPlanDetailCard({
        title: '完整方案',
        ...chunk,
        actions
      }), { replyTo: route?.rootMessageId })
    }
    return { accepted: true }
  }

  async _sendResultDetails(binding) {
    const chunks = this.snapshotStore.getResultChunks(binding.snapshotId)
    if (!chunks) return { accepted: false, reason: 'snapshot_unavailable' }
    const route = this._routeFor(binding.sessionId)
    for (const chunk of chunks) {
      await this.channel.sendCard(buildPlanDetailCard({
        title: '完整结果',
        ...chunk,
        actions: []
      }), { replyTo: route?.rootMessageId })
    }
    return { accepted: true }
  }

  async _sendDecisionDetails(binding) {
    const detail = this.decisionDetails.get(binding.detailId)
    if (!detail) return { accepted: false, reason: 'snapshot_unavailable' }
    const route = this._routeFor(binding.sessionId)
    for (let index = 0; index < detail.chunks.length; index++) {
      await this.channel.sendCard(buildPlanDetailCard({
        title: '完整决策内容',
        index: index + 1,
        total: detail.chunks.length,
        markdown: detail.chunks[index],
        actions: []
      }), { replyTo: route?.rootMessageId })
    }
    return { accepted: true }
  }

  _issueAction(binding) {
    const token = opaqueToken()
    this.actions.set(token, binding)
    return token
  }

  _routeFor(sessionId) {
    return this.routeStore.listSessionRoutes()
      .find((route) => route.sessionId === sessionId) || null
  }

  _selectedRoutes() {
    return this.routeStore.listSessionRoutes()
      .filter((route) => route.relayEnabled)
  }

  _isSelected(sessionId) {
    return this._selectedRoutes().some((route) => route.sessionId === sessionId)
  }

  _isAuthorized(senderOpenId) {
    return typeof senderOpenId === 'string' &&
      this.config?.operatorOpenIds?.includes(senderOpenId)
  }

  _counts() {
    const selected = this._selectedRoutes()
    const ready = selected.filter((route) => {
      const value = this.port.getSession(route.sessionId)
      return value && READY_SESSION_STATES.has(value.status)
    })
    let queuedTaskCount = 0
    for (const route of selected) {
      const queue = this.taskQueue.getState(route.sessionId)
      queuedTaskCount += (queue.running ? 1 : 0) + queue.waiting.length
    }
    let pendingDecisionCount = 0
    for (const route of selected) {
      pendingDecisionCount +=
        this.decisionRegistry.listPendingForSession(route.sessionId).length
    }
    return {
      selectedSessionCount: selected.length,
      readySessionCount: ready.length,
      pendingDecisionCount,
      queuedTaskCount
    }
  }

  _setState(patch) {
    Object.assign(this.state, patch)
    this._publish()
  }

  _publish() {
    this.publishState(this.getState())
  }
}
