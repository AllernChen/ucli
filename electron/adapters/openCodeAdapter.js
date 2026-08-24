import { existsSync, readFileSync } from 'fs'
import { win32 } from 'path'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { BaseAdapter, TIER } from './cliAdapter.js'
import { consumeOsc9Notifications } from './codexAdapter.js'
import { parsePattern } from '../permission/classifier.js'
import { listOpenCodeSessions } from '../openCodeSessions.js'
import {
  exportOpenCodeSession,
  loadOpenCodeSessionStats,
  OpenCodeStatsScheduler
} from '../openCodeStats.js'
import {
  encodeOpenCodeDecisionResponse,
  extractOpenCodePlanSnapshot,
  extractOpenCodeResultSnapshot,
  parseOpenCodeGatewayState
} from './openCodeGatewayParser.js'

const DISPLAY_NAME = 'OpenCode'
const ICON = '🔵'
const SESSION_DISCOVERY_DELAY_MS = 1500
const SESSION_DISCOVERY_RETRY_MS = 2000
const SESSION_DISCOVERY_MAX_ATTEMPTS = 10
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

const ACTION_ONLY_TOOLS = new Set(['webfetch', 'websearch'])

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

const REGEX_GLOB_TRANSLATIONS = new Map([
  ['curl\\s.*\\|\\s*(sh|bash)', ['curl *|*sh*', 'curl *|*bash*']],
  ['wget\\s.*\\|\\s*(sh|bash)', ['wget *|*sh*', 'wget *|*bash*']]
])

function mappedPatterns(parsed) {
  if (parsed.kind === 'prefix') return [`${parsed.spec}*`]
  if (parsed.kind === 'glob') return [parsed.spec.replace(/\\/g, '/')]
  if (parsed.kind === 'host') return [`*${parsed.spec}*`]
  if (parsed.kind === 'regex') return REGEX_GLOB_TRANSLATIONS.get(parsed.spec) || []
  return []
}

