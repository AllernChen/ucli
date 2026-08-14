import { spawn } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { validateDshProfileName as validateSessionProfileName } from './adapterSessionConfig.js'

export const SUPPORTED_DSH_VERSION = '0.1.0-rc.6'
export const DSH_BRIDGE_VERSION = '0.11.0'

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DSH_BIN_PATH = 'lib/bin.js'
const MAX_MANIFEST_BYTES = 1024 * 1024
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u
const DSH_WEB_READY_LINE = /^dsh web: http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u
const DSH_WEB_OUTPUT_LIMIT = 16 * 1024
const DSH_WEB_SURFACE_STATUSES = new Set([
  'starting', 'ready', 'stopping', 'stopped', 'error'
])
const DSH_WEB_SURFACE_ERRORS = new Set([
  'DSH_WEB_SPAWN_FAILED',
  'DSH_WEB_RUNTIME_UNAVAILABLE',
  'DSH_WEB_START_TIMEOUT',
  'DSH_WEB_READY_URL_INVALID',
  'DSH_WEB_CLEANUP_FAILED'
])

function runtimeError(code) {
  return Object.assign(new Error(code), { code })
}

export function parseDshWebReadyUrl(line) {
  if (typeof line !== 'string') return null
  const match = DSH_WEB_READY_LINE.exec(line)
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65_535
    ? `http://127.0.0.1:${port}`
    : null
}

export function normalizeDshWebSurfaceState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const status = input.status
  if (!DSH_WEB_SURFACE_STATUSES.has(status)) return null
  if (status === 'ready') {
    const url = parseDshWebReadyUrl(`dsh web: ${input.url}`)
    if (!url || url !== input.url || input.errorCode != null) return null
    return { kind: 'web', status, url, errorCode: null }
  }
  if (status === 'error') {
    if (!DSH_WEB_SURFACE_ERRORS.has(input.errorCode) || input.url != null) return null
    return { kind: 'web', status, url: null, errorCode: input.errorCode }
  }
  if (input.url != null || input.errorCode != null) return null
  return { kind: 'web', status, url: null, errorCode: null }
}

