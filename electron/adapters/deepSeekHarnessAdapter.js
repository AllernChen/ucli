import { BaseAdapter } from './cliAdapter.js'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  BRIDGED_DSH_TUI_CAPABILITIES,
  DSH_WEB_CAPABILITIES
} from './adapterCapabilities.js'
import { normalizeDshSessionConfig } from './adapterSessionConfig.js'
import { createDshBridgeServer } from './dshBridgeServer.js'
import {
  inspectDshRuntime,
  launchDshWebSurface,
  normalizeDshWebSurfaceState,
  SUPPORTED_DSH_VERSION
} from './deepSeekHarnessRuntime.js'
import { isSafeNativeSessionId } from '../sessionDiscovery.js'

const require = createRequire(import.meta.url)
let defaultPty = null
try { defaultPty = require('node-pty') } catch {}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function addSafeCounter(current, delta) {
  const next = current + delta
  if (!Number.isSafeInteger(next) || next < current) throw codedError('DSH_USAGE_INVALID')
  return next
}

function buildEnvironment(baseEnv, runtime, bridge) {
  const env = { ...(baseEnv || process.env) }
  delete env.UCLI_DSH_BRIDGE_ENDPOINT
  delete env.UCLI_DSH_BRIDGE_TOKEN
  delete env.UCLI_DSH_BRIDGE_PROTOCOL
  env.DSH_HOME = runtime.home
  env.UCLI_DSH_BRIDGE_ENDPOINT = bridge.endpoint
  env.UCLI_DSH_BRIDGE_TOKEN = bridge.token
  env.UCLI_DSH_BRIDGE_PROTOCOL = String(bridge.protocolVersion)
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  if (runtime.launch.prefixArgs?.length) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

function deferred() {
  let resolve
  let settled = false
  const promise = new Promise(done => {
    resolve = value => {
      if (settled) return
      settled = true
      done(value)
    }
  })
  return { promise, resolve, get settled() { return settled } }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(codedError('DSH_PTY_TERMINATE_FAILED')))
  })
}

