import { randomUUID } from 'crypto'
import { classify, toClassifierInput } from './classifier.js'
import { TIER } from '../adapters/cliAdapter.js'

const VALID_TIERS = new Set(Object.values(TIER))
const VALID_VERDICTS = new Set(['allow', 'deny'])

export function dshPermissionPolicyForTier(tier) {
  if (!VALID_TIERS.has(tier)) throw new TypeError(`Unknown permission tier: ${tier}`)
  return Object.freeze({
    sandboxPreset: 'workspace-write',
    nativeApproval: 'bridge-deny'
  })
}

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
    this._pending = new Map() // requestId -> { resolve, req }
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
    for (const [requestId, pending] of this._pending) {
      if (pending.req.sessionId !== sessionId) continue
      this._settlePending(requestId, 'deny', {
        verdict: 'deny',
        classification: pending.req.classification,
        reason: '权限会话已取消',
        asked: true
      })
    }
  }

  setRuleset(rulesetId, ruleset) {
    this._rulesets.set(rulesetId, ruleset)
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
    this._notify(this._onDecision, { sessionId, tool: call.tool, ...result })
    return result
  }

  _notify(observer, value) {
    try {
      observer(value)
      return true
    } catch {
      return false
    }
  }

  _settlePending(requestId, verdict, result) {
    const pending = this._pending.get(requestId)
    if (!pending) return false
    this._pending.delete(requestId)
    pending.signal?.removeEventListener('abort', pending.abort)
    pending.resolve(result)
    this._notify(this._onResolved, { ...pending.req, verdict })
    return true
  }

  async _decide(sessionId, call) {
    const session = this._sessions.get(sessionId)
    const ruleset = session ? this._rulesets.get(session.rulesetId) : undefined
    if (!session || !VALID_TIERS.has(session.tier) || !validRuleset(ruleset)) {
      return { verdict: 'deny', classification: 'unavailable', reason: '权限会话不可用' }
    }
    const input = toClassifierInput(call.tool, call.input, call.cwd)
    if (call.cwd) input.cwd = call.cwd
    const { classification, matched } = classify(input, ruleset)
    const tier = this._tier(sessionId)

    // Hard blacklist is enforced in every tier.
    if (classification === 'blacklist') {
      return { verdict: 'deny', classification, reason: '命中硬黑名单（不可绕过）', matched }
    }

    if (call.approvalRequired === true) {
      return this._ask(sessionId, call, input, classification, matched, 'DSH 请求逐次确认')
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
    const signal = call.signal &&
      typeof call.signal.addEventListener === 'function' &&
      typeof call.signal.removeEventListener === 'function'
      ? call.signal
      : undefined
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
    if (signal?.aborted) {
      return Promise.resolve({
        verdict: 'deny', classification, reason: '权限请求已取消', asked: true, matched
      })
    }
    return new Promise((resolve) => {
      const abort = () => {
        const pending = this._pending.get(requestId)
        if (!pending) return
        this._settlePending(requestId, 'deny', {
          verdict: 'deny', classification, reason: '权限请求已取消', asked: true, matched
        })
      }
      this._pending.set(requestId, { resolve, req, abort, signal })
      signal?.addEventListener('abort', abort, { once: true })
      if (!this._notify(this._onAsk, req)) {
        this._settlePending(requestId, 'deny', {
          verdict: 'deny', classification: 'unavailable',
          reason: '权限审批处理器不可用', asked: true, matched
        })
      }
    })
  }

  respondApproval(sessionId, requestId, verdict) {
    if (!VALID_VERDICTS.has(verdict)) return false
    const pending = this._pending.get(requestId)
    if (!pending || pending.req.sessionId !== sessionId) return false
    return this._settlePending(requestId, verdict, {
      verdict,
      classification: pending.req.classification,
      reason: verdict === 'allow' ? '用户确认放行' : '用户拒绝',
      matched: pending.req.matched,
      asked: true
    })
  }

  pendingCount() {
    return this._pending.size
  }
}

function validRuleset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return ['deny', 'highRisk', 'allow'].every((key) => (
    value[key] === undefined ||
    (Array.isArray(value[key]) && value[key].every((entry) => typeof entry === 'string'))
  ))
}

function summarize(tool, input) {
  if (input.command) return `${tool}: ${input.command}`
  if (input.path) return `${tool}: ${input.path}`
  if (input.host) return `${tool}: ${input.host}`
  return tool
}
