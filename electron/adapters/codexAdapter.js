import { readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { BaseAdapter } from './cliAdapter.js'
import {
  findCodexTranscriptFileInHome,
  isSafeProviderName,
  listCodexTranscriptSessionsInHome,
  readCodexSessionMetadataFromFile,
  resolveCodexTranscriptSessionInHome
} from '../sessionDiscovery.js'
import { resolveCodexHome } from '../codexRuntimeConfig.js'
import {
  encodeCodexDecisionResponse,
  extractCodexPlanSnapshot,
  extractCodexResultSnapshot,
  parseCodexGatewayState
} from './codexGatewayParser.js'

const DISPLAY_NAME = 'Codex'
const STATS_IDLE_DELAY_MS = 2000
const STATS_MAX_WAIT_MS = 30000
const STATS_FALLBACK_INTERVAL_MS = 30000
const LINEAGE_SCAN_INTERVAL_MS = 30000
const NATIVE_RESUME_CAPTURE_TTL_MS = 60 * 1000
const ICON = '🟢'
const OSC9_PREFIX = '\x1b]9;'

const require = createRequire(import.meta.url)
let pty
try { pty = require('node-pty') } catch (err) {
  console.error('Failed to load node-pty for codex:', err.message)
}

export function parseCodexTranscriptStats(lines) {
  let cliSessionId = null
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let contextWindow = null
  let turnsCount = 0
  let completedTurnsCount = 0
  let lastModel = null

  for (const line of lines) {
    let obj
    try { obj = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }

    if (obj.type === 'session_meta' && obj.payload) {
      cliSessionId = cliSessionId || obj.payload.id || obj.payload.session_id || null
      lastModel = obj.payload.model || obj.payload.model_provider || lastModel
      continue
    }

    if (obj.type === 'turn_context' && obj.payload?.model) {
      lastModel = obj.payload.model
    }

    if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
      const info = obj.payload.info || {}
      const total = info.total_token_usage || info.totalTokenUsage || {}
      inputTokens = total.input_tokens || total.inputTokens || inputTokens
      outputTokens = total.output_tokens || total.outputTokens || outputTokens
      cachedInputTokens = total.cached_input_tokens || total.cachedInputTokens || cachedInputTokens
      reasoningOutputTokens = total.reasoning_output_tokens || total.reasoningOutputTokens || reasoningOutputTokens
      totalTokens = total.total_tokens || total.totalTokens || totalTokens
      contextWindow = info.model_context_window || info.modelContextWindow || contextWindow
      continue
    }

    if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
      completedTurnsCount += 1
      continue
    }

    if (obj.usage) {
      inputTokens = Math.max(inputTokens, obj.usage.input_tokens || obj.usage.inputTokens || 0)
      outputTokens = Math.max(outputTokens, obj.usage.output_tokens || obj.usage.outputTokens || 0)
    }

    if (obj.role === 'user' || obj.type === 'user_message') {
      turnsCount += 1
    } else if (obj.type === 'response_item' && obj.payload?.role === 'user') {
      turnsCount += 1
    }
  }

  return {
    cliSessionId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens,
    contextWindow,
    turnsCount,
    completedTurnsCount,
    lastModel
  }
}

function trailingPrefixFragment(text) {
  const max = Math.min(text.length, OSC9_PREFIX.length - 1)
  for (let length = max; length > 0; length--) {
    const suffix = text.slice(-length)
    if (OSC9_PREFIX.startsWith(suffix)) return suffix
  }
  return ''
}

export function consumeOsc9Notifications(pending, chunk) {
  const text = String(pending || '') + String(chunk || '')
  const messages = []
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(OSC9_PREFIX, cursor)
    if (start < 0) {
      return { pending: trailingPrefixFragment(text.slice(cursor)), messages }
    }
    const bodyStart = start + OSC9_PREFIX.length
    const bellEnd = text.indexOf('\x07', bodyStart)
    const stringEnd = text.indexOf('\x1b\\', bodyStart)
    let end = -1
    let terminatorLength = 1
    if (bellEnd >= 0 && (stringEnd < 0 || bellEnd < stringEnd)) {
      end = bellEnd
    } else if (stringEnd >= 0) {
      end = stringEnd
      terminatorLength = 2
    }
    if (end < 0) {
      return { pending: text.slice(start, start + 2048), messages }
    }
    const message = text.slice(bodyStart, end).trim()
    if (message) messages.push(message)
    cursor = end + terminatorLength
  }

  return { pending: '', messages }
}