function applyRule(permission, raw, action) {
  const parsed = parsePattern(raw)
  if (!parsed) return

  const tool = TOOL_NAMES[parsed.tool.toLowerCase()]
  if (tool && ACTION_ONLY_TOOLS.has(tool)) {
    // OpenCode models these permissions as one action for the whole tool;
    // unlike bash/read/edit, host or glob rule objects are rejected by the
    // configuration schema.
    permission[tool] = action
    return
  }
  const patterns = mappedPatterns(parsed)
  if (tool && patterns.length) {
    for (const pattern of patterns) setLast(toolRules(permission, tool), pattern, action)
    return
  }

  if (parsed.tool === '*' && patterns.length) {
    for (const name of ['read', 'edit']) {
      for (const pattern of patterns) setLast(toolRules(permission, name), pattern, action)
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
    permission.external_directory = { '*': 'allow' }
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

export function buildOpenCodeEnvironment(
  session,
  ruleset = {},
  runtime = OPEN_CODE_RUNTIME,
  baseEnv = process.env
) {
  return {
    ...baseEnv,
    UCLI_SESSION_ID: session.id,
    [runtime.clientEnv]: 'ucli',
    [runtime.configEnv]: buildOpenCodeConfigContent(session.tier, ruleset),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
}

export function buildOpenCodeArgs(session) {
  // Let OpenCode load the provider/model recorded in the source session.
  // Passing --model here would override that historical configuration.
  if (session.cliSessionId) return ['--session', session.cliSessionId]
  const args = []
  if (session.model && session.model !== 'default') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/+~-]{0,255}$/.test(session.model)) {
      throw new Error('invalid OpenCode model')
    }
    args.push('--model', session.model)
  }
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
  platform = process.platform,
  readShim = readFileSync
) {
  if (platform !== 'win32') return { file: 'opencode', prefixArgs: [] }
  const paths = candidates || findOpenCodeOnPath()
  const direct = paths.find((path) => path.toLowerCase().endsWith('.exe') && pathExists(path))
  if (direct) return { file: direct, prefixArgs: [] }

  for (const shim of paths.filter((path) => path.toLowerCase().endsWith('.cmd'))) {
    const npmExecutable = win32.join(win32.dirname(shim), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (pathExists(npmExecutable)) return { file: npmExecutable, prefixArgs: [] }
    try {
      const launch = resolveOpenCodeCmdShim(shim, readShim(shim, 'utf8'), pathExists)
      if (launch) return launch
    } catch {}
  }
  throw new Error('safe OpenCode executable not found')
}

function expandShimPath(value, shimDirectory) {
  const directoryPrefix = shimDirectory.endsWith('\\')
    ? shimDirectory
    : `${shimDirectory}\\`
  const expanded = String(value)
    .replace(/%~dp0/gi, directoryPrefix)
    .replace(/%dp0%/gi, directoryPrefix)
  if (expanded.includes('%')) return null
  return win32.normalize(expanded)
}

function isWithinDirectory(path, directory) {
  const relative = win32.relative(directory, path)
  return relative !== '..' &&
    !relative.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(relative)
}

function resolveStaticOpenCodeEntry(shimPath, content, pathExists) {
  const directory = win32.dirname(shimPath)
  const candidates = [...String(content || '').matchAll(/"(%~?dp0%?[^"]+)"/gi)]
    .map((match) => expandShimPath(match[1], directory))
    .filter((path) =>
      path &&
      isWithinDirectory(path, directory) &&
      path.toLowerCase().includes(`${win32.sep}node_modules${win32.sep}`) &&
      path.toLowerCase().includes('opencode') &&
      pathExists(path)
    )

  const executable = candidates.find((path) =>
    win32.basename(path).toLowerCase() === 'opencode.exe'
  )
  if (executable) return { file: executable, prefixArgs: [] }

  const script = candidates.find((path) => /\.(?:c?js|mjs)$/i.test(path))
  const node = win32.join(directory, 'node.exe')
  if (script && pathExists(node)) return { file: node, prefixArgs: [script] }
  return null
}

export function resolveOpenCodeCmdShim(shimPath, content, pathExists = existsSync) {
  const staticEntry = resolveStaticOpenCodeEntry(shimPath, content, pathExists)
  if (staticEntry) return staticEntry

  const invocation = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /%\*\s*$/i.test(line) && !/^(?:call|rem|::)\b/i.test(line))
  if (!invocation || /[&|<>^]/.test(invocation)) return null

  const match = invocation.match(/^"([^"]+\.exe)"(?:\s+"([^"]+)")?\s+%\*\s*$/i)
  if (!match) return null

  const directory = win32.dirname(shimPath)
  const executable = expandShimPath(match[1], directory)
  if (!executable || !pathExists(executable)) return null

  const executableName = win32.basename(executable).toLowerCase()
  if (executableName === 'opencode.exe' && !match[2]) {
    return { file: executable, prefixArgs: [] }
  }
  if (executableName !== 'node.exe' || !match[2]) return null

  const script = expandShimPath(match[2], directory)
  if (
    !script ||
    !/\.(?:c?js|mjs)$/i.test(script) ||
    !script.toLowerCase().includes('opencode') ||
    !pathExists(script)
  ) {
    return null
  }
  return { file: executable, prefixArgs: [script] }
}

export function classifyOpenCodeNotification(message, displayName = DISPLAY_NAME) {
  const normalized = String(message || '').toLowerCase()
  if (normalized.includes('permission') || normalized.includes('approval')) {
    return { kind: 'approval', operation: `确认 ${displayName} 操作` }
  }
  if (normalized.includes('question') || normalized.includes('input') || normalized.includes('response')) {
    return { kind: 'approval', operation: `回答 ${displayName} 问题` }
  }
  if (normalized.includes('error')) {
    return { kind: 'approval', operation: `处理 ${displayName} 错误` }
  }
  return { kind: 'complete', operation: '任务完成' }
}

export function createOpenCodeRuntime(overrides = {}) {
  return {
    id: 'opencode',
    displayName: DISPLAY_NAME,
    clientEnv: 'OPENCODE_CLIENT',
    configEnv: 'OPENCODE_CONFIG_CONTENT',
    resolveLaunch: resolveOpenCodeLaunch,
    listSessions: listOpenCodeSessions,
    ...overrides
  }
}

