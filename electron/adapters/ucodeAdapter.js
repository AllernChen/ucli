import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { posix, win32 } from 'path'
import { spawnSync } from 'child_process'

import { OpenCodeAdapter } from './openCodeAdapter.js'
import { listSessionsWithLaunch } from '../openCodeSessions.js'

function findUCodeOnPath() {
  const result = spawnSync('where.exe', ['ucode'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

function findNodeOnPath() {
  const result = spawnSync('where.exe', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
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

export function resolveUCodeCmdShim(
  shimPath,
  content,
  pathExists = existsSync,
  nodeCandidates = null
) {
  const directory = win32.dirname(shimPath)
  const candidates = [...String(content || '').matchAll(/"(%~?dp0%?[^"\r\n]+)"/gi)]
    .map((match) => expandShimPath(match[1], directory))
    .filter((path) => path && isWithinDirectory(path, directory) && pathExists(path))

  const executable = candidates.find((path) =>
    win32.basename(path).toLowerCase() === 'ucode.exe' &&
    path.toLowerCase().includes(`${win32.sep}@ucode${win32.sep}`)
  )
  if (executable) return { file: executable, prefixArgs: [] }

  const entry = candidates.find((path) =>
    path.toLowerCase().endsWith(
      `${win32.sep}node_modules${win32.sep}@ucode${win32.sep}cli${win32.sep}bin${win32.sep}ucode`
    )
  )
  if (!entry) return null

  const node = win32.join(directory, 'node.exe')
  if (pathExists(node)) return { file: node, prefixArgs: [entry] }
  const systemNode = (nodeCandidates || findNodeOnPath()).find((path) =>
    win32.basename(path).toLowerCase() === 'node.exe' && pathExists(path)
  )
  return systemNode ? { file: systemNode, prefixArgs: [entry] } : null
}

export function resolveUCodeLaunch(
  candidates = null,
  pathExists = existsSync,
  platform = process.platform,
  readShim = readFileSync,
  homeDirectory = homedir()
) {
  if (platform !== 'win32') {
    const installed = posix.join(homeDirectory, '.ucode', 'bin', 'ucode')
    return {
      file: pathExists(installed) ? installed : 'ucode',
      prefixArgs: []
    }
  }
  const installed = win32.join(homeDirectory, '.ucode', 'bin', 'ucode.exe')
  if (pathExists(installed)) return { file: installed, prefixArgs: [] }
  const paths = candidates || findUCodeOnPath()
  const direct = paths.find((path) =>
    path.toLowerCase().endsWith('.exe') && pathExists(path)
  )
  if (direct) return { file: direct, prefixArgs: [] }

  for (const shim of paths.filter((path) => path.toLowerCase().endsWith('.cmd'))) {
    try {
      const launch = resolveUCodeCmdShim(shim, readShim(shim, 'utf8'), pathExists)
      if (launch) return launch
    } catch {}
  }
  throw new Error('safe U-Code executable not found')
}

export function createUCodeRuntime(overrides = {}) {
  const resolveLaunch = overrides.resolveLaunch || resolveUCodeLaunch
  const listSessions = overrides.listSessions || (async (cwd) => {
    try {
      return await listSessionsWithLaunch(cwd, resolveLaunch())
    } catch (error) {
      if (error?.message === 'safe U-Code executable not found') return []
      throw error
    }
  })
  return {
    id: 'ucode',
    displayName: 'U-Code',
    clientEnv: 'UCODE_CLIENT',
    configEnv: 'UCODE_CONFIG_CONTENT',
    resolveLaunch,
    listSessions,
    ...overrides
  }
}

export const UCODE_RUNTIME = createUCodeRuntime()

export class UCodeAdapter extends OpenCodeAdapter {
  constructor(options) {
    super(options, UCODE_RUNTIME)
  }
}

export const ucodeDescriptor = {
  id: 'ucode',
  displayName: 'U-Code',
  icon: '🟠',
  models: ['default'],
  costAvailable: false,
  resolveLaunch: resolveUCodeLaunch,
  listNativeSessions: UCODE_RUNTIME.listSessions,
  create: (options) => new UCodeAdapter(options)
}