export function classifyCodexTerminalNotification(message) {
  if (message.startsWith('Approval requested:')) {
    return { kind: 'approval', operation: '执行命令' }
  }
  if (message.startsWith('Codex wants to edit')) {
    return { kind: 'approval', operation: '修改文件' }
  }
  if (message.startsWith('Plan mode prompt:')) {
    return { kind: 'approval', operation: '确认执行方案' }
  }
  if (message.startsWith('Approval requested by')) {
    return { kind: 'approval', operation: '外部工具确认' }
  }
  return { kind: 'complete', operation: '任务完成' }
}

export function buildCodexArgs(session) {
  const args = [
    '--no-alt-screen',
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"'
  ]
  if (session.cliSessionId) args.push('resume', session.cliSessionId)
  const providerOverride = session.providerPolicy === 'live'
    ? null
    : (session.providerOverride ?? session.provider)
  if (providerOverride && isSafeProviderName(providerOverride)) {
    args.push('-c', `model_provider=${providerOverride}`)
  }
  if (session.model) args.push('--model', session.model)
  return args
}

function transcriptText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        return part.text || part.content || part.message || ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

function gatewayEventKey(event) {
  if (event?.type === 'decision_required' && event.decision?.decisionId) {
    return `${event.type}:${event.decision.decisionId}`
  }
  if (event?.turnId) return `${event.type}:${event.turnId}`
  return null
}

/**
 * CodexAdapter — PTY terminal mode, like ClaudeAdapter.
 *
 * Spawns `codex` interactively via node-pty. Output goes directly to xterm.js.
 * User types directly in the terminal. Permissions are handled by codex's
 * built-in approval prompts in the TUI.
 */
export class CodexAdapter extends BaseAdapter {
  constructor({ session, engine, settings }) {
    super({ id: 'codex', displayName: DISPLAY_NAME, session, engine })
    this.hookPort = settings.hookPort
    this.codexHome = settings.codexHome || resolveCodexHome()
    this.ptyProc = null
    this._settingsDir = null
    this._statsTimer = null
    this._statsMaxTimer = null
    this._statsFallbackTimer = null
    this._transcriptPath = null
    this._lastStatsScanAt = 0
    this._lastStatsTokens = { input: 0, output: 0 }
    this._lastModel = null
    this._lastCompletedTurns = -1
    this._startedAt = Date.now()
    this._lastLineageScanAt = 0
    this._sessionResolver = settings.codexSessionResolver || resolveCodexTranscriptSessionInHome
    this._sessionLister = settings.codexSessionLister || listCodexTranscriptSessionsInHome
    this._terminalInputLine = ''
    this._nativeResumeCapture = null
    this._osc9Pending = ''
    this._gatewayCursor = 0
    this._gatewayDecision = null
    this._gatewayRespondedDecisions = new Set()
    this._gatewaySeenEventKeys = new Set()
  }

  _findTranscript(cliSessionId) {
    return resolveCodexTranscriptSessionInHome(this.codexHome, cliSessionId)?.path || null
  }

  _captureNativeResumeSelection() {
    try {
      const knownSessionIds = new Set(
        this._sessionLister(this.codexHome, this.session.cwd).map((item) => item.sessionId)
      )
      const startedAt = Date.now()
      this._nativeResumeCapture = {
        knownSessionIds,
        startedAt,
        expiresAt: startedAt + NATIVE_RESUME_CAPTURE_TTL_MS
      }
    } catch {
      this._nativeResumeCapture = null
    }
  }

  _observeTerminalInput(data) {
    const input = String(data || '')
    if ((input === '\x1b' || input === '\x03') && this._nativeResumeCapture) {
      this._nativeResumeCapture = null
    }
    for (const char of input) {
      if (char === '\r' || char === '\n') {
        if (this._terminalInputLine.trim() === '/resume') this._captureNativeResumeSelection()
        this._terminalInputLine = ''
      } else if (char === '\x7f' || char === '\b') {
        this._terminalInputLine = this._terminalInputLine.slice(0, -1)
      } else if (char >= ' ' && char !== '\x7f') {
        this._terminalInputLine = (this._terminalInputLine + char).slice(-64)
      }
    }
  }

