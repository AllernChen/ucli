import path from 'node:path'

import { BaseAdapter } from './cliAdapter.js'
import {
  DSH_UNAVAILABLE_CAPABILITIES,
  DSH_WEB_CAPABILITIES
} from './adapterCapabilities.js'
import { normalizeDshSessionConfig } from './adapterSessionConfig.js'
import {
  inspectDshRuntime,
  launchDshWebSurface,
  normalizeDshWebSurfaceState,
  SUPPORTED_DSH_VERSION
} from './deepSeekHarnessRuntime.js'

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function webErrorState(error) {
  const stableErrors = new Set([
    'DSH_WEB_SPAWN_FAILED',
    'DSH_WEB_START_TIMEOUT',
    'DSH_WEB_READY_URL_INVALID',
    'DSH_WEB_CLEANUP_FAILED'
  ])
  return {
    kind: 'web',
    status: 'error',
    url: null,
    errorCode: stableErrors.has(error?.code)
      ? error.code
      : 'DSH_WEB_RUNTIME_UNAVAILABLE'
  }
}

export class DeepSeekHarnessAdapter extends BaseAdapter {
  constructor({ session, engine, settings = {} }) {
    super({ id: 'deepseek-harness', displayName: 'DeepSeek Harness', session, engine })
    this.settings = settings
    this._surfacePreference = session.adapterConfig?.surfacePreference === 'web'
      ? 'web'
      : 'legacy-tui'
    this.session.capabilities = this._surfacePreference === 'web'
      ? DSH_WEB_CAPABILITIES
      : DSH_UNAVAILABLE_CAPABILITIES
    this.surfaceState = this._surfacePreference === 'web'
      ? Object.freeze({ kind: 'web', status: 'starting', url: null, errorCode: null })
      : null
    // Kept as inert compatibility fields for renderer/orchestrator cleanup checks.
    this.ptyProc = null
    this.bridge = null
    this.webController = null
    this._epoch = 0
    this._state = 'idle'
    this._startPromise = null
    this._disposePromise = null
    this._cleanupPromise = null
  }

  start() {
    if (this._surfacePreference !== 'web') {
      return Promise.reject(codedError('DSH_TUI_UNAVAILABLE'))
    }
    if (this._startPromise) return this._startPromise
    if (this._disposed || this._state !== 'idle') {
      return Promise.reject(codedError('DSH_ADAPTER_STOPPED'))
    }
    this._state = 'starting'
    const attempt = this._startWeb()
    this._startPromise = attempt
    attempt.then(
      () => {
        if (this._startPromise === attempt) this._state = 'ready'
      },
      () => {
        if (this._startPromise === attempt) {
          this._startPromise = null
          if (!this._disposed) this._state = 'idle'
        }
      }
    )
    return attempt
  }

  async _startWeb() {
    this._disposed = false
    const epoch = ++this._epoch
    try {
      const inspectRuntime = this.settings.inspectRuntime || inspectDshRuntime
      const runtime = await inspectRuntime()
      this._assertStarting(epoch)
      if (
        !runtime?.compatible ||
        runtime.version !== SUPPORTED_DSH_VERSION ||
        !path.isAbsolute(runtime.launch?.file || '') ||
        !Array.isArray(runtime.launch.prefixArgs) ||
        !runtime.launch.prefixArgs.every(value => path.isAbsolute(value)) ||
        !path.isAbsolute(runtime.home || '')
      ) {
        throw codedError('DSH_VERSION_UNSUPPORTED')
      }
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
    } catch (error) {
      if (this.surfaceState?.status === 'starting') {
        this._onWebSurfaceState(webErrorState(error), epoch)
      }
      try {
        await this._shutdownWeb()
      } catch (cleanupError) {
        error.cleanupCode = cleanupError?.code || 'DSH_WEB_CLEANUP_FAILED'
      }
      throw error
    }
  }

  _isStarting(epoch) {
    return epoch === this._epoch && !this._disposed && this._state === 'starting'
  }

  _assertStarting(epoch) {
    if (!this._isStarting(epoch)) throw codedError('DSH_ADAPTER_STOPPED')
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

  _shutdownWeb() {
    if (this._cleanupPromise) return this._cleanupPromise
    const controller = this.webController
    if (!controller) return Promise.resolve()
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
        if (this._cleanupPromise === attempt) this._cleanupPromise = null
      },
      () => {
        this.surfaceState = Object.freeze({
          kind: 'web', status: 'error', url: null,
          errorCode: 'DSH_WEB_CLEANUP_FAILED'
        })
        this.emitEvent({ type: 'surface_state', ...this.surfaceState })
        if (this._cleanupPromise === attempt) this._cleanupPromise = null
      }
    )
    return attempt
  }

  writeInput() {
    return false
  }

  resize() {
    return false
  }

  async dispose() {
    if (this._disposePromise) return this._disposePromise
    this._disposed = true
    this._state = 'stopping'
    const activeStart = this._startPromise
    const attempt = (async () => {
      let cleanupError = null
      try {
        await this._shutdownWeb()
        cleanupError = null
      } catch (error) {
        cleanupError = error
      }
      if (activeStart) {
        try { await activeStart } catch {}
      }
      try {
        await this._shutdownWeb()
        cleanupError = null
      } catch (error) {
        cleanupError = error
      }
      if (cleanupError) throw cleanupError
      await super.dispose()
      this._state = 'disposed'
    })()
    this._disposePromise = attempt
    attempt.catch(() => {
      if (this._disposePromise === attempt) this._disposePromise = null
    })
    return attempt
  }

  async sendTurn() {
    throw codedError(this._surfacePreference === 'web'
      ? 'DSH_WEB_NATIVE_OWNERSHIP'
      : 'DSH_TUI_UNAVAILABLE')
  }

  async interrupt() {
    throw codedError(this._surfacePreference === 'web'
      ? 'DSH_WEB_NATIVE_OWNERSHIP'
      : 'DSH_TUI_UNAVAILABLE')
  }

  resume() {
    return Promise.reject(codedError(this._surfacePreference === 'web'
      ? 'DSH_WEB_NATIVE_OWNERSHIP'
      : 'DSH_TUI_UNAVAILABLE'))
  }

  respondDecision() {
    return Promise.reject(codedError(this._surfacePreference === 'web'
      ? 'DSH_WEB_NATIVE_OWNERSHIP'
      : 'DSH_TUI_UNAVAILABLE'))
  }

  get gatewayCapabilities() {
    return { decisions: false, planSnapshot: false, resultSnapshot: false }
  }

  isGatewayLive() {
    return false
  }

  getLatestPlanSnapshot() {
    return null
  }

  getLatestResultSnapshot() {
    return null
  }
}

export const deepSeekHarnessDescriptor = Object.freeze({
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',
  icon: 'DSH',
  models: ['native'],
  costAvailable: false,
  capabilities: DSH_WEB_CAPABILITIES,
  capabilitiesForConfig: config => config?.surfacePreference === 'web'
    ? DSH_WEB_CAPABILITIES
    : DSH_UNAVAILABLE_CAPABILITIES,
  normalizeSessionConfig: normalizeDshSessionConfig,
  create: options => new DeepSeekHarnessAdapter(options)
})
