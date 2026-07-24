import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { BaseAdapter, TIER } from './cliAdapter.js'
import { consumeOsc9Notifications } from './codexAdapter.js'
import { parsePattern } from '../permission/classifier.js'
import { listOpenCodeSessions } from '../openCodeSessions.js'
import { loadOpenCodeSessionStats, OpenCodeStatsScheduler } from '../openCodeStats.js'

const DISPLAY_NAME = 'OpenCode'
const ICON = '🔵'
const SESSION_DISCOVERY_DELAY_MS = 1500
const STATS_IDLE_DELAY_MS = 2000
const STATS_MAX_WAIT_MS = 30000

const require = createRequire(import.meta.url)
let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.error('Failed to load node-pty for OpenCode:', err.message)
}

const TOOL_NAMES = {
  bash: 'bash',
  edit: 'edit',
  write: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  read: 'read',
  webfetch: 'webfetch',
  websearch: 'websearch',
  glob: 'glob',
  grep: 'grep'
}

const HARD_DENY_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'rm -rf ~*', 'rm -rf $HOME*',
  'rm --no-preserve-root*', 'mkfs*', 'format *', 'diskpart*clean*',
  'dd *of=/dev/*', 'chmod -R 777 /*',
  'del /s*C:\\Windows*', 'del /s*C:\\Users*',
  'rmdir /s*C:\\Windows*', 'rmdir /s*C:\\Program Files*'
]

const HARD_DENY_PATHS = [
  '/etc/*', '/usr/*', '/bin/*', '/sbin/*', '/boot/*', '/proc/*', '/sys/*',
  '~/.ssh/*', 'C:\\Windows*', 'C:\\System32*', 'C:\\Program Files*',
  'C:\\Program Files (x86)*', 'C:\\Users\\*\\.ssh\\*'
]

function setLast(object, key, value) {
  if (Object.hasOwn(object, key)) delete object[key]
  object[key] = value
}

function toolRules(permission, tool) {
  const current = permission[tool]
  if (current && typeof current === 'object') return current
  const rules = { '*': typeof current === 'string' ? current : permission['*'] || 'allow' }
  permission[tool] = rules
  return rules
}

function mappedPattern(parsed) {
  if (parsed.kind === 'prefix') return `${parsed.spec}*`
  if (parsed.kind === 'glob') return parsed.spec.replace(/\\/g, '/')
  if (parsed.kind === 'host') return `*${parsed.spec}*`
  return null
}

function applyRule(permission, raw, action) {
  const parsed = parsePattern(raw)
  if (!parsed) return

  const tool = TOOL_NAMES[parsed.tool.toLowerCase()]
  const pattern = mappedPattern(parsed)
  if (tool && pattern) {
    setLast(toolRules(permission, tool), pattern, action)
    return
  }

  if (parsed.tool === '*' && pattern) {
    for (const name of ['read', 'edit']) {
      setLast(toolRules(permission, name), pattern, action)
    }
    return
  }

  // OpenCode permission patterns do not execute arbitrary regular
  // expressions. Asking for that whole tool is safer than silently allowing
  // an untranslatable deny/high-risk regex.
  if (action !== 'allow') {
    if (tool) setLast(toolRules(permission, tool), '*', 'ask')
    else {
      permission['*'] = 'ask'
      for (const value of Object.values(permission)) {
        if (value && typeof value === 'object') setLast(value, '*', 'ask')
      }
    }
  }
}

function applyHardDeny(permission) {
  const bash = toolRules(permission, 'bash')
  for (const pattern of HARD_DENY_COMMANDS) setLast(bash, pattern, 'deny')
  for (const tool of ['read', 'edit']) {
    const rules = toolRules(permission, tool)
    for (const pattern of HARD_DENY_PATHS) setLast(rules, pattern, 'deny')
  }
}