  _resolveCapturedNativeResume(now) {
    const capture = this._nativeResumeCapture
    if (!capture) return null
    if (now > capture.expiresAt) {
      this._nativeResumeCapture = null
      return null
    }
    const candidates = this._sessionLister(this.codexHome, this.session.cwd)
      .filter((item) => !capture.knownSessionIds.has(item.sessionId))
      .filter((item) => (item.startedAt || 0) >= capture.startedAt - 2000)
      .filter((item) => item.forkedFromId && capture.knownSessionIds.has(item.forkedFromId))
    if (candidates.length !== 1) return null
    this._nativeResumeCapture = null
    return this._sessionResolver(this.codexHome, candidates[0].sessionId)
  }

  _syncTranscriptBinding({ force = false } = {}) {
    const currentId = this.session.cliSessionId
    if (!currentId) return null
    const now = Date.now()
    let resolved = this._resolveCapturedNativeResume(now)
    if (!resolved) {
      if (!force && now - this._lastLineageScanAt < LINEAGE_SCAN_INTERVAL_MS) {
        return this._transcriptPath
      }
      this._lastLineageScanAt = now
      resolved = this._sessionResolver(this.codexHome, currentId)
    }
    if (!resolved) return null
    if (resolved.path !== this._transcriptPath) {
      const previousPath = this._transcriptPath
      if (resolved.forkedFromId) {
        const ancestorPath = findCodexTranscriptFileInHome(this.codexHome, resolved.forkedFromId)
        if (ancestorPath && ancestorPath !== previousPath) this._rememberGatewayHistory(ancestorPath)
      }
      this._transcriptPath = resolved.path
      if (previousPath) this._gatewayCursor = 0
    }
    if (resolved.sessionId !== currentId) {
      this.session.cliSessionId = resolved.sessionId
      this.emitEvent({ type: 'init', cliSessionId: resolved.sessionId })
    }
    return resolved.path
  }