function dshWebEnvironment(baseEnv, runtime) {
  const env = { ...(baseEnv || process.env) }
  for (const key of Object.keys(env)) {
    if (
      /^UCLI_DSH_BRIDGE_/iu.test(key) ||
      /^ELECTRON_RUN_AS_NODE$/iu.test(key) ||
      /^DSH_HOME$/iu.test(key)
    ) {
      delete env[key]
    }
  }
  env.DSH_HOME = runtime.home
  if (runtime.launch.prefixArgs.length > 0) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function launchDshWebSurface({
  runtime,
  cwd,
  env = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  terminateProcessTree = (child, exitPromise) => terminateDshWebProcessTree(
    child, exitPromise, { platform }
  ),
  startTimeoutMs = 60_000,
  maxOutputBytes = DSH_WEB_OUTPUT_LIMIT,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onState = () => {},
  onExit = () => {}
} = {}) {
  if (
    !path.isAbsolute(runtime?.launch?.file || '') ||
    !Array.isArray(runtime?.launch?.prefixArgs) ||
    !runtime.launch.prefixArgs.every(value => path.isAbsolute(value)) ||
    !path.isAbsolute(runtime?.home || '') ||
    !path.isAbsolute(cwd || '')
  ) throw runtimeError('DSH_VERSION_UNSUPPORTED')

  const startingState = Object.freeze({
    kind: 'web', status: 'starting', url: null, errorCode: null
  })
  let state = startingState
  let active = true
  let owned = true
  let readySettled = false
  let startTimer = null
  let stopPromise = null
  let cleanupPromise = null
  let exitHandling = false
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutBuffer = Buffer.alloc(0)
  let resolveReady
  let rejectReady
  let resolveExit
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const exit = new Promise(resolve => { resolveExit = resolve })
  const args = [
    ...runtime.launch.prefixArgs,
    'web', '--host', '127.0.0.1', '--port', '0'
  ]
  let child
  try {
    child = spawnProcess(runtime.launch.file, args, {
      cwd,
      env: dshWebEnvironment(env, runtime),
      shell: false,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw runtimeError('DSH_WEB_SPAWN_FAILED')
  }

  const publish = next => {
    state = Object.freeze({ ...next })
    onState(state)
  }
  const removeStartupListeners = () => {
    child.stdout?.removeListener?.('data', onStdout)
    child.stderr?.removeListener?.('data', onStderr)
  }
  const clearStartup = () => {
    if (startTimer !== null) clearTimer(startTimer)
    startTimer = null
    removeStartupListeners()
    stdoutBuffer = Buffer.alloc(0)
  }
  const rejectStart = error => {
    if (readySettled) return
    readySettled = true
    rejectReady(error)
  }
  const resolveStart = url => {
    if (readySettled || !active) return
    readySettled = true
    clearStartup()
    child.stdout?.resume?.()
    child.stderr?.resume?.()
    const next = { kind: 'web', status: 'ready', url, errorCode: null }
    publish(next)
    resolveReady(state)
  }
  const cleanupOwned = async () => {
    if (!owned) return true
    if (cleanupPromise) return cleanupPromise
    const attempt = (async () => {
      const confirmed = await terminateProcessTree(child, exit)
      if (confirmed !== true) throw runtimeError('DSH_WEB_CLEANUP_FAILED')
      owned = false
      return true
    })()
    cleanupPromise = attempt
    try {
      return await attempt
    } catch (error) {
      if (cleanupPromise === attempt) cleanupPromise = null
      throw error
    }
  }
  const failStart = code => {
    if (!active || readySettled) return
    active = false
    clearStartup()
    publish({ kind: 'web', status: 'error', url: null, errorCode: code })
    const error = runtimeError(code)
    Promise.resolve(cleanupOwned()).then(
      () => rejectStart(error),
      cleanupError => {
        error.cleanupCode = cleanupError?.code || 'DSH_WEB_CLEANUP_FAILED'
        rejectStart(error)
      }
    )
  }
  const consumeLine = bytes => {
    let line
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      failStart('DSH_WEB_READY_URL_INVALID')
      return
    }
    const url = parseDshWebReadyUrl(line)
    if (url) resolveStart(url)
    else if (line.startsWith('dsh web:')) failStart('DSH_WEB_READY_URL_INVALID')
  }
  function onStdout(chunk) {
    if (!active || readySettled) return
    const bytes = Buffer.from(chunk)
    const remaining = Math.max(0, maxOutputBytes - stdoutBytes)
    const consumed = bytes.subarray(0, remaining)
    stdoutBytes += consumed.length
    stdoutBuffer = Buffer.concat([stdoutBuffer, consumed])
    let newline
    while (active && !readySettled && (newline = stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = stdoutBuffer.subarray(0, newline)
      stdoutBuffer = stdoutBuffer.subarray(newline + 1)
      consumeLine(line)
    }
    if (active && !readySettled && consumed.length < bytes.length) {
      failStart('DSH_WEB_READY_URL_INVALID')
    }
  }
  function onStderr(chunk) {
    if (!active || readySettled) return
    stderrBytes += Buffer.byteLength(chunk)
    if (stderrBytes > maxOutputBytes) failStart('DSH_WEB_READY_URL_INVALID')
  }
  const onChildError = () => failStart('DSH_WEB_SPAWN_FAILED')
  const onChildClose = code => {
    resolveExit(Number.isInteger(code) ? code : -1)
    if (!active || exitHandling) return
    exitHandling = true
    active = false
    clearStartup()
    if (platform === 'win32') {
      owned = false
      publish({ kind: 'web', status: 'stopped', url: null, errorCode: null })
      if (!readySettled) rejectStart(runtimeError('DSH_WEB_READY_URL_INVALID'))
      onExit(Number.isInteger(code) ? code : -1)
      return
    }
    publish({ kind: 'web', status: 'stopping', url: null, errorCode: null })
    Promise.resolve(cleanupOwned()).then(
      () => {
        publish({ kind: 'web', status: 'stopped', url: null, errorCode: null })
        if (!readySettled) rejectStart(runtimeError('DSH_WEB_READY_URL_INVALID'))
        onExit(Number.isInteger(code) ? code : -1)
      },
      error => {
        publish({
          kind: 'web', status: 'error', url: null,
          errorCode: 'DSH_WEB_CLEANUP_FAILED'
        })
        if (!readySettled) {
          const startError = runtimeError('DSH_WEB_READY_URL_INVALID')
          startError.cleanupCode = error?.code || 'DSH_WEB_CLEANUP_FAILED'
          rejectStart(startError)
        }
      }
    )
  }

  child.stdout?.on?.('data', onStdout)
  child.stderr?.on?.('data', onStderr)
  child.once('error', onChildError)
  child.once('close', onChildClose)
  publish(startingState)
  startTimer = setTimer(() => failStart('DSH_WEB_START_TIMEOUT'), startTimeoutMs)
  startTimer?.unref?.()

  return {
    ready,
    get state() { return state },
    async stop() {
      if (stopPromise) return stopPromise
      active = false
      clearStartup()
      child.removeListener?.('error', onChildError)
      publish({ kind: 'web', status: 'stopping', url: null, errorCode: null })
      if (!readySettled) rejectStart(runtimeError('DSH_WEB_READY_URL_INVALID'))
      const attempt = (async () => {
        try {
          await cleanupOwned()
          publish({ kind: 'web', status: 'stopped', url: null, errorCode: null })
        } catch (error) {
          publish({
            kind: 'web', status: 'error', url: null,
            errorCode: 'DSH_WEB_CLEANUP_FAILED'
          })
          throw error
        }
      })()
      stopPromise = attempt
      try {
        await attempt
      } catch (error) {
        stopPromise = null
        throw error
      }
    }
  }
}

function expandHomePrefix(value, homeDirectory) {
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDirectory, value.slice(2))
  }
  return value
}

export function resolveDshHome({
  configured,
  env = process.env,
  homeDirectory = homedir(),
  cwd = process.cwd()
} = {}) {
  const fromEnvironment = env.DSH_HOME
  const selected = configured ?? (
    typeof fromEnvironment === 'string' && fromEnvironment.trim().length > 0
      ? fromEnvironment
      : path.join(homeDirectory, '.dsh')
  )
  if (typeof selected !== 'string' || selected.trim().length === 0) throw runtimeError('DSH_HOME_INVALID')
  return path.resolve(cwd, expandHomePrefix(selected, homeDirectory))
}

export function validateDshProfileName(value) {
  try {
    return validateSessionProfileName(value)
  } catch {
    throw runtimeError('DSH_PROFILE_INVALID')
  }
}

function isRegularUnlinkedFile(file) {
  try {
    const stat = lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function boundedJson(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null
  const value = JSON.parse(readFileSync(file, 'utf8'))
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function pathEntries(env, platform) {
  const delimiter = platform === 'win32' ? ';' : ':'
  return String(env.PATH || '').split(delimiter).filter(Boolean)
}

function windowsCommandCandidates(directory, command, env) {
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(value => value.toLowerCase())
  return extensions.map(extension => path.win32.join(directory, `${command}${extension}`))
}

function resolveWindowsDshShim(shim, nodeExecutable) {
  if (path.win32.extname(shim).toLowerCase() !== '.cmd') return null
  const packageDirectory = path.win32.join(
    path.win32.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh'
  )
  const manifestPath = path.win32.join(packageDirectory, 'package.json')
  const entryPath = path.win32.join(packageDirectory, 'lib', 'bin.js')
  let manifest
  try {
    manifest = boundedJson(manifestPath)
  } catch {
    return null
  }
  const declaredBin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh
  let canonicalPackage
  let canonicalManifest
  let canonicalEntry
  try {
    canonicalPackage = realpathSync(packageDirectory)
    canonicalManifest = realpathSync(manifestPath)
    canonicalEntry = realpathSync(entryPath)
  } catch {
    return null
  }
  if (
    manifest?.name !== DSH_PACKAGE_NAME ||
    typeof manifest?.version !== 'string' ||
    manifest.version.length > 64 ||
    !VERSION_PATTERN.test(manifest.version) ||
    String(declaredBin || '').replaceAll('\\', '/') !== DSH_BIN_PATH ||
    !isRegularUnlinkedFile(entryPath) ||
    !isRegularUnlinkedFile(nodeExecutable) ||
    path.win32.dirname(canonicalManifest).toLowerCase() !== canonicalPackage.toLowerCase() ||
    !canonicalEntry.toLowerCase().startsWith(`${canonicalPackage.toLowerCase()}\\`)
  ) return null
  return {
    file: path.resolve(realpathSync(nodeExecutable)),
    prefixArgs: [path.resolve(canonicalEntry)]
  }
}

export function resolveDshLaunch({
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath
} = {}) {
  for (const directory of pathEntries(env, platform)) {
    if (!path.isAbsolute(directory)) continue
    if (platform === 'win32') {
      for (const candidate of windowsCommandCandidates(directory, 'dsh', env)) {
        if (!isRegularUnlinkedFile(candidate)) continue
        const extension = path.win32.extname(candidate).toLowerCase()
        if (extension === '.cmd') {
          const launch = resolveWindowsDshShim(candidate, nodeExecutable)
          if (launch) return launch
          continue
        }
      }
      continue
    }
    const candidate = path.join(directory, 'dsh')
    try {
      accessSync(candidate, fsConstants.X_OK)
      const resolved = realpathSync(candidate)
      if (lstatSync(resolved).isFile()) return { file: resolved, prefixArgs: [] }
    } catch {}
  }
  return null
}

export function resolvePnpmAvailability({ env = process.env, platform = process.platform } = {}) {
  for (const directory of pathEntries(env, platform)) {
    if (!path.isAbsolute(directory)) continue
    if (platform === 'win32') {
      if (windowsCommandCandidates(directory, 'pnpm', env).some(isRegularUnlinkedFile)) return true
      continue
    }
    const candidate = path.join(directory, 'pnpm')
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (lstatSync(realpathSync(candidate)).isFile()) return true
    } catch {}
  }
  return false
}

function waitForProcess(file, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { ...options, shell: false, windowsHide: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', code => resolve(code === 0))
  })
}

async function terminateDefaultProcessTree(child, platform) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return false
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
    if (!isRegularUnlinkedFile(taskkill)) return false
    return waitForProcess(taskkill, ['/pid', String(child.pid), '/t', '/f'])
  }
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      return error?.code !== 'ESRCH'
    }
  }
  const waitUntilGone = async timeoutMs => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!groupAlive()) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return !groupAlive()
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
    if (await waitUntilGone(1000)) return true
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    return waitUntilGone(1000)
  } catch {
    try {
      child.kill('SIGTERM')
      return true
    } catch {
      return false
    }
  }
}