export function buildOpenCodePermission(tier, ruleset = {}) {
  const permission = {
    '*': tier === TIER.ASK_EVERYTHING ? 'ask' : 'allow'
  }

  if (tier === TIER.SAFETY_RULES) {
    permission.external_directory = 'ask'
    permission.doom_loop = 'ask'
    for (const rule of ruleset.allow || []) applyRule(permission, rule, 'allow')
    for (const rule of ruleset.highRisk || []) applyRule(permission, rule, 'ask')
    for (const rule of ruleset.deny || []) applyRule(permission, rule, 'deny')
  }

  applyHardDeny(permission)
  return permission
}

// OPENCODE_CONFIG_CONTENT is loaded after both global and project config.
// This lets UCLI enforce the active session's safety tier without mutating
// the user's OpenCode files or letting a project config silently override it.
export function buildOpenCodeConfigContent(tier, ruleset = {}) {
  return JSON.stringify({ permission: buildOpenCodePermission(tier, ruleset) })
}

export function buildOpenCodeArgs(session) {
  const args = []
  if (session.model && session.model !== 'default') args.push('--model', session.model)
  if (session.cliSessionId) args.push('--session', session.cliSessionId)
  return args
}

function findOpenCodeOnPath() {
  const result = spawnSync('where.exe', ['opencode'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

export function resolveOpenCodeLaunch(
  candidates = null,
  pathExists = existsSync,
  platform = process.platform
) {
  if (platform !== 'win32') return { file: 'opencode', prefixArgs: [] }
  const paths = candidates || findOpenCodeOnPath()
  const direct = paths.find((path) => path.toLowerCase().endsWith('.exe') && pathExists(path))
  if (direct) return { file: direct, prefixArgs: [] }

  for (const shim of paths.filter((path) => path.toLowerCase().endsWith('.cmd'))) {
    const npmExecutable = join(dirname(shim), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (pathExists(npmExecutable)) return { file: npmExecutable, prefixArgs: [] }
  }
  return { file: 'cmd.exe', prefixArgs: ['/c', 'opencode'] }
}

export function classifyOpenCodeNotification(message) {
  const normalized = String(message || '').toLowerCase()
  if (normalized.includes('permission') || normalized.includes('approval')) {
    return { kind: 'approval', operation: '确认 OpenCode 操作' }
  }
  if (normalized.includes('question') || normalized.includes('input') || normalized.includes('response')) {
    return { kind: 'approval', operation: '回答 OpenCode 问题' }
  }
  if (normalized.includes('error')) {
    return { kind: 'approval', operation: '处理 OpenCode 错误' }
  }
  return { kind: 'complete', operation: '任务完成' }
}

export class OpenCodeAdapter extends BaseAdapter {
  constructor({ session, engine, settings }) {
    super({ id: 'opencode', displayName: DISPLAY_NAME, session, engine })
    this.ruleset = settings.ruleset || {}
    this.ptyProc = null
    this._sessionDiscoveryTimer = null
    this._startedAt = Date.now()
    this._osc9Pending = ''
    this.statsReader = settings.statsReader || ((sessionId) => {
      const launch = resolveOpenCodeLaunch()
      return loadOpenCodeSessionStats(sessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs
      })
    })
    this._lastStats = null
    this._statsScheduler = new OpenCodeStatsScheduler({
      onRun: () => this._extractStats(),
      idleDelayMs: STATS_IDLE_DELAY_MS,
      maxWaitMs: STATS_MAX_WAIT_MS
    })
  }

  _write(text) {
    if (this._disposed) return
    const parsed = consumeOsc9Notifications(this._osc9Pending, text)
    this._osc9Pending = parsed.pending
    for (const message of parsed.messages) {
      this.emitEvent({ type: 'attention', ...classifyOpenCodeNotification(message) })
    }
    this.emitEvent({ type: 'terminal', data: text })
    this._scheduleSessionDiscovery()
    this._statsScheduler.schedule()
  }

  _scheduleSessionDiscovery() {
    if (this.session.cliSessionId || this._sessionDiscoveryTimer) return
    this._sessionDiscoveryTimer = setTimeout(async () => {
      this._sessionDiscoveryTimer = null
      const sessions = await listOpenCodeSessions(this.session.cwd)
      const match = sessions.find((item) =>
        (item.startedAt || item.updatedAt || 0) >= this._startedAt - 5000
      )
      if (!match || this.session.cliSessionId) return
      this.session.cliSessionId = match.sessionId
      if (!this.session.name && match.name) this.session.name = match.name
      this.emitEvent({ type: 'init', cliSessionId: match.sessionId })
      this._statsScheduler.schedule()
    }, SESSION_DISCOVERY_DELAY_MS)
    this._sessionDiscoveryTimer.unref?.()
  }

  async _extractStats() {
    if (this._disposed || !this.session.cliSessionId) return
    let stats
    try {
      stats = await this.statsReader(this.session.cliSessionId)
    } catch {
      return
    }
    if (!stats || this._disposed) return

    const next = {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      model: stats.lastModel,
      completedTurns: stats.completedTurnsCount,
      costUsd: stats.costUsd,
      costAvailable: stats.costAvailable
    }
    if (JSON.stringify(next) === JSON.stringify(this._lastStats)) return
    this._lastStats = next
    this.emitEvent({
      type: 'stats_update',
      usage: {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cachedInputTokens: stats.cachedInputTokens,
        reasoningOutputTokens: stats.reasoningOutputTokens
      },
      costUsd: stats.costUsd,
      costAvailable: stats.costAvailable,
      turns: stats.turnsCount,
      completedTurns: stats.completedTurnsCount,
      model: stats.lastModel,
      modelBreakdown: stats.modelBreakdown
    })
  }

  async start() {
    this._disposed = false
    this._startedAt = Date.now()
    if (!pty) {
      this._write('\x1b[31mnode-pty 未加载，无法启动 OpenCode 终端模式\x1b[0m\r\n')
      this.emitEvent({ type: 'error', message: 'node-pty not available' })
      return
    }

    const args = buildOpenCodeArgs(this.session)
    const env = {
      ...process.env,
      UCLI_SESSION_ID: this.session.id,
      OPENCODE_CLIENT: 'ucli',
      OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(this.session.tier, this.ruleset),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }

    try {
      const launch = resolveOpenCodeLaunch()
      this.ptyProc = pty.spawn(launch.file, [...launch.prefixArgs, ...args], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.session.cwd,
        env
      })
      this.ptyProc.onData((data) => this._write(data))
      this.ptyProc.onExit(({ exitCode }) => {
        this._write(`\r\n\x1b[90mOpenCode process exited (code ${exitCode})\x1b[0m\r\n`)
        this.emitEvent({ type: 'exit', code: exitCode })
      })
      this.emitEvent({
        type: 'stats_update',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: null,
        costAvailable: false,
        turns: 0,
        model: this.session.model || null
      })
      this.emitEvent({ type: 'ready' })
    } catch (err) {
      this._write(`\x1b[31mOpenCode PTY spawn failed: ${err?.message}\x1b[0m\r\n`)
      this.emitEvent({ type: 'error', message: 'OpenCode PTY spawn failed: ' + (err?.message || String(err)) })
    }
  }

  writeInput(data) {
    if (!this.ptyProc) return false
    try {
      this.ptyProc.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(cols, rows) {
    if (!this.ptyProc) return
    try { this.ptyProc.resize(cols, rows) } catch {}
  }

  async sendTurn(text) {
    this.writeInput(text + '\r')
  }

  async interrupt() {
    this.writeInput('\x03')
  }

  async resume(cliSessionId) {
    await this.dispose()
    this.session.cliSessionId = cliSessionId
    await this.start()
  }

  async dispose() {
    this._disposed = true
    if (this._sessionDiscoveryTimer) clearTimeout(this._sessionDiscoveryTimer)
    this._sessionDiscoveryTimer = null
    this._statsScheduler.dispose()
    this._lastStats = null
    this._osc9Pending = ''
    if (this.ptyProc) {
      try { this.ptyProc.kill() } catch {}
      this.ptyProc = null
    }
    await super.dispose()
  }
}

export const openCodeDescriptor = {
  id: 'opencode',
  displayName: DISPLAY_NAME,
  icon: ICON,
  models: ['default'],
  create: (opts) => new OpenCodeAdapter(opts)
}
