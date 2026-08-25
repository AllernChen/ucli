import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { posix, win32 } from 'path'
import { spawnSync } from 'child_process'

import { OpenCodeAdapter } from './openCodeAdapter.js'
import { listSessionsWithLaunch } from '../openCodeSessions.js'

function findUCodeOnPath(platform = process.platform) {
  const command = platform === 'win32'
    ? { file: 'where.exe', args: ['ucode'] }
    : { file: '/bin/sh', args: ['-lc', 'command -v ucode'] }
  const result = spawnSync(command.file, command.args, {
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

function findNpmUCode(platform = process.platform) {
  const command = platform === 'win32'
    ? {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm prefix -g']
      }
    : { file: '/bin/sh', args: ['-lc', 'npm prefix -g'] }
  const result = spawnSync(command.file, command.args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  if (result.status !== 0) return []
  const prefix = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  const pathApi = platform === 'win32' ? win32 : posix
  if (!prefix || !pathApi.isAbsolute(prefix)) return []
  return [platform === 'win32'
    ? pathApi.join(prefix, 'ucode.cmd')
    : pathApi.join(prefix, 'bin', 'ucode')]
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
      `${win32.sep}node_modules${win32.sep}@allenchen77${win32.sep}ucode-cli${win32.sep}bin${win32.sep}ucode`
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
  homeDirectory = homedir(),
  findOnPath = findUCodeOnPath,
  findNpm = findNpmUCode
) {
  const legacy = platform === 'win32'
    ? win32.join(homeDirectory, '.ucode', 'bin', 'ucode.exe')
    : posix.join(homeDirectory, '.ucode', 'bin', 'ucode')
  const paths = [...new Set([
    ...findNpm(platform),
    ...(candidates || findOnPath(platform))
  ])]
  if (platform !== 'win32') {
    const npmExecutable = paths.find((path) => pathExists(path))
    if (npmExecutable) return { file: npmExecutable, prefixArgs: [] }
    return {
      file: pathExists(legacy) ? legacy : 'ucode',
      prefixArgs: []
    }
  }
  for (const shim of paths.filter((path) => path.toLowerCase().endsWith('.cmd'))) {
    try {
      const launch = resolveUCodeCmdShim(shim, readShim(shim, 'utf8'), pathExists)
      if (launch) return launch
    } catch {}
  }
  const direct = paths.find((path) =>
    path.toLowerCase().endsWith('.exe') &&
    win32.normalize(path).toLowerCase() !== legacy.toLowerCase() &&
    pathExists(path)
  )
  if (direct) return { file: direct, prefixArgs: [] }
  if (pathExists(legacy)) return { file: legacy, prefixArgs: [] }
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

  async sendTurn(text) {
    return super.sendTurn(text)
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
