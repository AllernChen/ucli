import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { BaseAdapter } from './cliAdapter.js'
import { findClaudeProjectDirectory, isSafeNativeSessionId } from '../sessionDiscovery.js'
import { buildClaudeProfileArgs } from '../aiCliProfiles/claudeProfileAdapter.js'
import {
  encodeClaudeDecisionResponse,
  extractClaudePlanSnapshot,
  extractClaudeResultSnapshot,
  parseClaudeGatewayState
} from './claudeGatewayParser.js'

const DISPLAY_NAME = 'Claude Code'
const ICON = '🟣'
const STATS_IDLE_DELAY_MS = 2000
const STATS_MAX_WAIT_MS = 30000
const STATS_FALLBACK_INTERVAL_MS = 30000

// sendTurn 投递确认：PTY 模式下 prompt 是"像人一样打字"注入的，若在 TUI 初始化
// 完成前写入（cmd shim + hook settings 加载会让首次启动慢于 spawn-ready），输入
// 会被整个丢弃，CLI 会永远停在输入框。为确认 prompt 真的被 TUI 接收，我们轮询
// 会话产物目录的 transcript，找一条晚于本轮起点的 user 记录且其内容包含 prompt
// 指纹；窗口内未确认则先提交一次、双 Escape 清除陈旧提示，再重打一次。
const TURN_DELIVERY_WINDOW_MS = 8000
const TURN_RETYPE_SETTLE_MS = 500
const TURN_DELIVERY_POLL_MS = 400
const TURN_FINGERPRINT_LENGTH = 40

// 生成 prompt 的投递指纹：折叠空白后取前 N 字符。transcript 中 user 记录的内容
// 是逐字打进去的文本，折叠空白后应包含该指纹。
export function makeTurnFingerprint(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TURN_FINGERPRINT_LENGTH)
}

// 从 user 记录中提取其内容文本（兼容内容块数组与纯字符串两种形态）。
export function userEntryText(obj) {
  const content = obj?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .join(' ')
  }
  if (typeof obj?.content === 'string') return obj.content
  return ''
}

// 判定 transcript 中是否存在一条晚于 sinceMs 的 user 记录，其内容（折叠空白后）
// 包含给定指纹。path 为 transcript jsonl 的绝对路径。
export function transcriptHasUserTurn(path, fingerprint, sinceMs) {
  if (!path || !fingerprint || typeof sinceMs !== 'number') return false
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj?.type !== 'user') continue
      if (obj?.timestamp) {
        const ts = Date.parse(obj.timestamp)
        if (Number.isFinite(ts) && ts < sinceMs) continue
      }
      if (userEntryText(obj).replace(/\s+/g, ' ').trim().includes(fingerprint)) return true
    }
  } catch { /* transcript read failed, treat as not-delivered */ }
  return false
}

// node-pty is a CJS native module — use createRequire in ESM context
const require = createRequire(import.meta.url)
let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.error('Failed to load node-pty:', err.message)
}

export function parseClaudeTranscriptStats(lines) {
  let inputTokens = 0
  let outputTokens = 0
  let turnsCount = 0
  let completedTurnsCount = 0
  let costUsd = 0
  let lastModel = null
  const modelUsageMap = {}

  for (const line of lines) {
    let obj
    try { obj = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }
    if (obj.type === 'assistant' && obj.message?.usage) {
      const usage = obj.message.usage
      inputTokens +=
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0)
      outputTokens += usage.output_tokens || 0
    }
    if (obj.type === 'assistant' && obj.message?.model) {
      lastModel = obj.message.model
    }
    if (obj.type === 'assistant' && obj.message?.stop_reason === 'end_turn') {
      completedTurnsCount += 1
    }
    if (obj.type === 'user' && userEntryText(obj).trim()) {
      turnsCount += 1
    }
    if (obj.type === 'result') {
      if (obj.total_cost_usd) costUsd = Math.max(costUsd, obj.total_cost_usd)
      if (obj.num_turns) turnsCount = Math.max(turnsCount, obj.num_turns)
      if (obj.modelUsage) {
        for (const [model, mu] of Object.entries(obj.modelUsage)) {
          if (!modelUsageMap[model]) modelUsageMap[model] = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
          modelUsageMap[model].inputTokens += mu.inputTokens || 0
          modelUsageMap[model].outputTokens += mu.outputTokens || 0
          if (mu.costUSD) modelUsageMap[model].costUsd = Math.max(modelUsageMap[model].costUsd, mu.costUSD)
          lastModel = model
        }
      }
    }
  }

  const modelBreakdown = Object.entries(modelUsageMap).map(([model, mu]) => ({
    model,
    inputTokens: mu.inputTokens,
    outputTokens: mu.outputTokens,
    costUsd: mu.costUsd
  }))
  if (modelBreakdown.length) {
    inputTokens = modelBreakdown.reduce((sum, m) => sum + m.inputTokens, 0)
    outputTokens = modelBreakdown.reduce((sum, m) => sum + m.outputTokens, 0)
  }
  return { inputTokens, outputTokens, turnsCount, completedTurnsCount, costUsd, lastModel, modelBreakdown }
}

