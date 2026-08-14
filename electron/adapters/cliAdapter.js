import { EventEmitter } from 'events'
import { validateGatewayEvent } from '../gateway/contracts.js'

/**
 * Permission tiers — selected per session (card).
 *   ALWAYS_AGREE    auto-allow everything EXCEPT the non-bypassable hard blacklist
 *   SAFETY_RULES    deny-list → deny; high-risk list → ask user; allow-list / default → allow
 *   ASK_EVERYTHING  ask user for every tool call (hard blacklist still auto-denies)
 */
export const TIER = {
  ALWAYS_AGREE: 'always-agree',
  SAFETY_RULES: 'safety-rules',
  ASK_EVERYTHING: 'ask-everything'
}

/**
 * Normalized event types emitted by every adapter via emit('event', evt).
 * Adapters translate CLI-native messages into this shape so the UI renderer
 * registry can stay CLI-agnostic.
 *
 * @typedef {Object} AdapterEvent
 * @property {'init'|'message'|'reasoning'|'tool_call'|'tool_result'|'command_output'|'file_diff'|'token_usage'|'turn_complete'|'error'|'status'} type
 * @property {string} sessionId
 * @property {number} ts
 */
export class BaseAdapter extends EventEmitter {
  /**
   * @param {{ id: string, displayName: string, session: object, engine: object }} opts
   * `session` = { id, adapterId, cwd, model, tier, rulesetId, cliSessionId? }
   * `engine`  = permission engine (has async decide(sessionId, classifierInput) → {verdict, reason})
   */
  constructor({ id, displayName, session, engine }) {
    super()
    this.id = id
    this.displayName = displayName
    this.session = session
    this.engine = engine
    /** @type {any} CLI process / connection handle (subclass-specific) */
    this.handle = null
    this._disposed = false
  }

  async start() {
    throw new Error(`${this.id}: start() not implemented`)
  }
  async sendTurn(_text) {
    throw new Error(`${this.id}: sendTurn() not implemented`)
  }
  async respondApproval(_requestId, _verdict) {
    // verdict: 'allow' | 'deny' (generic). Subclass maps to CLI-native decision.
  }
  get gatewayCapabilities() {
    return {
      decisions: false,
      planSnapshot: false,
      resultSnapshot: false
    }
  }
  getDecisionContext() {
    return null
  }
  async respondDecision(decisionId, response) {
    const action = typeof response === 'string'
      ? response
      : response?.action || response?.optionId
    const verdict = action === 'allow' || action === 'allow_once'
      ? 'allow'
      : action === 'deny'
        ? 'deny'
        : null
    if (verdict && this.engine?.respondApproval(this.session.id, decisionId, verdict)) {
      return { accepted: true }
    }
    return { accepted: false, reason: 'unsupported' }
  }
  getLatestPlanSnapshot(_decisionId) {
    return null
  }
  getLatestResultSnapshot(_turnId) {
    return null
  }
  async interrupt() {
    throw new Error(`${this.id}: interrupt() not implemented`)
  }
  async resume(_cliSessionId) {
    throw new Error(`${this.id}: resume() not implemented`)
  }
  async dispose() {
    this._disposed = true
    this.removeAllListeners()
  }

  /** Emit a normalized event to the orchestrator. */
  emitEvent(event) {
    if (this._disposed) return
    this.emit('event', { ...event, sessionId: this.session.id, ts: Date.now() })
  }

  /** Emit a Gateway-only lifecycle event that never enters the terminal stream. */
  emitGatewayEvent(event) {
    if (this._disposed) return
    const normalized = validateGatewayEvent({
      ...event,
      sessionId: this.session.id,
      occurredAt: event.occurredAt ?? Date.now()
    })
    this.emit('gateway-event', normalized)
  }

  /**
   * Ask the permission engine for a decision on a tool call.
   * Resolves to { verdict: 'allow'|'deny', reason }. The engine handles
   * surfacing to the UI and awaiting the user when the tier requires it.
   * @param {{ tool: string, input: object, cwd?: string, command?: string }} input
   */
  async decide(input) {
    return this.engine.decide(this.session.id, input)
  }
}

/**
 * @typedef {Object} AdapterDescriptor
 * @property {string} id
 * @property {string} displayName
 * @property {string} icon     emoji or short glyph for the card
 * @property {string[]} models suggested models
 * @property {{ surface: 'terminal'|'web', permissionOwner: 'ucli'|'native', historyOwner: 'ucli'|'native', statsOwner: 'ucli'|'native', gateway: boolean, bridge: boolean }=} capabilities
 * @property {(input: unknown) => object=} normalizeSessionConfig
 * @property {(opts: { session: object, engine: object, settings: object }) => BaseAdapter} create
 */