export const OPEN_CODE_RUNTIME = createOpenCodeRuntime()

export class OpenCodeAdapter extends BaseAdapter {
  constructor({ session, engine, settings }, runtime = OPEN_CODE_RUNTIME) {
    super({ id: runtime.id, displayName: runtime.displayName, session, engine })
    this.runtime = runtime
    this.gatewayIdentity = { provider: runtime.id, displayName: runtime.displayName }
    this.ruleset = settings.ruleset || {}
    this.ptyProc = null
    this._sessionDiscoveryTimer = null
    this._sessionDiscoveryAttempts = 0
    this.sessionFinder = runtime.listSessions
    this.sessionDiscoveryDelayMs = SESSION_DISCOVERY_DELAY_MS
    this.sessionDiscoveryRetryMs = SESSION_DISCOVERY_RETRY_MS
    this.sessionDiscoveryMaxAttempts = SESSION_DISCOVERY_MAX_ATTEMPTS
    this._startedAt = Date.now()
    this._osc9Pending = ''
    this.statsReader = settings.statsReader || ((sessionId) => {
      const launch = this.runtime.resolveLaunch()
      return loadOpenCodeSessionStats(sessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs
      })
    })
    this._lastStats = null
    this._gatewaySource = null
    this._gatewayCursor = []
    this._gatewayDecision = null
    this._gatewayRespondedDecisions = new Set()
    this.gatewayReader = settings.gatewayReader || ((sessionId) => {
      const launch = this.runtime.resolveLaunch()
      return exportOpenCodeSession(sessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs,
        sanitize: false
      })
    })
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
      this.emitEvent({
        type: 'attention',
        ...classifyOpenCodeNotification(message, this.runtime.displayName)
      })
    }
    this.emitEvent({ type: 'terminal', data: text })
    this._scheduleSessionDiscovery()
    this._statsScheduler.schedule()
  }

  _scheduleSessionDiscovery(delayMs = this.sessionDiscoveryDelayMs) {
    if (this._disposed || this.session.cliSessionId || this._sessionDiscoveryTimer) return
    this._sessionDiscoveryTimer = setTimeout(async () => {
      this._sessionDiscoveryTimer = null
      if (this._disposed || this.session.cliSessionId) return
      let sessions = []
      try {
        sessions = await this.sessionFinder(this.session.cwd)
      } catch {
        sessions = []
      }
      const match = sessions.find((item) =>
        (item.startedAt || item.updatedAt || 0) >= this._startedAt - 5000
      )
      if (match && !this.session.cliSessionId) {
        this.session.cliSessionId = match.sessionId
        if (!this.session.name && match.name) this.session.name = match.name
        this.emitEvent({ type: 'init', cliSessionId: match.sessionId })
        this._statsScheduler.schedule()
        return
      }
      if (!this._disposed && !this.session.cliSessionId && this._sessionDiscoveryAttempts < this.sessionDiscoveryMaxAttempts) {
        this._sessionDiscoveryAttempts += 1
        this._scheduleSessionDiscovery(this.sessionDiscoveryRetryMs)
      }
    }, delayMs)
    this._sessionDiscoveryTimer.unref?.()
  }

  async _extractStats() {
    if (this._disposed || !this.session.cliSessionId) return
    await this._scanGatewayState()
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

  async _readGatewaySource() {
    if (!this.session.cliSessionId) return null
    try {
      return await this.gatewayReader(this.session.cliSessionId)
    } catch {
      return null
    }
  }

  async _scanGatewayState({ emit = true } = {}) {
    const source = await this._readGatewaySource()
    if (!source || this._disposed) return
    this._gatewaySource = source
    const state = parseOpenCodeGatewayState(source, this._gatewayCursor, this.gatewayIdentity)
    this._gatewayCursor = state.cursor
    this._gatewayDecision = state.currentDecision &&
      !this._gatewayRespondedDecisions.has(state.currentDecision.decisionId)
      ? state.currentDecision
      : null
    if (emit) {
      for (const event of state.events) this.emitGatewayEvent(event)
    }
  }

  async _primeGatewayCursor() {
    if (!this.session.cliSessionId) return
    const source = await this._readGatewaySource()
    if (!source) return
    this._gatewaySource = source
    this._gatewayCursor = parseOpenCodeGatewayState(source, [], this.gatewayIdentity).cursor
  }

  get gatewayCapabilities() {
    return {
      decisions: true,
      planSnapshot: true,
      resultSnapshot: true
    }
  }

  getDecisionContext() {
    return this._gatewayDecision ? structuredClone(this._gatewayDecision) : null
  }

  async getLatestPlanSnapshot(decisionId) {
    const source = await this._readGatewaySource() || this._gatewaySource
    if (source) this._gatewaySource = source
    return extractOpenCodePlanSnapshot(source, decisionId, this.gatewayIdentity)
  }

  async getLatestResultSnapshot(turnId) {
    const source = await this._readGatewaySource() || this._gatewaySource
    if (source) this._gatewaySource = source
    return extractOpenCodeResultSnapshot(source, turnId, this.gatewayIdentity)
  }

  async respondDecision(decisionId, response) {
    const permission = await super.respondDecision(decisionId, response)
    if (permission.accepted) return permission

    if (!this._gatewayDecision) await this._scanGatewayState({ emit: false })
    const decision = this.getDecisionContext()
    if (!decision || decision.decisionId !== decisionId) {
      return { accepted: false, reason: 'already_resolved' }
    }
    const inputs = encodeOpenCodeDecisionResponse(decision, response)
    if (!inputs) return { accepted: false, reason: 'invalid_response' }
    for (const input of inputs) {
      if (!this.writeInput(input)) return { accepted: false, reason: 'not_ready' }
    }
    this._gatewayRespondedDecisions.add(decisionId)
    this._gatewayDecision = null
    return { accepted: true }
  }

  async start() {
    this._disposed = false
    this._startedAt = Date.now()
    this._sessionDiscoveryAttempts = 0
    await this._primeGatewayCursor()
    if (!pty) {
      this._write(`\x1b[31mnode-pty 未加载，无法启动 ${this.runtime.displayName} 终端模式\x1b[0m\r\n`)
      this.emitEvent({ type: 'error', message: 'node-pty not available' })
      return
    }

    const args = buildOpenCodeArgs(this.session)
    const env = buildOpenCodeEnvironment(this.session, this.ruleset, this.runtime)

    try {
      const launch = this.runtime.resolveLaunch()
      this.ptyProc = pty.spawn(launch.file, [...launch.prefixArgs, ...args], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.session.cwd,
        env
      })
      this.ptyProc.onData((data) => this._write(data))
      this.ptyProc.onExit(({ exitCode }) => {
        this._write(`\r\n\x1b[90m${this.runtime.displayName} process exited (code ${exitCode})\x1b[0m\r\n`)
        this.emitEvent({ type: 'exit', code: exitCode })
        this.emitGatewayEvent({
          type: 'session_stopped',
          occurredAt: Date.now(),
          exitCode
        })
      })
      this.emitEvent({
        type: 'stats_update',
        usage: { inputTokens: 0, outputTokens: 0 },
        synthetic: true,
        costUsd: null,
        costAvailable: false,
        turns: 0,
        model: this.session.model || null
      })
      this.emitEvent({ type: 'ready' })
      // OpenCode can write its native record after the TUI becomes visible.
      // Start discovery independently of terminal output and retry if needed.
      this._scheduleSessionDiscovery()
    } catch (err) {
      this._write(`\x1b[31m${this.runtime.displayName} PTY spawn failed: ${err?.message}\x1b[0m\r\n`)
      this.emitEvent({
        type: 'error',
        message: `${this.runtime.displayName} PTY spawn failed: ${err?.message || String(err)}`
      })
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
    return this.writeInput(text + '\r')
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
    this._gatewayDecision = null
    this._gatewaySource = null
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
  costAvailable: false,
  resolveLaunch: resolveOpenCodeLaunch,
  listNativeSessions: listOpenCodeSessions,
  create: (opts) => new OpenCodeAdapter(opts)
}
