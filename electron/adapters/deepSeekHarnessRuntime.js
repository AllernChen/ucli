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

function runtimeError(code) {
  return Object.assign(new Error(code), { code })
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
