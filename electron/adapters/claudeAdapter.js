import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { BaseAdapter } from './cliAdapter.js'

const DISPLAY_NAME = 'Claude Code'
const ICON = '🟣'

// node-pty is a CJS native module — use createRequire in ESM context
const require = createRequire(import.meta.url)
let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.error('Failed to load node-pty:', err.message)
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
    this._lastStatsTokens = { input: 0, output: 0 }
  }

  _findTranscript(cliSessionId) {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const projDir = join(home, '.claude', 'projects')
    if (!existsSync(projDir)) return null
    const hash = (this.session.cwd || '').toLowerCase().replace(/:/g, '-').replace(/\\/g, '-').replace(/\s/g, '-').replace(/\/+/g, '-')
    for (const dir of readdirSync(projDir)) {
      if (dir.toLowerCase() === hash) {
        const exact = join(projDir, dir, cliSessionId + '.jsonl')
        if (existsSync(exact)) return exact
      }
    }
    return null
  }

  /** Find the most recent transcript in the project directory (for new sessions without cliSessionId) */
  _findLatestTranscript() {
    const home = process.env.HOME || process.env.USERPROFILE || '~'
    const projDir = join(home, '.claude', 'projects')
    if (!existsSync(projDir)) return null
    const hash = (this.session.cwd || '').toLowerCase().replace(/:/g, '-').replace(/\\/g, '-').replace(/\s/g, '-').replace(/\/+/g, '-')
    for (const dir of readdirSync(projDir)) {
      if (dir.toLowerCase() === hash) {
        const projectDir = join(projDir, dir)
        let newest = null, newestMtime = 0
        for (const f of readdirSync(projectDir)) {
          if (!f.endsWith('.jsonl')) continue
          try {
            const full = join(projectDir, f)
            const stat = require('fs').statSync(full)
            if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = full }
          } catch {}
        }
        return newest
      }
    }
    return null
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
    this._statsTimer = setTimeout(() => this._extractStats(), 2000)
  }

  _extractStats() {
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
      let inputTokens = 0, outputTokens = 0, turnsCount = 0, costUsd = 0, lastModel = null
      // Collect per-model usage across all result messages
      const modelUsageMap = {} // model -> {inputTokens, outputTokens, costUsd}
      for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.type === 'assistant' && obj.message?.usage) {
          inputTokens += obj.message.usage.input_tokens || 0
          outputTokens += obj.message.usage.output_tokens || 0
        }
        if (obj.type === 'assistant' && obj.message?.model) {
          lastModel = obj.message.model
        }
        if (obj.type === 'user' && obj.message?.content) {
          for (const b of obj.message.content) {
            if (b.type === 'text') { turnsCount += 1; break }
          }
        }
        if (obj.type === 'result') {
          if (obj.total_cost_usd) costUsd = Math.max(costUsd, obj.total_cost_usd)
          // Extract per-model breakdown from result.modelUsage
          if (obj.modelUsage) {
            for (const [m, mu] of Object.entries(obj.modelUsage)) {
              if (!modelUsageMap[m]) modelUsageMap[m] = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
              modelUsageMap[m].inputTokens += mu.inputTokens || 0
              modelUsageMap[m].outputTokens += mu.outputTokens || 0
              if (mu.costUSD) modelUsageMap[m].costUsd = Math.max(modelUsageMap[m].costUsd, mu.costUSD)
              lastModel = m // last model in modelUsage is the most recent
            }
          }
        }
      }
      // Build modelBreakdown array for per-model DB stats
      const modelBreakdown = Object.entries(modelUsageMap).map(([model, mu]) => ({
        model, inputTokens: mu.inputTokens, outputTokens: mu.outputTokens, costUsd: mu.costUsd
      }))
      // Only emit if stats actually changed
      if (inputTokens !== this._lastStatsTokens.input || outputTokens !== this._lastStatsTokens.output) {
        this._lastStatsTokens = { input: inputTokens, output: outputTokens }
        this.emitEvent({
          type: 'stats_update',
          usage: { inputTokens, outputTokens },
          costUsd,
          turns: turnsCount,
          model: lastModel,
          modelBreakdown
        })
      }
    } catch { /* transcript read failed, ignore */ }
  }

  _formatEvent(obj) {
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
      // node-pty needs a real executable. `claude` on Windows is a .ps1 shim,
      // so we spawn it through powershell which resolves the PATH correctly.
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'claude'
      const shellArgs = process.platform === 'win32'
        ? ['-NoProfile', '-Command', 'claude', ...args]
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
    this._disposed = true
    if (this._statsTimer) { clearTimeout(this._statsTimer); this._statsTimer = null }
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