async function waitWithTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError('DSH_PTY_EXIT_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function terminateOwnedPtyTree(proc, exitPromise) {
  if (!Number.isInteger(proc?.pid) || proc.pid <= 0) throw codedError('DSH_PTY_PID_INVALID')
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const killer = spawn(executable, ['/pid', String(proc.pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    await waitForChild(killer)
    await waitWithTimeout(exitPromise, 5_000)
    return
  }
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  try {
    await waitWithTimeout(exitPromise, 6_000)
  } catch (error) {
    if (error?.code !== 'DSH_PTY_EXIT_TIMEOUT') throw error
    try { process.kill(-proc.pid, 'SIGKILL') } catch (killError) {
      if (killError?.code !== 'ESRCH') throw killError
    }
    await waitWithTimeout(exitPromise, 4_000)
  }
}

export class DeepSeekHarnessAdapter extends BaseAdapter {
  constructor({ session, engine, settings = {} }) {
    super({ id: 'deepseek-harness', displayName: 'DeepSeek Harness', session, engine })
    this.settings = settings
    this._surfacePreference = normalizeDshSessionConfig(session.adapterConfig).surfacePreference
    this.session.capabilities = this._surfacePreference === 'web'
      ? DSH_WEB_CAPABILITIES
      : BRIDGED_DSH_TUI_CAPABILITIES
    this.ptyProc = null
    this.bridge = null
    this.webController = null
    this.surfaceState = this._surfacePreference === 'web'
      ? Object.freeze({ kind: 'web', status: 'starting', url: null, errorCode: null })
      : null
    this._accepting = false
    this._epoch = 0
    this._cleanupPromise = null
    this._shuttingDown = false
    this._ptyExit = null
    this._startPromise = null
    this._disposePromise = null
    this._resumePromise = null
    this._state = 'idle'
    this._nativeSessionId = session.cliSessionId || null
    this._latestPlan = null
    this._latestResult = null
    this._gatewayResults = new Map()
    this._gatewayResultOrder = []
    this._gatewayTerminalTurns = new Set()
    this._gatewayTerminalTurnOrder = []
    this._gatewayTerminalStatuses = new Map()
    this._gatewayLastCompletedTurnId = null
    this._gatewayStopped = false
    this._lastModel = session.model || null
    const initialStats = settings.initialStats || {}
    this._statsTotals = {
      inputTokens: initialStats.tokens?.input || 0,
      outputTokens: initialStats.tokens?.output || 0,
      turns: initialStats.turns || 0,
      completedTurns: initialStats.completedTurns ?? initialStats.turns ?? 0
    }
    this._completedTurnIds = new Set()
    this._completedTurnQueue = []
  }

  start() {
    if (this._startPromise) return this._startPromise
    if (this._disposed || this._state !== 'idle') {
      return Promise.reject(codedError('DSH_ADAPTER_STOPPED'))
    }
    this._state = 'starting'
    const attempt = this._start()
    this._startPromise = attempt
    attempt.then(
      () => { if (this._startPromise === attempt) this._state = 'ready' },
      (error) => {
        if (this._startPromise === attempt) {
          this._startPromise = null
          if (!this._disposed) {
            this._state = error?.cleanupCode ? 'cleanup-failed' : 'idle'
          }
        }
      }
    )
    return attempt
  }

  async _start() {
    this._disposed = false
    this._cleanupPromise = null
    this._shuttingDown = false
    const epoch = ++this._epoch
    this._gatewayStopped = false
    try {
      const config = normalizeDshSessionConfig(this.session.adapterConfig)
      if (config.surfacePreference === 'web') return await this._startWeb(epoch)
      if (this.session.cliSessionId && !isSafeNativeSessionId(this.session.cliSessionId)) {
        throw codedError('DSH_NATIVE_SESSION_INVALID')
      }
      const inspectRuntime = this.settings.inspectRuntime || inspectDshRuntime
      const runtime = await inspectRuntime()
      this._assertStarting(epoch)
      if (
        !runtime?.compatible || runtime.version !== SUPPORTED_DSH_VERSION ||
        !path.isAbsolute(runtime.launch?.file || '') ||
        !Array.isArray(runtime.launch.prefixArgs) ||
        !runtime.launch.prefixArgs.every(value => path.isAbsolute(value)) ||
        !path.isAbsolute(runtime.home || '')
      ) throw codedError('DSH_VERSION_UNSUPPORTED')
      const listed = await this.settings.profileManager?.listProfiles?.()
      this._assertStarting(epoch)
      const profile = listed?.profiles?.find(item => item.profileName === config.profileName)
      if (!profile?.profileReady) throw codedError(profile?.errorCode || 'DSH_PROFILE_NOT_READY')
      if (!profile.bridgeCompatible || profile.bridgeVersion !== '0.11.0') {
        throw codedError(profile.errorCode || 'DSH_BRIDGE_VERSION_UNSUPPORTED')
      }

      const bridgeFactory = this.settings.createBridgeServer || createDshBridgeServer
      const createdBridge = await bridgeFactory({
        sessionId: this.session.id,
        profileName: config.profileName,
        handshakeTimeoutMs: 10_000,
        onEvent: event => this._onBridgeEvent(event, epoch),
        onDisconnect: error => this._onBridgeDisconnect(error, epoch),
        onPermissionRequest: request => this._decidePermission(request, epoch)
      })
      if (!this._isStarting(epoch)) {
        this.bridge = createdBridge
        throw codedError('DSH_ADAPTER_STOPPED')
      }
      this.bridge = createdBridge
      const args = [
        ...runtime.launch.prefixArgs,
        '--profile', config.profileName
      ]
      if (this.session.cliSessionId) args.push('--resume', this.session.cliSessionId)
      this._assertStarting(epoch)
      const spawnPty = (this.settings.pty || defaultPty)?.spawn
      if (typeof spawnPty !== 'function') throw codedError('DSH_PTY_UNAVAILABLE')
      const proc = spawnPty(runtime.launch.file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.session.cwd,
        env: buildEnvironment(this.settings.baseEnv, runtime, this.bridge)
      })
      const ptyExit = deferred()
      this.ptyProc = proc
      this._ptyExit = ptyExit
      proc.onData(data => {
        if (epoch === this._epoch && this.ptyProc === proc) {
          this.emitEvent({ type: 'terminal', data })
        }
      })
      proc.onExit(({ exitCode }) => this._onPtyExit(proc, ptyExit, exitCode, epoch))
      await this.bridge.waitForHello()
      this._assertStarting(epoch)
      if (this.bridge.isConnected?.() === false) throw codedError('DSH_BRIDGE_DISCONNECTED')
      this._accepting = true
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
      return true
    } catch (error) {
      if (this._surfacePreference === 'web' && this.surfaceState?.status === 'starting') {
        const stableWebErrors = new Set([
          'DSH_WEB_SPAWN_FAILED',
          'DSH_WEB_START_TIMEOUT',
          'DSH_WEB_READY_URL_INVALID',
          'DSH_WEB_CLEANUP_FAILED'
        ])
        this._onWebSurfaceState({
          kind: 'web',
          status: 'error',
          url: null,
          errorCode: stableWebErrors.has(error?.code)
            ? error.code
            : 'DSH_WEB_RUNTIME_UNAVAILABLE'
        }, epoch)
      }
      try {
        await this._shutdown()
      } catch (cleanupError) {
        error.cleanupCode = cleanupError?.code || 'DSH_CLEANUP_FAILED'
      }
      throw error
    }
  }

  async _startWeb(epoch) {
    const inspectRuntime = this.settings.inspectRuntime || inspectDshRuntime
    const runtime = await inspectRuntime()
    this._assertStarting(epoch)
    if (
      !runtime?.compatible || runtime.version !== SUPPORTED_DSH_VERSION ||
      !path.isAbsolute(runtime.launch?.file || '') ||
      !Array.isArray(runtime.launch.prefixArgs) ||
      !runtime.launch.prefixArgs.every(value => path.isAbsolute(value)) ||
      !path.isAbsolute(runtime.home || '')
    ) throw codedError('DSH_VERSION_UNSUPPORTED')
    const launch = this.settings.launchWebSurface || launchDshWebSurface
    const controller = launch({
      runtime,
      cwd: this.session.cwd,
      env: this.settings.baseEnv,
      platform: this.settings.platform,
      spawnProcess: this.settings.spawnWebProcess,
      terminateProcessTree: this.settings.terminateWebProcessTree,
      startTimeoutMs: this.settings.webStartTimeoutMs,
      onState: state => this._onWebSurfaceState(state, epoch),
      onExit: code => this._onWebExit(code, epoch)
    })
    this.webController = controller
    this._assertStarting(epoch)
    await controller.ready
    if (this.webController !== controller || controller.state?.status !== 'ready') {
      throw codedError('DSH_WEB_EXITED')
    }
    this._assertStarting(epoch)
    this.emitEvent({ type: 'ready' })
    return true
  }

  _onWebSurfaceState(state, epoch) {
    if (epoch !== this._epoch || this._disposed) return
    const safeState = normalizeDshWebSurfaceState(state)
    if (!safeState) return
    this.surfaceState = Object.freeze(safeState)
    this.emitEvent({ type: 'surface_state', ...safeState })
  }

  _onWebExit(code, epoch) {
    if (epoch !== this._epoch || this._disposed) return
    this.webController = null
    this.emitEvent({ type: 'exit', code })
  }

  _isStarting(epoch) {
    return epoch === this._epoch && !this._disposed && this._state === 'starting'
  }

  _assertStarting(epoch) {
    if (!this._isStarting(epoch)) throw codedError('DSH_ADAPTER_STOPPED')
  }

  _onBridgeEvent(event, epoch) {
    if (epoch !== this._epoch || this._shuttingDown || !event) return
    if (event.type === 'session-ready') {
      if (
        !isSafeNativeSessionId(event.nativeSessionId) ||
        (this._nativeSessionId && this._nativeSessionId !== event.nativeSessionId)
      ) {
        this._failClosed('DSH_NATIVE_SESSION_MISMATCH')
        return
      }
      if (!this._nativeSessionId) {
        this._nativeSessionId = event.nativeSessionId
        if (event.model) this._lastModel = event.model
        this.emitEvent({
          type: 'init',
          cliSessionId: event.nativeSessionId,
          ...(event.model ? { model: event.model } : {})
        })
      }
      return
    }
    if (
      !isSafeNativeSessionId(event.nativeSessionId) ||
      !this._nativeSessionId || event.nativeSessionId !== this._nativeSessionId
    ) {
      this._failClosed('DSH_NATIVE_SESSION_MISMATCH')
      return
    }
    switch (event.type) {
      case 'agent-status':
        this.emitEvent({ type: 'status', status: event.status })
        break
      case 'assistant-committed':
        this._cacheGatewayResult(event.turnId, event.text)
        this.emitEvent({
          type: 'message', role: 'assistant', text: event.text, turnId: event.turnId
        })
        break
      case 'tool-request':
        this.emitEvent({
          type: 'tool_call',
          toolUseId: event.requestId,
          tool: event.tool,
          input: event.input,
          ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
          ...(event.command === undefined ? {} : { command: event.command })
        })
        break
      case 'tool-result':
        this.emitEvent({
          type: 'tool_result',
          toolUseId: event.requestId,
          status: event.status,
          isError: event.status !== 'completed'
        })
        break
      case 'usage':
        try {
          this._statsTotals.inputTokens = addSafeCounter(this._statsTotals.inputTokens, event.inputTokens)
          this._statsTotals.outputTokens = addSafeCounter(this._statsTotals.outputTokens, event.outputTokens)
          this._statsTotals.turns = addSafeCounter(this._statsTotals.turns, event.turns)
        } catch {
          this._failClosed('DSH_USAGE_INVALID')
          return
        }
        if (event.model) this._lastModel = event.model
        this.emitEvent({
          type: 'stats_update',
          usage: {
            inputTokens: this._statsTotals.inputTokens,
            outputTokens: this._statsTotals.outputTokens
          },
          costUsd: null,
          costAvailable: false,
          turns: this._statsTotals.turns,
          completedTurns: this._statsTotals.completedTurns,
          model: this._lastModel
        })
        break
      case 'turn-complete':
        this.emitEvent({ type: 'turn_complete', turnId: event.turnId, status: event.status })
        if (event.status === 'completed' && !this._completedTurnIds.has(event.turnId)) {
          this._completedTurnIds.add(event.turnId)
          this._completedTurnQueue.push(event.turnId)
          if (this._completedTurnQueue.length > 1_024) {
            this._completedTurnIds.delete(this._completedTurnQueue.shift())
          }
          try {
            this._statsTotals.completedTurns = addSafeCounter(this._statsTotals.completedTurns, 1)
          } catch {
            this._failClosed('DSH_USAGE_INVALID')
            return
          }
        }
        this.emitEvent({
          type: 'stats_update',
          usage: {
            inputTokens: this._statsTotals.inputTokens,
            outputTokens: this._statsTotals.outputTokens
          },
          costUsd: null,
          costAvailable: false,
          turns: this._statsTotals.turns,
          completedTurns: this._statsTotals.completedTurns,
          model: this._lastModel
        })
        this._emitGatewayTurnOutcome(event)
        break
      case 'attention':
        this.emitEvent({ type: 'attention', kind: event.kind, operation: event.operation })
        break
      case 'plan-snapshot':
        this._latestPlan = { markdown: event.markdown, capturedAt: Date.now() }
        break
      case 'result-snapshot':
        if (
          this._gatewayLastCompletedTurnId &&
          this._gatewayResults.get(this._gatewayLastCompletedTurnId)?.markdown === event.markdown
        ) {
          this._gatewayResults.get(this._gatewayLastCompletedTurnId).capturedAt = Date.now()
          this._latestResult = event.markdown
        }
        break
    }
  }

  _cacheGatewayResult(turnId, markdown) {
    if (typeof turnId !== 'string' || !turnId || typeof markdown !== 'string') return
    if (!this._gatewayResults.has(turnId)) this._gatewayResultOrder.push(turnId)
    this._gatewayResults.set(turnId, { markdown, capturedAt: Date.now() })
    while (this._gatewayResultOrder.length > 1_024) {
      this._gatewayResults.delete(this._gatewayResultOrder.shift())
    }
  }

  _emitGatewayTurnOutcome(event) {
    if (this._gatewayTerminalTurns.has(event.turnId)) return
    this._gatewayTerminalTurns.add(event.turnId)
    this._gatewayTerminalStatuses.set(event.turnId, event.status)
    this._gatewayTerminalTurnOrder.push(event.turnId)
    while (this._gatewayTerminalTurnOrder.length > 1_024) {
      const expiredTurnId = this._gatewayTerminalTurnOrder.shift()
      this._gatewayTerminalTurns.delete(expiredTurnId)
      this._gatewayTerminalStatuses.delete(expiredTurnId)
    }
    this._gatewayLastCompletedTurnId = event.turnId
    const type = event.status === 'completed'
      ? 'turn_completed'
      : event.status === 'interrupted' || event.status === 'aborted'
        ? 'turn_interrupted'
        : 'turn_failed'
    this.emitGatewayEvent({ type, turnId: event.turnId })
  }

  _emitGatewayStopped() {
    if (this._gatewayStopped) return
    this._gatewayStopped = true
    this.emitGatewayEvent({ type: 'session_stopped' })
  }

  _failClosed(code) {
    this._accepting = false
    this._state = 'stopping'
    this._emitGatewayStopped()
    this.emitEvent({ type: 'error', code, message: code })
    this._shutdown().catch(() => {})
  }

  async _decidePermission(request, epoch) {
    if (
      !this.engine || !this._accepting || epoch !== this._epoch ||
      request?.signal?.aborted
    ) {
      return { kind: 'deny', reason: 'UCLI permission handler unavailable' }
    }
    if (
      !isSafeNativeSessionId(request?.actor?.nativeSessionId) ||
      request.actor.nativeSessionId !== this._nativeSessionId
    ) {
      this._failClosed('DSH_NATIVE_SESSION_MISMATCH')
      return { kind: 'deny', reason: 'DSH native session mismatch' }
    }
    const decision = await this.engine.decide(this.session.id, {
      tool: request.tool.name,
      input: request.input,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      approvalRequired: request.approvalRequired,
      signal: request.signal
    })
    if (!this._accepting || epoch !== this._epoch || request?.signal?.aborted) {
      return { kind: 'deny', reason: 'UCLI permission request cancelled' }
    }
    return {
      kind: decision?.verdict === 'allow' ? 'allow' : 'deny',
      ...(typeof decision?.reason === 'string' ? { reason: decision.reason } : {})
    }
  }

  _onBridgeDisconnect(_error, epoch) {
    if (epoch !== this._epoch || this._shuttingDown) return
    this._failClosed('DSH_BRIDGE_DISCONNECTED')
  }

  _onPtyExit(proc, ptyExit, exitCode, epoch) {
    ptyExit.resolve(exitCode)
    if (this.ptyProc === proc) {
      this.ptyProc = null
      this._ptyExit = null
    }
    if (epoch !== this._epoch) return
    this._accepting = false
    this._emitGatewayStopped()
    this.emitEvent({ type: 'exit', code: exitCode })
    if (!this._shuttingDown) this._shutdown({ exitedProc: proc }).catch(() => {})
  }

  _shutdown({ exitedProc = null } = {}) {
    this._accepting = false
    if (this.webController) return this._shutdownWeb()
    if (this._shuttingDown) return this._cleanupPromise || Promise.resolve()
    this._shuttingDown = true
    const bridge = this.bridge
    const proc = this.ptyProc
    const ptyExit = this._ptyExit
    const exitPromise = ptyExit?.promise || Promise.resolve()
    this._epoch += 1
    const terminate = this.settings.terminatePtyTree || terminateOwnedPtyTree
    this._cleanupPromise = (async () => {
      let closeError = null
      let terminateError = null
      try {
        await bridge?.close?.()
        if (this.bridge === bridge) this.bridge = null
      } catch (error) {
        closeError = error
      }
      if (proc && proc !== exitedProc) {
        try {
          await terminate(proc, exitPromise)
        } catch (error) {
          if (!ptyExit?.settled) terminateError = error
        }
      }
      if (!terminateError && this.ptyProc === proc) this.ptyProc = null
      if (!terminateError && this._ptyExit === ptyExit) this._ptyExit = null
      if (closeError && terminateError) {
        const error = new AggregateError([closeError, terminateError], 'DSH cleanup failed')
        error.code = 'DSH_CLEANUP_FAILED'
        throw error
      }
      if (terminateError) throw terminateError
      if (closeError) throw closeError
    })()
    this._cleanupPromise.then(
      () => {
        this._shuttingDown = false
        this._cleanupPromise = null
      },
      () => {
        this._shuttingDown = false
        this._cleanupPromise = null
      }
    )
    return this._cleanupPromise
  }

  _shutdownWeb() {
    if (this._shuttingDown) return this._cleanupPromise || Promise.resolve()
    this._shuttingDown = true
    const controller = this.webController
    const epoch = this._epoch
    const startupErrorState = this.surfaceState?.status === 'error'
      ? this.surfaceState
      : null
    if (!startupErrorState) {
      this._onWebSurfaceState({
        kind: 'web', status: 'stopping', url: null, errorCode: null
      }, epoch)
    }
    this._epoch += 1
    const attempt = Promise.resolve().then(() => controller.stop())
    this._cleanupPromise = attempt
    attempt.then(
      () => {
        if (this.webController === controller) this.webController = null
        if (startupErrorState) {
          this.surfaceState = startupErrorState
        } else {
          this.surfaceState = Object.freeze({
            kind: 'web', status: 'stopped', url: null, errorCode: null
          })
          this.emitEvent({ type: 'surface_state', ...this.surfaceState })
        }
        this._shuttingDown = false
        this._cleanupPromise = null
      },
      () => {
        this.surfaceState = Object.freeze({
          kind: 'web', status: 'error', url: null,
          errorCode: 'DSH_WEB_CLEANUP_FAILED'
        })
        this.emitEvent({ type: 'surface_state', ...this.surfaceState })
        this._shuttingDown = false
        this._cleanupPromise = null
      }
    )
    return attempt
  }

  writeInput(data) {
    if (!this._accepting || !this.ptyProc) return false
    try {
      this.ptyProc.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(cols, rows) {
    if (!this._accepting || !this.ptyProc) return false
    try {
      this.ptyProc.resize(cols, rows)
      return true
    } catch {
      return false
    }
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise
    const activeStart = this._state === 'starting' ? this._startPromise : null
    this._disposed = true
    this._state = 'stopping'
    const attempt = (async () => {
      let cleanupError = null
      try { await this._shutdown() } catch (error) { cleanupError = error }
      if (activeStart) {
        try { await activeStart } catch {}
      }
      try {
        await this._shutdown()
        cleanupError = null
      } catch (error) {
        cleanupError = error
      }
      if (cleanupError) throw cleanupError
      await super.dispose()
      this._state = 'disposed'
    })()
    this._disposePromise = attempt
    attempt.then(
      () => {},
      () => { if (this._disposePromise === attempt) this._disposePromise = null }
    )
    return attempt
  }

  async sendTurn(text) {
    if (this._surfacePreference === 'web') {
      throw codedError('DSH_WEB_NATIVE_OWNERSHIP')
    }
    if (!this._accepting || !this.bridge || !this._nativeSessionId) {
      throw codedError('DSH_BRIDGE_DISCONNECTED')
    }
    return this.bridge.request('turn.send', {
      nativeSessionId: this._nativeSessionId,
      text
    })
  }

  get gatewayCapabilities() {
    if (this._surfacePreference === 'web') {
      return { decisions: false, planSnapshot: false, resultSnapshot: false }
    }
    return { decisions: true, planSnapshot: true, resultSnapshot: true }
  }

  isGatewayLive() {
    return Boolean(
      this._accepting &&
      this.bridge &&
      isSafeNativeSessionId(this._nativeSessionId) &&
      this.bridge.isConnected?.() === true
    )
  }

  async getLatestPlanSnapshot(decisionId) {
    if (this._surfacePreference === 'web') return null
    let snapshot = this._latestPlan
    if (!snapshot && this.isGatewayLive()) {
      try {
        const result = await this.bridge.request('snapshot.plan', {
          nativeSessionId: this._nativeSessionId
        })
        if (this.isGatewayLive() && typeof result?.markdown === 'string') {
          snapshot = { markdown: result.markdown, capturedAt: Date.now() }
          this._latestPlan = snapshot
        }
      } catch {}
    }
    if (!snapshot) return null
    return {
      kind: 'plan_review',
      title: 'DeepSeek Harness plan',
      markdown: snapshot.markdown,
      provider: 'deepseek-harness',
      nativeSessionId: this._nativeSessionId,
      decisionId,
      capturedAt: snapshot.capturedAt
    }
  }

  async getLatestResultSnapshot(turnId) {
    if (this._surfacePreference === 'web') return null
    let snapshot = this._gatewayResults.get(turnId)
    if (
      !snapshot &&
      this._gatewayTerminalStatuses.get(turnId) === 'completed' &&
      this.isGatewayLive()
    ) {
      try {
        const result = await this.bridge.request('snapshot.result', {
          nativeSessionId: this._nativeSessionId
        })
        if (
          this.isGatewayLive() &&
          result?.turnId === turnId &&
          typeof result.markdown === 'string'
        ) {
          this._cacheGatewayResult(turnId, result.markdown)
          snapshot = this._gatewayResults.get(turnId)
        }
      } catch {}
    }
    if (!snapshot) return null
    return {
      kind: 'result',
      title: 'DeepSeek Harness result',
      markdown: snapshot.markdown,
      provider: 'deepseek-harness',
      nativeSessionId: this._nativeSessionId,
      turnId,
      capturedAt: snapshot.capturedAt
    }
  }

  async interrupt() {
    if (this._surfacePreference === 'web') {
      throw codedError('DSH_WEB_NATIVE_OWNERSHIP')
    }
    if (!this._accepting || !this.bridge || !this._nativeSessionId) {
      throw codedError('DSH_BRIDGE_DISCONNECTED')
    }
    return this.bridge.request('turn.interrupt', {
      nativeSessionId: this._nativeSessionId
    })
  }

  resume(cliSessionId) {
    if (this._surfacePreference === 'web') {
      return Promise.reject(codedError('DSH_WEB_NATIVE_OWNERSHIP'))
    }
    if (!isSafeNativeSessionId(cliSessionId)) throw codedError('DSH_NATIVE_SESSION_INVALID')
    if (this._resumePromise || this._state === 'starting' || this._state === 'stopping') {
      return Promise.reject(codedError('DSH_LIFECYCLE_BUSY'))
    }
    const transition = this._resume(cliSessionId)
    this._resumePromise = transition
    transition.then(
      () => { if (this._resumePromise === transition) this._resumePromise = null },
      () => { if (this._resumePromise === transition) this._resumePromise = null }
    )
    return transition
  }

  async _resume(cliSessionId) {
    const previousSessionId = this.session.cliSessionId || null
    const previousNativeSessionId = this._nativeSessionId
    this._state = 'stopping'
    this._emitGatewayStopped()
    await this._shutdown()
    this.session.cliSessionId = cliSessionId
    this._nativeSessionId = cliSessionId
    this._completedTurnIds.clear()
    this._completedTurnQueue.length = 0
    this._latestPlan = null
    this._latestResult = null
    this._gatewayResults.clear()
    this._gatewayResultOrder.length = 0
    this._gatewayTerminalTurns.clear()
    this._gatewayTerminalTurnOrder.length = 0
    this._gatewayTerminalStatuses.clear()
    this._gatewayLastCompletedTurnId = null
    this._startPromise = null
    this._disposed = false
    this._state = 'idle'
    try {
      return await this.start()
    } catch (error) {
      this.session.cliSessionId = previousSessionId
      this._nativeSessionId = previousNativeSessionId
      throw error
    }
  }

  respondDecision() {
    if (this._surfacePreference === 'web') {
      return Promise.reject(codedError('DSH_WEB_NATIVE_OWNERSHIP'))
    }
    return super.respondDecision(...arguments)
  }
}

export const deepSeekHarnessDescriptor = Object.freeze({
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',
  icon: 'DSH',
  models: ['native'],
  costAvailable: false,
  capabilities: BRIDGED_DSH_TUI_CAPABILITIES,
  capabilitiesForConfig: config => config?.surfacePreference === 'web'
    ? DSH_WEB_CAPABILITIES
    : BRIDGED_DSH_TUI_CAPABILITIES,
  normalizeSessionConfig: normalizeDshSessionConfig,
  create: (options) => new DeepSeekHarnessAdapter(options)
})
