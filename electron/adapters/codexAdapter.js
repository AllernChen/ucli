import { readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { BaseAdapter } from './cliAdapter.js'
import { isSafeProviderName } from '../sessionDiscovery.js'

const DISPLAY_NAME = 'Codex'
const STATS_IDLE_DELAY_MS = 2000
const STATS_MAX_WAIT_MS = 30000
const STATS_FALLBACK_INTERVAL_MS = 30000
const ICON = '🟢'

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
  let lastModel = null

  for (const line of lines) {
    let obj
    try { obj = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }

    if (obj.type === 'session_meta' && obj.payload) {
      cliSessionId = obj.payload.session_id || obj.payload.id || cliSessionId
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
    lastModel
  }
}

export function buildCodexArgs(session) {
  const args = []
  if (session.cliSessionId) args.push('resume', session.cliSessionId)
  if (session.provider && isSafeProviderName(session.provider)) {
    args.push('-c', `model_provider=${session.provider}`)
  }
  if (session.model) args.push('--model', session.model)
  return args
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
    this.ptyProc = null
    this._settingsDir = null
    this._statsTimer = null
    this._statsMaxTimer = null
    this._statsFallbackTimer = null
    this._transcriptPath = null
    this._lastStatsScanAt = 0
    this._lastStatsTokens = { input: 0, output: 0 }
    this._lastModel = null
    this._startedAt = Date.now()
  }

  _findTranscript(cliSessionId) {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const sessionsDir = join(home, '.codex', 'sessions')
    if (!existsSync(sessionsDir)) return null
    // Walk year/month/day for the session file
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
            if (f.endsWith(cliSessionId + '.jsonl')) return join(dDir, f)
          }
        }
      }
    }
    return null
  }

  _findLatestTranscript() {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const sessionsDir = join(home, '.codex', 'sessions')
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
              const head = readFileSync(full, 'utf8').slice(0, 65536)
              const firstLine = head.slice(0, head.indexOf('\n') >= 0 ? head.indexOf('\n') : head.length)
              const meta = JSON.parse(firstLine)
              const metaCwd = (meta.payload?.cwd || '').replace(/\\/g, '/').toLowerCase()
              if (meta.type === 'session_meta' && metaCwd === normCwd) {
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
    // User messages
    if (obj.role === 'user' || obj.type === 'user_message') {
      const text = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
      this._write(`\x1b[32m> ${text}\x1b[0m\r\n\r\n`)
      return
    }
    // Assistant messages
    if (obj.role === 'assistant' || obj.type === 'assistant_message') {
      const text = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
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
    const cliSessionId = this.session.cliSessionId
    let path = this._transcriptPath
    if (path && !existsSync(path)) {
      path = null
      this._transcriptPath = null
    }
    if (!path) path = cliSessionId ? this._findTranscript(cliSessionId) : this._findLatestTranscript()
    if (!path) return
    this._transcriptPath = path
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      const stats = parseCodexTranscriptStats(lines)
      if (stats.cliSessionId && !this.session.cliSessionId) {
        this.session.cliSessionId = stats.cliSessionId
        this.emitEvent({ type: 'init', cliSessionId: stats.cliSessionId, model: stats.lastModel })
      }
      const inputTokens = stats.inputTokens
      const outputTokens = stats.outputTokens
      if (inputTokens !== this._lastStatsTokens.input || outputTokens !== this._lastStatsTokens.output || stats.lastModel !== this._lastModel) {
        this._lastStatsTokens = { input: inputTokens, output: outputTokens }
        this._lastModel = stats.lastModel
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
          model: stats.lastModel,
          contextWindow: stats.contextWindow
        })
      }
    } catch { /* ignore */ }
  }

  /** Public: replay transcript history to the terminal. */
  replayHistory() {
    this._replayHistory()
  }

  async start() {
    this._disposed = false
    this._startedAt = Date.now()
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
      try { this.ptyProc.write(data); return true } catch {}
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

  async resume(_cliSessionId) {
    // Codex has no --resume; just restart fresh
    await this.dispose()
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
  create: (opts) => new CodexAdapter(opts)
}