function waitForWebExit(exitPromise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(runtimeError('DSH_WEB_EXIT_TIMEOUT')), timeoutMs)
    timer.unref?.()
    Promise.resolve(exitPromise).then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

async function waitForDshWebGroupGone(pid, timeoutMs, killProcess = process.kill) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      killProcess(-pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return true
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  try {
    killProcess(-pid, 0)
    return false
  } catch (error) {
    if (error?.code === 'ESRCH') return true
    throw error
  }
}

export async function terminateDshWebProcessTree(child, exitPromise, {
  platform = process.platform,
  graceMs = 7_000,
  forceWaitMs = 3_000,
  killProcess = process.kill,
  waitForExit = waitForWebExit,
  waitForGroupGone = (pid, timeoutMs) => waitForDshWebGroupGone(
    pid, timeoutMs, killProcess
  ),
  runWindowsTreeKill
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    throw runtimeError('DSH_WEB_CLEANUP_FAILED')
  }
  if (platform === 'win32') {
    const killTree = runWindowsTreeKill || (async pid => {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
      if (!isRegularUnlinkedFile(taskkill)) return false
      return waitForProcess(taskkill, ['/pid', String(pid), '/t', '/f'])
    })
    if (await killTree(child.pid) !== true) throw runtimeError('DSH_WEB_CLEANUP_FAILED')
    try {
      await waitForExit(exitPromise, forceWaitMs)
    } catch (error) {
      if (error?.code !== 'DSH_WEB_EXIT_TIMEOUT') throw error
      throw runtimeError('DSH_WEB_CLEANUP_FAILED')
    }
    return true
  }

  try {
    killProcess(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'ESRCH') return true
    throw error
  }
  if (await waitForGroupGone(child.pid, graceMs)) return true
  try {
    killProcess(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code === 'ESRCH') return true
    throw error
  }
  if (await waitForGroupGone(child.pid, forceWaitMs)) return true
  throw runtimeError('DSH_WEB_CLEANUP_FAILED')
}

