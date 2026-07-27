import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { BaseAdapter } from './cliAdapter.js'
import { findClaudeProjectDirectory } from '../sessionDiscovery.js'
import { log } from '../logger.js'

const DISPLAY_NAME = 'Claude Code'
const ICON = '🟣'
const STATS_IDLE_DELAY_MS = 2000
const STATS_MAX_WAIT_MS = 30000
const STATS_FALLBACK_INTERVAL_MS = 30000

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
    if (obj.type === 'user' && obj.message?.content) {
      for (const b of obj.message.content) {
        if (b.type === 'text') { turnsCount += 1; break }
      }
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

function buildSettings(hookRunnerPath) {
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
    this.ptyProc = null
    this._settingsDir = null
    this._statsTimer = null
    this._statsMaxTimer = null
    this._statsFallbackTimer = null
    this._lastStatsScanAt = 0
    this._lastStatsTokens = { input: 0, output: 0 }
    this._lastModel = null
    this._lastCompletedTurns = -1
  }

  /** Shared: return the matched ~/.claude/projects/<hash> directory, or null. */
  _projectDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const lookup = this.session.originalProjectPath || this.session.cwd
    const dir = findClaudeProjectDirectory(home, lookup)
    log(`[ClaudeAdapter] _projectDir lookup="${lookup}" origProjectPath="${this.session.originalProjectPath}" cwd="${this.session.cwd}" → ${dir || 'null'}`)
    return dir
  }

  _findTranscript(cliSessionId) {
    if (!cliSessionId) return null
    // Closest to claude's own lookup: check the path claude uses first.
    // This ensures stats read the latest data even after claude has written
    // new turns to the transcript at its expected path.
    const claudePath = this._claudeTranscriptPath(cliSessionId)
    if (claudePath && existsSync(claudePath)) {
      log(`[ClaudeAdapter] _findTranscript claudePath="${claudePath}" exists=true`)
      return claudePath
    }
    const dir = this._projectDir()
    if (!dir) {
      log(`[ClaudeAdapter] _findTranscript: no projectDir for cliSessionId=${cliSessionId}`)
      return null
    }
    const exact = join(dir, cliSessionId + '.jsonl')
    const exists = existsSync(exact)
    log(`[ClaudeAdapter] _findTranscript path="${exact}" exists=${exists}`)
    return exists ? exact : null
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

  /** Compute the path where claude itself will look for the transcript.
   *  claude 2.1.x replaces all non-alphanumeric chars (including _) with
   *  hyphens and lowercases the result. */
  _claudeTranscriptPath(cliSessionId) {
    if (!cliSessionId) return null
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const cwd = this.session.originalProjectPath || this.session.cwd
    if (!cwd) return null
    const hash = String(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
    return join(home, '.claude', 'projects', hash, cliSessionId + '.jsonl')
  }

  /** Ensure the transcript exists at claude's expected path so --resume works.
   *  Returns the path that claude will use. */
  _ensureTranscriptAtClaudePath(cliSessionId) {
    const claudePath = this._claudeTranscriptPath(cliSessionId)
    if (!claudePath || existsSync(claudePath)) return claudePath
    const dir = this._projectDir()
    if (!dir) return null
    const actualFile = join(dir, cliSessionId + '.jsonl')
    if (!existsSync(actualFile) || actualFile === claudePath) return null
    const parent = dirname(claudePath)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    copyFileSync(actualFile, claudePath)
    log(`[ClaudeAdapter] _ensureTranscriptAtClaudePath copied "${basename(actualFile)}" → "${parent}"`)
    return claudePath
  }

  /** Public: replay transcript history to the terminal. Called when a
   *  running session is attached to a new pane. */
  replayHistory() {
    this._replayHistory()
  }

  _replayHistory() {
    const cliSessionId = this.session.cliSessionId
    log(`[ClaudeAdapter] _replayHistory called cliSessionId="${cliSessionId}"`)
    if (!cliSessionId) {
      log(`[ClaudeAdapter] _replayHistory: no cliSessionId, returning silently`)
      return
    }
    const path = this._findTranscript(cliSessionId)
    if (!path) {
      this._write('\x1b[90m(未找到历史记录)\x1b[0m\r\n\r\n')
      log(`[ClaudeAdapter] _replayHistory: transcript NOT FOUND for cliSessionId=${cliSessionId}`)
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

    // Replay history before starting
    this._replayHistory()

    // Ensure transcript exists at claude's expected path (for --resume)
    if (this.session.cliSessionId) {
      this._ensureTranscriptAtClaudePath(this.session.cliSessionId)
    }

    this._settingsDir = mkdtempSync(join(tmpdir(), 'ucli-claude-'))
    const settingsFile = join(this._settingsDir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(buildSettings(this.hookRunnerPath)))

    const args = [
      '--permission-mode', 'default',
      '--settings', settingsFile
    ]
    if (this.session.model) args.push('--model', this.session.model)
    if (this.session.cliSessionId) args.push('--resume', this.session.cliSessionId)

    const env = {
      ...process.env,
      UCLI_HOOK_PORT: String(this.hookPort),
      UCLI_SESSION_ID: this.session.id,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }

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

      log(`[ClaudeAdapter] PTY spawned pid=${this.ptyProc.pid} sessionId=${this.session.id} cliSessionId=${this.session.cliSessionId} cwd=${this.session.cwd}`)

      let _dataLogged = false
      this.ptyProc.onData((data) => {
        if (!_dataLogged) {
          _dataLogged = true
          log(`[ClaudeAdapter] PTY onData FIRST sessionId=${this.session.id} len=${data.length} head="${data.slice(0, 120).replace(/\x1b\[/g, 'ESC[')}"`)
        }
        this._write(data)
      })

      this.ptyProc.onExit(({ exitCode, signal }) => {
        log(`[ClaudeAdapter] PTY onExit pid=${this.ptyProc?.pid} code=${exitCode} signal=${signal}`)
        this._write(`\r\n\x1b[90mprocess exited (code ${exitCode})\x1b[0m\r\n`)
        this.ptyProc = null
        this.emitEvent({ type: 'exit', code: exitCode })
      })

      this._startStatsFallback()

      // Emit initial empty stats so the UI shows 0 tokens / model
      this.emitEvent({
        type: 'stats_update',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        turns: 0,
        model: this.session.model || null
      })
      this.emitEvent({ type: 'ready' })
    } catch (err) {
      log(`[ClaudeAdapter] PTY spawn FAILED: ${err?.message}`)
      this._write(`\x1b[31mPTY spawn failed: ${err?.message}\x1b[0m\r\n`)
      this.emitEvent({ type: 'error', message: 'PTY spawn failed: ' + (err?.message || String(err)) })
    }
  }

  writeInput(data) {
    if (this.ptyProc) {
      try {
        log(`[ClaudeAdapter] writeInput sessionId=${this.session.id} data="${data.replace(/\x1b\[/g, 'ESC[').replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 80)}"`)
        this.ptyProc.write(data)
        return true
      } catch (err) {
        log(`[ClaudeAdapter] writeInput FAILED: ${err?.message}`)
      }
    } else {
      log(`[ClaudeAdapter] writeInput SKIPPED — no ptyProc sessionId=${this.session.id}`)
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
    this.writeInput('\x03') // Ctrl+C
  }

  async resume(cliSessionId) {
    await this.dispose()
    this.session.cliSessionId = cliSessionId
    await this.start()
  }

  async dispose() {
    // Sync transcript back from claude's path to original if newer
    try {
      if (this.session.cliSessionId) {
        const cp = this._claudeTranscriptPath(this.session.cliSessionId)
        if (cp && existsSync(cp)) {
          const dir = this._projectDir()
          if (dir) {
            const orig = join(dir, this.session.cliSessionId + '.jsonl')
            if (orig !== cp && existsSync(orig) && statSync(cp).mtimeMs > statSync(orig).mtimeMs) {
              copyFileSync(cp, orig)
              log(`[ClaudeAdapter] dispose synced back "${basename(cp)}" → "${dir}"`)
            }
          }
        }
      }
    } catch { /* best-effort sync */ }
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
