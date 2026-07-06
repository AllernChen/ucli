import { randomUUID } from 'crypto'
import { classify, toClassifierInput } from './classifier.js'
import { TIER } from '../adapters/cliAdapter.js'

const ASK_TIMEOUT_MS = 5 * 60 * 1000 // auto-deny if the user never answers

/**
 * The permission engine owns the per-session tier + ruleset and resolves every
 * tool-call approval. When a tier requires asking the user, it emits an
 * approval request through `onApprovalRequest` and awaits `respondApproval()`.
 *
 * Verdict is always one of 'allow' | 'deny' (generic); adapters translate to
 * CLI-native decisions (Claude allow/deny, Codex accept/decline).
 */
export class PermissionEngine {
  /**
   * @param {{ onApprovalRequest: (req: object) => void, onApprovalResolved?: (req: object) => void, onDecision?: (d: object) => void }} opts
   */
  constructor({ onApprovalRequest, onApprovalResolved, onDecision }) {
    this._sessions = new Map() // sessionId -> { tier, rulesetId }
    this._rulesets = new Map() // rulesetId -> ruleset
    this._pending = new Map() // requestId -> { resolve, timer, req }
    this._onAsk = onApprovalRequest
    this._onResolved = onApprovalResolved || (() => {})
    this._onDecision = onDecision || (() => {})
  }

  setSession(sessionId, { tier, rulesetId, ruleset }) {
    this._sessions.set(sessionId, { tier, rulesetId })
    if (ruleset) this._rulesets.set(rulesetId, ruleset)
  }

  removeSession(sessionId) {
    this._sessions.delete(sessionId)
  }

  setRuleset(rulesetId, ruleset) {
    this._rulesets.set(rulesetId, ruleset)
  }

  _rulesetFor(sessionId) {
    const s = this._sessions.get(sessionId)
    if (!s) return {}
    return this._rulesets.get(s.rulesetId) || {}
  }

  _tier(sessionId) {
    return this._sessions.get(sessionId)?.tier || TIER.SAFETY_RULES
  }

  /**
   * @param {string} sessionId
   * @param {{ tool: string, input: object, cwd?: string }} call
   * @returns {Promise<{ verdict: 'allow'|'deny', classification: string, reason: string, matched?: string }>}
   */
  async decide(sessionId, call) {
    const result = await this._decide(sessionId, call)
    this._onDecision({ sessionId, tool: call.tool, ...result })
    return result
  }

  async _decide(sessionId, call) {
    const input = toClassifierInput(call.tool, call.input)
    if (call.cwd) input.cwd = call.cwd
    const ruleset = this._rulesetFor(sessionId)
    const { classification, matched } = classify(input, ruleset)
    const tier = this._tier(sessionId)

    // Hard blacklist is enforced in every tier.
    if (classification === 'blacklist') {
      return { verdict: 'deny', classification, reason: '命中硬黑名单（不可绕过）', matched }
    }

    if (tier === TIER.ALWAYS_AGREE) {
      return { verdict: 'allow', classification, reason: '一直同意模式：自动放行' }
    }

    if (tier === TIER.ASK_EVERYTHING) {
      return this._ask(sessionId, call, input, classification, matched, '逐次确认模式')
    }

    // SAFETY_RULES
    if (classification === 'deny') {
      return { verdict: 'deny', classification, reason: '命中拒绝规则', matched }
    }
    if (classification === 'high-risk') {
      return this._ask(sessionId, call, input, classification, matched, '命中高危规则，需确认')
    }
    return { verdict: 'allow', classification, reason: '安全规则模式：自动放行', matched }
  }

  _ask(sessionId, call, input, classification, matched, reason) {
    const requestId = randomUUID()
    const req = {
      requestId,
      sessionId,
      tool: call.tool,
      input: call.input,
      summary: summarize(call.tool, input),
      command: input.command,
      path: input.path,
      host: input.host,
      cwd: call.cwd,
      classification,
      matched,
      reason
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId)
          this._onResolved({ ...req, verdict: 'deny', timedOut: true })
          resolve({ verdict: 'deny', classification, reason: '确认超时，已自动拒绝', matched })
        }
      }, ASK_TIMEOUT_MS)
      this._pending.set(requestId, { resolve, timer, req })
      this._onAsk(req)
    })
  }

  respondApproval(requestId, verdict) {
    const pending = this._pending.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this._pending.delete(requestId)
    this._onResolved({ ...pending.req, verdict })
    pending.resolve({
      verdict,
      classification: pending.req.classification,
      reason: verdict === 'allow' ? '用户确认放行' : '用户拒绝',
      matched: pending.req.matched,
      asked: true
    })
    return true
  }

  pendingCount() {
    return this._pending.size
  }
}

function summarize(tool, input) {
  if (input.command) return `${tool}: ${input.command}`
  if (input.path) return `${tool}: ${input.path}`
  if (input.host) return `${tool}: ${input.host}`
  return tool
}