export function buildClaudeSettings(hookRunnerPath) {
  const cmd = `node "${hookRunnerPath}"`
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }]
    },
    permissions: {
      deny: [
        'Bash(rm -rf /:*)', 'Bash(rm -rf /*:*)', 'Bash(rm -rf ~:*)',
        'Bash(rm -rf $HOME:*)', 'Bash(mkfs:*)', 'Bash(format C:*)', 'Bash(shutdown:*)'
      ]
    }
  }
}

export function buildClaudeAdapterLaunch({
  session,
  settingsFile,
  hookPort,
  baseEnv = process.env,
  profileLaunch = null
}) {
  const profileArgs = profileLaunch?.args || buildClaudeProfileArgs({ session })
  const settingSources = Array.isArray(profileLaunch?.settingSources)
    ? [...new Set(profileLaunch.settingSources.filter((source) => ['project', 'local'].includes(source)))]
    : []
  return {
    args: [
      '--permission-mode', 'default',
      '--settings', settingsFile,
      ...(settingSources.length ? ['--setting-sources', settingSources.join(',')] : []),
      ...profileArgs
    ],
    env: {
      ...(profileLaunch?.env || baseEnv),
      UCLI_HOOK_PORT: String(hookPort ?? ''),
      UCLI_SESSION_ID: session.id,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  }
}

/**
 * ClaudeAdapter — PTY terminal mode.
 *
 * Uses node-pty to spawn claude in a real pseudo-terminal. Output goes
 * directly to xterm.js. User types directly in the terminal (including
 * slash commands like /help, /compact, etc.). ESC sends Ctrl+C.
 *
 * Before spawning, replays transcript history so the user sees the
 * full conversation like `claude --resume` in a real terminal.
 */
export class ClaudeAdapter extends BaseAdapter {
  constructor({ session, engine, settings }) {
    super({ id: 'claude', displayName: DISPLAY_NAME, session, engine })
    this.hookRunnerPath = settings.hookRunnerPath
    this.hookPort = settings.hookPort
    this.profileLaunch = settings.profileLaunch || null
    this.ptyProc = null
    this._settingsDir = null
    this._statsTimer = null
    this._statsMaxTimer = null
    this._statsFallbackTimer = null
    this._lastStatsScanAt = 0
    this._lastStatsTokens = { input: 0, output: 0 }
    this._lastModel = null
    this._lastCompletedTurns = -1
    this._gatewayCursor = 0
    this._gatewayDecision = null
    this._gatewayRespondedDecisions = new Set()
  }

  setProfileLaunch(profileLaunch) {
    if (this.ptyProc) return false
    this.profileLaunch = profileLaunch || null
    return true
  }

  /** Shared: return the matched ~/.claude/projects/<hash> directory, or null. */
  _projectDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    return findClaudeProjectDirectory(home, this.session.cwd)
  }

  _findTranscript(cliSessionId) {
    const dir = this._projectDir()
    if (!dir) return null
    const exact = join(dir, cliSessionId + '.jsonl')
    return existsSync(exact) ? exact : null
  }

  /** Find the most recent transcript in the project directory (for new sessions without cliSessionId) */
  _findLatestTranscript() {
    const dir = this._projectDir()
    if (!dir) return null
    let newest = null, newestMtime = 0
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const full = join(dir, f)
        const stat = statSync(full)
        if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = full }
      } catch {}
    }
    return newest
  }

  /** Public: replay transcript history to the terminal. Called when a
   *  running session is attached to a new pane. */
  replayHistory() {
    this._replayHistory()
  }

  _replayHistory() {
    const cliSessionId = this.session.cliSessionId
    if (!cliSessionId) return
    const path = this._findTranscript(cliSessionId)
    if (!path) {
      this._write('\x1b[90m(未找到历史记录)\x1b[0m\r\n\r\n')
      return
    }
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      this._write('\x1b[90m━━━ 历史记录 ━━━\x1b[0m\r\n\r\n')
      for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        this._formatEvent(obj)
      }
      this._write('\x1b[90m━━━ 历史结束 ━━━\x1b[0m\r\n\r\n')
    } catch {
      this._write('\x1b[90m(读取历史失败)\x1b[0m\r\n\r\n')
    }
  }

  _write(text) {
    this.emitEvent({ type: 'terminal', data: text })
    // Try to extract session_id from init output (for new sessions where cliSessionId is null)
    if (!this.session.cliSessionId && text.includes('session_id')) {
      const m = text.match(/session[_-]id[:\s]+([0-9a-f-]{36})/i)
      if (m) {
        this.session.cliSessionId = m[1]
        this.emitEvent({ type: 'init', cliSessionId: m[1] })
      }
    }
    // Schedule a stats update from transcript after PTY output settles
    this._scheduleStatsUpdate()
  }

  /** Debounced: read transcript 2s after last PTY output to extract stats */
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
    const cliSessionId = this.session.cliSessionId
    // If no cliSessionId yet (new session), try to find the most recent transcript
    // in the project directory that matches our cwd
    let path = null
    if (cliSessionId) {
      path = this._findTranscript(cliSessionId)
    } else {
      path = this._findLatestTranscript()
    }
    if (!path) return
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      this._scanGatewayState(lines)
      const { inputTokens, outputTokens, turnsCount, completedTurnsCount, costUsd, lastModel, modelBreakdown } = parseClaudeTranscriptStats(lines)
      // Emit if stats or model changed
      if (
        inputTokens !== this._lastStatsTokens.input ||
        outputTokens !== this._lastStatsTokens.output ||
        lastModel !== this._lastModel ||
        completedTurnsCount !== this._lastCompletedTurns
      ) {
        this._lastStatsTokens = { input: inputTokens, output: outputTokens }
        this._lastModel = lastModel
        this._lastCompletedTurns = completedTurnsCount
        this.emitEvent({
          type: 'stats_update',
          usage: { inputTokens, outputTokens },
          costUsd,
          turns: turnsCount,
          completedTurns: completedTurnsCount,
          model: lastModel,
          modelBreakdown
        })
      }
    } catch { /* transcript read failed, ignore */ }
  }

  _scanGatewayState(lines) {
    const state = parseClaudeGatewayState(lines, this._gatewayCursor)
    this._gatewayCursor = state.cursor
    if (state.nativeSessionId && !this.session.cliSessionId) {
      this.session.cliSessionId = state.nativeSessionId
      this.emitEvent({ type: 'init', cliSessionId: state.nativeSessionId })
    }
    if (state.actualModel && state.actualModel !== this._lastModel) {
      this._lastModel = state.actualModel
      this.emitEvent({ type: 'profile-model', actualModel: state.actualModel })
    }
    this._gatewayDecision = state.currentDecision &&
      !this._gatewayRespondedDecisions.has(state.currentDecision.decisionId)
      ? state.currentDecision
      : null
    for (const event of state.events) {
      this.emitGatewayEvent(event)
    }
  }

  _gatewayTranscriptLines() {
    const path = this.session.cliSessionId
      ? this._findTranscript(this.session.cliSessionId)
      : this._findLatestTranscript()
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
    this._gatewayCursor = lines.length
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
    const state = parseClaudeGatewayState(this._gatewayTranscriptLines())
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
    return extractClaudePlanSnapshot(this._gatewayTranscriptLines(), decisionId)
  }

  getLatestResultSnapshot(turnId) {
    return extractClaudeResultSnapshot(this._gatewayTranscriptLines(), turnId)
  }

  async respondDecision(decisionId, response) {
    const permission = await super.respondDecision(decisionId, response)
    if (permission.accepted) return permission

    const decision = this.getDecisionContext()
    if (!decision || decision.decisionId !== decisionId) {
      return { accepted: false, reason: 'already_resolved' }
    }
    const inputs = encodeClaudeDecisionResponse(decision, response)
    if (!inputs) return { accepted: false, reason: 'invalid_response' }
    for (const input of inputs) {
      if (!this.writeInput(input)) return { accepted: false, reason: 'not_ready' }
    }
    this._gatewayRespondedDecisions.add(decisionId)
    this._gatewayDecision = null
    return { accepted: true }
  }

  _formatEvent(obj) {
    // Skip internal/system noise from the transcript
    if (!obj.type || obj.type === 'queue-operation' || obj.type === 'last-prompt') return
    if (obj.type === 'system' && obj.subtype !== 'init') return
    switch (obj.type) {
      case 'user': {
        for (const b of obj.message?.content || []) {
          if (b.type === 'text') this._write(`\x1b[32m> ${b.text}\x1b[0m\r\n\r\n`)
          else if (b.type === 'tool_result') {
            const pfx = b.is_error ? '\x1b[41m error \x1b[0m' : '\x1b[42m\x1b[1m done \x1b[0m'
            const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
            this._write(`${pfx} \x1b[90m${(txt || '').slice(0, 200)}\x1b[0m\r\n`)
          }
        }
        break
      }
      case 'assistant': {
        for (const b of obj.message?.content || []) {
          if (b.type === 'text') {
            for (const l of b.text.split('\n')) this._write(`\x1b[36m│\x1b[0m ${l}\r\n`)
            this._write('\r\n')
          } else if (b.type === 'tool_use') {
            this._write(`\x1b[43m\x1b[1m tool \x1b[0m \x1b[33m${b.name}\x1b[0m`)
            if (b.input?.command) this._write(` \x1b[90m${b.input.command}\x1b[0m`)
            else if (b.input?.file_path || b.input?.path) this._write(` \x1b[90m${b.input.file_path || b.input.path}\x1b[0m`)
            this._write('\r\n')
          }
        }
        break
      }
      case 'system':
        if (obj.subtype === 'init') {
          this._write(`\r\n\x1b[44m\x1b[1m Claude Code \x1b[0m \x1b[90msession: ${(obj.session_id||'').slice(0,8)}\x1b[0m\r\n`)
          this._write(`\x1b[90mmodel: ${obj.model||'—'}\x1b[0m\r\n\r\n`)
        }
        break
      case 'result': {
        if (obj.result) for (const l of obj.result.split('\n')) this._write(`\x1b[37m${l}\x1b[0m\r\n`)
        const u = obj.usage || {}
        const parts = []
        if (u.input_tokens) parts.push(`in:${u.input_tokens.toLocaleString()}`)
        if (u.output_tokens) parts.push(`out:${u.output_tokens.toLocaleString()}`)
        if (obj.total_cost_usd) parts.push(`$${obj.total_cost_usd.toFixed(4)}`)
        if (parts.length) this._write(`\x1b[90m${parts.join(' | ')}\x1b[0m\r\n`)
        this._write('\r\n')
        break
      }
    }
  }

  async start() {
    this._disposed = false
    if (!pty) {
      this._write('\x1b[31mnode-pty 未加载，无法启动终端模式\x1b[0m\r\n')
      this.emitEvent({ type: 'error', message: 'node-pty not available' })
      return
    }

    this._primeGatewayCursor()

    // Replay history before starting
    this._replayHistory()

    this._settingsDir = mkdtempSync(join(tmpdir(), 'ucli-claude-'))
    const settingsFile = join(this._settingsDir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(buildClaudeSettings(this.hookRunnerPath)))

    const { args, env } = buildClaudeAdapterLaunch({
      session: this.session,
      settingsFile,
      hookPort: this.hookPort,
      baseEnv: process.env,
      profileLaunch: this.profileLaunch
    })

    try {
      // On Windows, use cmd.exe to resolve the claude.cmd shim. Avoid
      // PowerShell — its -Command re-parsing can mangle paths with spaces.
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'claude'
      const shellArgs = process.platform === 'win32'
        ? ['/c', 'claude', ...args]
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
        this._write(`\r\n\x1b[90mprocess exited (code ${exitCode})\x1b[0m\r\n`)
        this.emitEvent({ type: 'exit', code: exitCode })
        this.emitGatewayEvent({
          type: 'session_stopped',
          occurredAt: Date.now(),
          exitCode
        })
      })

      this._startStatsFallback()

      // Emit initial empty stats so the UI shows 0 tokens / model
      this.emitEvent({
        type: 'stats_update',
        usage: { inputTokens: 0, outputTokens: 0 },
        synthetic: true,
        costUsd: 0,
        turns: 0,
        model: this.session.model || null
      })
      this.emitEvent({ type: 'ready' })
    } catch (err) {
      this._write(`\x1b[31mPTY spawn failed: ${err?.message}\x1b[0m\r\n`)
      this.emitEvent({ type: 'error', message: 'PTY spawn failed: ' + (err?.message || String(err)) })
    }
  }

  writeInput(data) {
    if (this.ptyProc) {
      try { this.ptyProc.write(data); return true } catch {}
    }
    return false
  }

  resize(cols, rows) {
    if (this.ptyProc) {
      try { this.ptyProc.resize(cols, rows) } catch {}
    }
  }

  /** Scan project transcripts for a user turn containing fingerprint, written after sinceMs. */
  _scanProjectTranscripts(fingerprint, sinceMs) {
    const dir = this._projectDir()
    if (!dir) return false
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        const full = join(dir, f)
        try {
          // 跳过自本轮起未变过的文件（全新 transcript 或追加都会更新 mtime）。
          if (statSync(full).mtimeMs < sinceMs) continue
        } catch { continue }
        if (transcriptHasUserTurn(full, fingerprint, sinceMs)) {
          if (!this.session.cliSessionId) {
            const nativeSessionId = basename(full, '.jsonl')
            if (isSafeNativeSessionId(nativeSessionId)) {
              this.session.cliSessionId = nativeSessionId
              this.emitEvent({ type: 'init', cliSessionId: nativeSessionId })
            }
          }
          return true
        }
      }
    } catch { /* scan failed, treat as not-delivered */ }
    return false
  }

  /** Poll transcripts until the typed prompt is recorded (delivery confirmed). */
  _waitTurnDelivered(fingerprint, sinceMs, timeoutMs = TURN_DELIVERY_WINDOW_MS) {
    return new Promise((resolve) => {
      const started = Date.now()
      const step = () => {
        if (this._disposed || !this.ptyProc) return resolve(false)
        if (this._scanProjectTranscripts(fingerprint, sinceMs)) return resolve(true)
        const elapsed = Date.now() - started
        if (elapsed >= timeoutMs) return resolve(false)
        setTimeout(step, Math.min(TURN_DELIVERY_POLL_MS, timeoutMs - elapsed))
      }
      step()
    })
  }

  async _confirmTurnDelivery(fingerprint, sinceMs, timeoutMs) {
    const delivered = await this._waitTurnDelivered(fingerprint, sinceMs, timeoutMs)
    if (delivered) this._extractStats()
    return delivered
  }

  /**
   * 注入一轮用户输入（PTY 打字模式）。为规避 TUI 未就绪时输入被整体丢弃的竞态，
   * 先按普通方式打入，随后确认 transcript 里出现了该 prompt 的 user 记录；未确认
   * 则先提交一次，再清除陈旧提示后重打一次，最后再提交一次。
   * 返回投递是否已确认。
   */
  async sendTurn(text) {
    if (!this.ptyProc) return false
    const fingerprint = makeTurnFingerprint(text)
    const sinceMs = Date.now()
    this.writeInput(text + '\r')
    if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)) return true
    this.writeInput('\r')
    if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)) return true
    this.writeInput('\x1b\x1b')
    this.writeInput(text + '\r')
    if (await this._confirmTurnDelivery(fingerprint, sinceMs, TURN_RETYPE_SETTLE_MS)) return true
    this.writeInput('\r')
    return this._confirmTurnDelivery(fingerprint, sinceMs, TURN_DELIVERY_WINDOW_MS)
  }

  async interrupt() {
    this.writeInput('\x03') // Ctrl+C
  }

  async resume(cliSessionId) {
    await this.dispose()
    this.session.cliSessionId = cliSessionId
    await this.start()
  }

  async dispose() {
    this._disposed = true
    if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }
    if (this._statsMaxTimer) { clearTimeout(this._statsMaxTimer); this._statsMaxTimer = null }
    if (this._statsFallbackTimer) { clearInterval(this._statsFallbackTimer); this._statsFallbackTimer = null }
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

export const claudeDescriptor = {
  id: 'claude',
  displayName: DISPLAY_NAME,
  icon: ICON,
  models: ['sonnet', 'opus', 'haiku', 'default'],
  create: (opts) => new ClaudeAdapter(opts)
}