  _findLatestTranscript() {
    const sessionsDir = join(this.codexHome, 'sessions')
    if (!existsSync(sessionsDir)) return null
    const normCwd = (this.session.cwd || '').replace(/\\/g, '/').toLowerCase()
    let newest = null
    let newestMtime = 0
    for (const year of readdirSync(sessionsDir)) {
      const yDir = join(sessionsDir, year)
      let months; try { months = readdirSync(yDir) } catch { continue }
      for (const month of months) {
        const mDir = join(yDir, month)
        let days; try { days = readdirSync(mDir) } catch { continue }
        for (const day of days) {
          const dDir = join(mDir, day)
          let files; try { files = readdirSync(dDir) } catch { continue }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue
            const full = join(dDir, f)
            let stat
            try { stat = statSync(full) } catch { continue }
            if (stat.mtimeMs < this._startedAt - 10000 || stat.mtimeMs < newestMtime) continue
            try {
              const meta = readCodexSessionMetadataFromFile(full)
              const metaCwd = (meta?.cwd || '').replace(/\\/g, '/').toLowerCase()
              if (meta && !meta.isSubagent && metaCwd === normCwd) {
                newest = full
                newestMtime = stat.mtimeMs
              }
            } catch { /* skip */ }
          }
        }
      }
    }
    return newest
  }

  _replayHistory() {
    const cliSessionId = this.session.cliSessionId
    if (!cliSessionId) return
    const path = this._transcriptPath || this._findTranscript(cliSessionId)
    if (!path) {
      this._write('\x1b[90m(未找到 Codex 历史记录)\x1b[0m\r\n\r\n')
      return
    }
    this._transcriptPath = path
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      this._write('\x1b[90m━━━ Codex 历史记录 ━━━\x1b[0m\r\n\r\n')
      for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        this._formatEvent(obj)
      }
      this._write('\x1b[90m━━━ 历史结束 ━━━\x1b[0m\r\n\r\n')
    } catch {
      this._write('\x1b[90m(读取 Codex 历史失败)\x1b[0m\r\n\r\n')
    }
  }

  _formatEvent(obj) {
    if (!obj || !obj.type) return
    // Session meta
    if (obj.type === 'session_meta' && obj.payload) {
      const p = obj.payload
      this._write(`\x1b[44m\x1b[1m Codex \x1b[0m \x1b[90msession: ${(p.session_id||p.id||'').slice(0,8)}\x1b[0m\r\n`)
      this._write(`\x1b[90mcwd: ${p.cwd||'—'}  ·  cli: ${p.cli_version||'—'}\x1b[0m\r\n\r\n`)
      return
    }
    // Current Codex JSONL nests transcript records in response_item/event_msg
    // payloads. Normalize them before rendering so replay mirrors resume.
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null
    const message = obj.type === 'response_item' && payload?.type === 'message'
      ? { role: payload.role, content: payload.content }
      : obj.type === 'event_msg' && payload?.type === 'user_message'
        ? { role: 'user', content: payload.message || payload.content }
        : obj.type === 'event_msg' && (payload?.type === 'assistant_message' || payload?.type === 'agent_message')
          ? { role: 'assistant', content: payload.message || payload.content }
          : { role: obj.role, content: obj.content, type: obj.type }

    // User messages
    if (message.role === 'user' || message.type === 'user_message') {
      const text = transcriptText(message.content)
      this._write(`\x1b[32m> ${text}\x1b[0m\r\n\r\n`)
      return
    }
    // Assistant messages
    if (message.role === 'assistant' || message.type === 'assistant_message') {
      const text = transcriptText(message.content)
      for (const l of text.split('\n')) this._write(`\x1b[36m│\x1b[0m ${l}\r\n`)
      this._write('\r\n')
      return
    }
    // Tool calls
    if (obj.type === 'tool_call' || obj.type === 'function_call') {
      const name = obj.name || obj.function?.name || '?'
      const args = obj.arguments || obj.function?.arguments || ''
      this._write(`\x1b[43m\x1b[1m tool \x1b[0m \x1b[33m${name}\x1b[0m \x1b[90m${typeof args === 'string' ? args.slice(0, 80) : ''}\x1b[0m\r\n`)
      return
    }
    // Tool results
    if (obj.type === 'tool_result') {
      const pf = obj.is_error ? '\x1b[41m error \x1b[0m' : '\x1b[42m\x1b[1m done \x1b[0m'
      const txt = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
      this._write(`${pf} \x1b[90m${(txt||'').slice(0, 200)}\x1b[0m\r\n`)
      return
    }
  }

  _write(text) {
    const parsed = consumeOsc9Notifications(this._osc9Pending, text)
    this._osc9Pending = parsed.pending
    for (const message of parsed.messages) {
      this.emitEvent({
        type: 'attention',
        ...classifyCodexTerminalNotification(message)
      })
    }
    this.emitEvent({ type: 'terminal', data: text })
    this._scheduleStatsUpdate()
  }

  _scheduleStatsUpdate() {
    if (this._statsTimer) clearTimeout(this._statsTimer)
    this._statsTimer = setTimeout(() => this._runStatsUpdate(), STATS_IDLE_DELAY_MS)
    if (!this._statsMaxTimer) {
      this._statsMaxTimer = setTimeout(() => this._runStatsUpdate(), STATS_MAX_WAIT_MS)
    }
  }

  _runStatsUpdate() {
    if (this._statsTimer) clearTimeout(this._statsTimer)
    if (this._statsMaxTimer) clearTimeout(this._statsMaxTimer)
    this._statsTimer = null
    this._statsMaxTimer = null
    this._extractStats()
  }

  _startStatsFallback() {
    if (this._statsFallbackTimer) clearInterval(this._statsFallbackTimer)
    this._statsFallbackTimer = setInterval(() => {
      if (Date.now() - this._lastStatsScanAt >= STATS_FALLBACK_INTERVAL_MS) {
        this._extractStats()
      }
    }, STATS_FALLBACK_INTERVAL_MS)
    this._statsFallbackTimer.unref?.()
  }

  _extractStats() {
    this._lastStatsScanAt = Date.now()
    let path = this._syncTranscriptBinding() || this._transcriptPath
    const cliSessionId = this.session.cliSessionId
    if (path && !existsSync(path)) {
      path = null
      this._transcriptPath = null
    }
    if (!path) path = cliSessionId ? this._findTranscript(cliSessionId) : this._findLatestTranscript()
    if (!path) return
    this._transcriptPath = path
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      this._scanGatewayState(lines)
      const stats = parseCodexTranscriptStats(lines)
      if (stats.cliSessionId && stats.cliSessionId !== this.session.cliSessionId) {
        this.session.cliSessionId = stats.cliSessionId
        this.emitEvent({ type: 'init', cliSessionId: stats.cliSessionId, model: stats.lastModel })
      }
      const inputTokens = stats.inputTokens
      const outputTokens = stats.outputTokens
      if (
        inputTokens !== this._lastStatsTokens.input ||
        outputTokens !== this._lastStatsTokens.output ||
        stats.lastModel !== this._lastModel ||
        stats.completedTurnsCount !== this._lastCompletedTurns
      ) {
        this._lastStatsTokens = { input: inputTokens, output: outputTokens }
        this._lastModel = stats.lastModel
        this._lastCompletedTurns = stats.completedTurnsCount
        this.emitEvent({
          type: 'stats_update',
          usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens: stats.cachedInputTokens,
            reasoningOutputTokens: stats.reasoningOutputTokens,
            totalTokens: stats.totalTokens
          },
          costUsd: 0,
          turns: stats.turnsCount,
          completedTurns: stats.completedTurnsCount,
          model: stats.lastModel,
          contextWindow: stats.contextWindow
        })
      }
    } catch { /* ignore */ }
  }

  _scanGatewayState(lines) {
    const state = parseCodexGatewayState(lines, this._gatewayCursor)
    this._gatewayCursor = state.cursor
    if (state.nativeSessionId && !this.session.cliSessionId) {
      this.session.cliSessionId = state.nativeSessionId
      this.emitEvent({ type: 'init', cliSessionId: state.nativeSessionId })
    }
    this._gatewayDecision = state.currentDecision &&
      !this._gatewayRespondedDecisions.has(state.currentDecision.decisionId)
      ? state.currentDecision
      : null
    for (const event of state.events) {
      const key = gatewayEventKey(event)
      if (key && this._gatewaySeenEventKeys.has(key)) continue
      if (key) this._gatewaySeenEventKeys.add(key)
      this.emitGatewayEvent(event)
    }
  }

  _gatewayTranscriptLines() {
    let path = this._transcriptPath
    if (!path) {
      path = this.session.cliSessionId
        ? this._findTranscript(this.session.cliSessionId)
        : this._findLatestTranscript()
    }
    if (!path) return []
    try {
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  _primeGatewayCursor() {
    if (!this.session.cliSessionId) return
    const lines = this._gatewayTranscriptLines()
    this._rememberGatewayEvents(lines)
    this._gatewayCursor = lines.length
  }

  _rememberGatewayEvents(lines) {
    for (const event of parseCodexGatewayState(lines).events) {
      const key = gatewayEventKey(event)
      if (key) this._gatewaySeenEventKeys.add(key)
    }
  }

  _rememberGatewayHistory(path) {
    try {
      this._rememberGatewayEvents(readFileSync(path, 'utf8').split('\n').filter(Boolean))
    } catch { /* a missing ancestor must not block terminal resume */ }
  }

  get gatewayCapabilities() {
    return {
      decisions: true,
      planSnapshot: true,
      resultSnapshot: true
    }
  }

  getDecisionContext() {
    if (this._gatewayDecision) return structuredClone(this._gatewayDecision)
    const state = parseCodexGatewayState(this._gatewayTranscriptLines())
    if (
      state.currentDecision &&
      !this._gatewayRespondedDecisions.has(state.currentDecision.decisionId)
    ) {
      this._gatewayDecision = state.currentDecision
      return structuredClone(state.currentDecision)
    }
    return null
  }

  getLatestPlanSnapshot(decisionId) {
    return extractCodexPlanSnapshot(this._gatewayTranscriptLines(), decisionId)
  }

  getLatestResultSnapshot(turnId) {
    return extractCodexResultSnapshot(this._gatewayTranscriptLines(), turnId)
  }

  async respondDecision(decisionId, response) {
    const permission = await super.respondDecision(decisionId, response)
    if (permission.accepted) return permission

    const decision = this.getDecisionContext()
    if (!decision || decision.decisionId !== decisionId) {
      return { accepted: false, reason: 'already_resolved' }
    }
    const inputs = encodeCodexDecisionResponse(decision, response)
    if (!inputs) return { accepted: false, reason: 'invalid_response' }
    for (const input of inputs) {
      if (!this.writeInput(input)) return { accepted: false, reason: 'not_ready' }
    }
    this._gatewayRespondedDecisions.add(decisionId)
    this._gatewayDecision = null
    return { accepted: true }
  }

  /** Public: replay transcript history to the terminal. */
  replayHistory() {
    this._replayHistory()
  }

  async start() {
    this._disposed = false
    this._startedAt = Date.now()
    this._gatewaySeenEventKeys.clear()
    this._syncTranscriptBinding({ force: true })
    this._primeGatewayCursor()
    if (!pty) {
      this._write('\x1b[31mnode-pty 未加载，无法启动 Codex 终端模式\x1b[0m\r\n')
      this.emitEvent({ type: 'error', message: 'node-pty not available' })
      return
    }

    this._replayHistory()

    // Codex uses the `resume` subcommand. A provider override is persisted by
    // UCLI when the historical provider no longer exists in current config.
    const args = buildCodexArgs(this.session)

    const env = {
      ...process.env,
      CODEX_HOME: this.codexHome,
      UCLI_SESSION_ID: this.session.id,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }

    try {
      // Use cmd.exe to resolve the codex.cmd shim on Windows
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'codex'
      const shellArgs = process.platform === 'win32'
        ? ['/c', 'codex', ...args]
        : args

      this.ptyProc = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.session.cwd,
        env
      })

      this.ptyProc.onData((data) => {
        this._write(data)
      })

      this.ptyProc.onExit(({ exitCode }) => {
        this._write(`\r\n\x1b[90mCodex process exited (code ${exitCode})\x1b[0m\r\n`)
        this.emitEvent({ type: 'exit', code: exitCode })
        this.emitGatewayEvent({
          type: 'session_stopped',
          occurredAt: Date.now(),
          exitCode
        })
      })

      this._startStatsFallback()

      this.emitEvent({
        type: 'stats_update',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        turns: 0,
        model: this.session.model || null
      })
      this.emitEvent({ type: 'ready' })
    } catch (err) {
      this._write(`\x1b[31mCodex PTY spawn failed: ${err?.message}\x1b[0m\r\n`)
      this.emitEvent({ type: 'error', message: 'Codex PTY spawn failed: ' + (err?.message || String(err)) })
    }
  }

  writeInput(data) {
    if (this.ptyProc) {
      try {
        this._observeTerminalInput(data)
        this.ptyProc.write(data)
        return true
      } catch {}
    }
    return false
  }

  resize(cols, rows) {
    if (this.ptyProc) {
      try { this.ptyProc.resize(cols, rows) } catch {}
    }
  }

  async sendTurn(text) {
    this.writeInput(text + '\r')
  }

  async interrupt() {
    this.writeInput('\x03')
  }

  async resume(cliSessionId) {
    // Codex resumes through the `resume <thread-id>` startup form.
    if (cliSessionId) this.session.cliSessionId = cliSessionId
    this._nativeResumeCapture = null
    this._terminalInputLine = ''
    this._lastLineageScanAt = 0
    await this.dispose()
    this._transcriptPath = null
    this._gatewayCursor = 0
    await this.start()
  }

  async dispose() {
    this._disposed = true
    if (this._statsTimer) clearTimeout(this._statsTimer)
    if (this._statsMaxTimer) clearTimeout(this._statsMaxTimer)
    if (this._statsFallbackTimer) clearInterval(this._statsFallbackTimer)
    this._statsTimer = null
    this._statsMaxTimer = null
    this._statsFallbackTimer = null
    this._osc9Pending = ''
    this._gatewayDecision = null
    this._nativeResumeCapture = null
    this._terminalInputLine = ''
    if (this.ptyProc) {
      try { this.ptyProc.kill() } catch {}
      this.ptyProc = null
    }
    if (this._settingsDir) {
      rmSync(this._settingsDir, { recursive: true, force: true })
      this._settingsDir = null
    }
    super.dispose()
  }
}

export const codexDescriptor = {
  id: 'codex',
  displayName: DISPLAY_NAME,
  icon: ICON,
  models: ['default', 'gpt-5', 'gpt-5.1', 'gpt-5.5'],
  listNativeSessions: (cwd) => {
    return listCodexTranscriptSessionsInHome(resolveCodexHome(), cwd)
  },
  create: (opts) => new CodexAdapter(opts)
}