export function runResolvedProcess(file, args, {
  env = process.env,
  cwd,
  timeoutMs = 10_000,
  maxOutputBytes = 16 * 1024,
  shell = false,
  platform = process.platform,
  spawnProcess = spawn,
  terminateProcessTree = child => terminateDefaultProcessTree(child, platform),
  terminationWaitMs = 5000
} = {}) {
  return new Promise(resolve => {
    const child = spawnProcess(file, args, {
      cwd,
      env,
      shell,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let timer
    let terminationTimer
    let timedOut = false
    let terminationPromise = null
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) return current
      return Buffer.concat([current, Buffer.from(chunk)]).subarray(0, maxOutputBytes)
    }
    const finish = (code, terminationConfirmed = true) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), terminationConfirmed })
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', async () => {
      if (!timedOut) return finish(-1, true)
      const confirmed = terminationPromise
        ? await terminationPromise.catch(() => false)
        : false
      finish(-1, confirmed)
    })
    child.once('close', async code => {
      if (!timedOut) return finish(code ?? -1, true)
      const confirmed = await terminationPromise.catch(() => false)
      finish(-1, confirmed)
    })
    timer = setTimeout(() => {
      timedOut = true
      terminationPromise = Promise.resolve(terminateProcessTree(child))
      terminationTimer = setTimeout(() => finish(-1, false), terminationWaitMs)
    }, timeoutMs)
  })
}

