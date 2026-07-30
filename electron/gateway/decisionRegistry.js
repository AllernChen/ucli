import { randomBytes, randomUUID } from 'node:crypto'

function publicEntry(entry) {
  return {
    sessionId: entry.sessionId,
    decision: structuredClone(entry.decision),
    registeredAt: entry.registeredAt
  }
}

function verdictOf(response) {
  if (typeof response?.action === 'string' && response.action) return response.action
  if (typeof response?.optionId === 'string' && response.optionId) return response.optionId
  if (Array.isArray(response?.optionIds) && response.optionIds.length) return 'submitted'
  if (typeof response?.text === 'string' && response.text.trim()) return 'submitted'
  return 'submitted'
}

function decisionKey(sessionId, decisionId) {
  return JSON.stringify([sessionId, decisionId])
}

export class DecisionRegistry {
  constructor({ responder, routeStore }) {
    this.responder = responder
    this.routeStore = routeStore
    this._decisions = new Map()
    this._tokens = new Map()
  }

  register(decision, sessionId) {
    if (!decision?.decisionId || !sessionId) {
      throw Object.assign(new TypeError('Decision and session are required'), {
        code: 'INVALID_GATEWAY_DECISION'
      })
    }
    const key = decisionKey(sessionId, decision.decisionId)
    const existing = this._decisions.get(key)
    if (existing?.status === 'pending' || existing?.status === 'resolving') {
      return publicEntry(existing)
    }
    const entry = {
      decision: structuredClone(decision),
      sessionId,
      status: 'pending',
      registeredAt: Date.now()
    }
    this._decisions.set(key, entry)
    return publicEntry(entry)
  }

  issueActionToken(sessionId, decisionId, action) {
    const entry = this._decisions.get(decisionKey(sessionId, decisionId))
    if (!entry || entry.status !== 'pending' || typeof action !== 'string' || !action) {
      return null
    }
    const token = randomBytes(32).toString('base64url')
    this._tokens.set(token, { sessionId, decisionId, action })
    return token
  }

  async resolve({ sessionId, decisionId, response, source }) {
    const entry = this._decisions.get(decisionKey(sessionId, decisionId))
    if (!entry || entry.status !== 'pending') {
      return { accepted: false, reason: 'already_resolved' }
    }
    if (source !== 'desktop' && source !== 'feishu') {
      return { accepted: false, reason: 'invalid_source' }
    }

    let actionToken = null
    if (source === 'feishu') {
      actionToken = response?.actionToken
      if (actionToken) {
        const binding = this._tokens.get(actionToken)
        const responseAction = response?.action || response?.optionId
        if (
          !binding ||
          binding.sessionId !== sessionId ||
          binding.decisionId !== decisionId ||
          binding.action !== responseAction
        ) {
          return { accepted: false, reason: 'invalid_action_token' }
        }
        this._tokens.delete(actionToken)
      } else {
        const acceptsRoutedText = (
          entry.decision.responseMode === 'free_text' ||
          (entry.decision.kind === 'plan_review' && response?.action === 'revise')
        ) && typeof response?.text === 'string' && response.text.trim()
        if (!acceptsRoutedText) {
          return { accepted: false, reason: 'invalid_action_token' }
        }
      }
    }

    entry.status = 'resolving'
    let result
    try {
      const { actionToken: _ignored, ...providerResponse } = response || {}
      result = await this.responder(
        entry.sessionId,
        decisionId,
        providerResponse
      )
    } catch (error) {
      entry.status = 'pending'
      throw error
    }

    if (!result?.accepted) {
      entry.status = result?.reason === 'already_resolved' ? 'resolved' : 'pending'
      return result || { accepted: false, reason: 'rejected' }
    }

    entry.status = 'resolved'
    this._deleteTokensForDecision(sessionId, decisionId)
    try {
      this.routeStore.saveDecisionAudit({
        id: randomUUID(),
        sessionId: entry.sessionId,
        decisionId,
        kind: entry.decision.kind,
        verdict: verdictOf(response),
        source,
        resolvedAt: Date.now()
      })
    } catch {
      // The provider already accepted the response; audit failure cannot undo it.
    }
    return { accepted: true }
  }

  resolveExternally({ sessionId, decisionId, source }) {
    const entry = this._decisions.get(decisionKey(sessionId, decisionId))
    if (!entry || entry.status !== 'pending') {
      return { accepted: false, reason: 'already_resolved' }
    }
    if (source !== 'desktop') {
      return { accepted: false, reason: 'invalid_source' }
    }
    entry.status = 'resolved'
    this._deleteTokensForDecision(sessionId, decisionId)
    try {
      this.routeStore.saveDecisionAudit({
        id: randomUUID(),
        sessionId,
        decisionId,
        kind: entry.decision.kind,
        verdict: 'native_input',
        source,
        resolvedAt: Date.now()
      })
    } catch {
      // Native input already reached the provider; audit failure cannot undo it.
    }
    return { accepted: true }
  }

  cancelForSession(sessionId, reason) {
    let count = 0
    for (const entry of this._decisions.values()) {
      if (
        entry.sessionId !== sessionId ||
        entry.status !== 'pending'
      ) continue
      entry.status = 'cancelled'
      entry.cancelReason = reason
      this._deleteTokensForDecision(
        entry.sessionId,
        entry.decision.decisionId
      )
      count += 1
    }
    return count
  }

  invalidateRemoteTokens(_reason) {
    const count = this._tokens.size
    this._tokens.clear()
    return count
  }

  invalidateRemoteTokensForSession(sessionId, _reason) {
    let count = 0
    for (const [token, binding] of this._tokens) {
      if (binding.sessionId !== sessionId) continue
      this._tokens.delete(token)
      count += 1
    }
    return count
  }

  listPendingForSession(sessionId) {
    return [...this._decisions.values()]
      .filter((entry) => entry.sessionId === sessionId && entry.status === 'pending')
      .map(publicEntry)
  }

  _deleteTokensForDecision(sessionId, decisionId) {
    for (const [token, binding] of this._tokens) {
      if (
        binding.sessionId === sessionId &&
        binding.decisionId === decisionId
      ) {
        this._tokens.delete(token)
      }
    }
  }
}