function firstLine(value = '') {
  return String(value).split(/\r?\n/u).map(line => line.trim()).find(Boolean) || ''
}

export async function inspectDshRuntime({
  configuredHome,
  env = process.env,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  resolveLaunch = () => resolveDshLaunch({ env }),
  resolvePnpm = () => resolvePnpmAvailability({ env }),
  run = runResolvedProcess
} = {}) {
  const home = resolveDshHome({ configured: configuredHome, env, homeDirectory, cwd })
  const launch = resolveLaunch()
  const pnpmAvailable = Boolean(resolvePnpm())
  if (!launch) {
    return {
      installed: false,
      compatible: false,
      version: '',
      reason: 'not-installed',
      pnpmAvailable,
      launch: null,
      home
    }
  }
  const processEnvironment = {
    ...env,
    DSH_HOME: home,
    ...(launch.prefixArgs?.length ? { ELECTRON_RUN_AS_NODE: '1' } : {})
  }
  let result
  try {
    result = await run(
      launch.file,
      [...(launch.prefixArgs || []), '--version'],
      { env: processEnvironment, shell: false, timeoutMs: 10_000 }
    )
  } catch {
    result = { code: -1, stdout: '', stderr: '' }
  }
  const candidateVersion = result.code === 0 ? firstLine(result.stdout || result.stderr) : ''
  const version = candidateVersion.length <= 64 && VERSION_PATTERN.test(candidateVersion)
    ? candidateVersion
    : ''
  const reason = result.code !== 0 || !version
    ? 'version-unreadable'
    : version === SUPPORTED_DSH_VERSION ? '' : 'unsupported-version'
  return {
    installed: true,
    compatible: reason === '',
    version,
    reason,
    pnpmAvailable,
    launch,
    home
  }
}
