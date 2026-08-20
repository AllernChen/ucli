import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'

export const MAX_SUMMARY_AUTH_BYTES = 256 * 1024

async function hasLinkedPathComponent(path) {
  let current = path
  const root = parse(path).root
  while (current !== root) {
    const stats = await lstat(current)
    // Node reports Windows symlinks and directory junctions (the reparse
    // points that redirect path resolution) as symbolic links. A symlink
    // directly under the filesystem root is a fixed OS alias (macOS
    // /var -> /private/var), not a redirection vector, and is allowed; the
    // opened file is separately matched to this lstat identity below.
    if (stats.isSymbolicLink() && dirname(current) !== root) return true
    current = dirname(current)
  }
  return false
}

export function resolveOpenCodeAuthPath({
  env = process.env,
  homeDirectory = homedir()
} = {}) {
  const configuredDataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : null
  const dataHome = configuredDataHome || join(homeDirectory, '.local', 'share')
  if (!isAbsolute(dataHome)) return null
  return join(dataHome, 'opencode', 'auth.json')
}

function sourceHome(env, homeDirectory, platform = process.platform) {
  if (homeDirectory) return homeDirectory
  const candidate = platform === 'win32'
    ? (env.USERPROFILE || env.HOME)
    : (env.HOME || env.USERPROFILE)
  return typeof candidate === 'string' && isAbsolute(candidate) ? candidate : homedir()
}

export function resolveClaudeCredentialsPath({
  env = process.env,
  homeDirectory,
  platform = process.platform
} = {}) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : null
  const configDirectory = configured || join(sourceHome(env, homeDirectory, platform), '.claude')
  if (!isAbsolute(configDirectory)) return null
  return join(configDirectory, '.credentials.json')
}

function invalid(reason) {
  return { available: false, reason, bytes: null }
}

function validOpenCodeAuth(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).some(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false
      if (record.type === 'api') return typeof record.key === 'string' && Boolean(record.key.trim())
      if (record.type === 'oauth') {
        return typeof record.refresh === 'string' && Boolean(record.refresh.trim()) &&
          typeof record.access === 'string' && Boolean(record.access.trim()) &&
          Number.isInteger(record.expires) && record.expires >= 0
      }
      if (record.type === 'wellknown') {
        return typeof record.key === 'string' && Boolean(record.key.trim()) &&
          typeof record.token === 'string' && Boolean(record.token.trim())
      }
      return false
    })
}

function validClaudeCredentials(value) {
  const oauth = value?.claudeAiOauth
  return oauth && typeof oauth === 'object' && !Array.isArray(oauth) &&
    [oauth.accessToken, oauth.refreshToken].some(item =>
      typeof item === 'string' && item.trim()
    )
}

async function readSafeJsonCredential(path, {
  platform = process.platform,
  maxBytes = MAX_SUMMARY_AUTH_BYTES,
  validateJson
} = {}) {
  if (!path || !isAbsolute(path)) return invalid('summary-authentication-unavailable')
  try {
    if (await hasLinkedPathComponent(path)) return invalid('unsafe-auth-file')
    const pathStats = await lstat(path)
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) return invalid('unsafe-auth-file')
    const noFollow = platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0)
    const handle = await open(path, constants.O_RDONLY | noFollow)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) {
        return invalid(metadata.size > maxBytes ? 'auth-file-too-large' : 'unsafe-auth-file')
      }
      if (metadata.dev !== pathStats.dev || metadata.ino !== pathStats.ino) {
        return invalid('unsafe-auth-file')
      }
      if (platform !== 'win32') {
        if ((metadata.mode & 0o077) !== 0) return invalid('unsafe-auth-file-permissions')
        if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
          return invalid('unsafe-auth-file-owner')
        }
      }
      const buffer = Buffer.allocUnsafe(Math.min(metadata.size + 1, maxBytes + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxBytes || bytesRead !== metadata.size) {
        return invalid(bytesRead > maxBytes ? 'auth-file-too-large' : 'unsafe-auth-file')
      }
      const bytes = buffer.subarray(0, bytesRead)
      let parsed
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return invalid('invalid-auth-file') }
      if (!validateJson?.(parsed)) {
        return invalid('invalid-auth-file')
      }
      return { available: true, reason: null, bytes }
    } finally {
      await handle.close()
    }
  } catch {
    return invalid('summary-authentication-unavailable')
  }
}

export function readSafeOpenCodeAuth(path, options = {}) {
  return readSafeJsonCredential(path, { ...options, validateJson: validOpenCodeAuth })
}

function readSafeClaudeCredentials(path, options = {}) {
  return readSafeJsonCredential(path, { ...options, validateJson: validClaudeCredentials })
}

export async function inspectOpenCodeAuthentication({
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform
} = {}) {
  if (platform === 'win32') {
    return { available: false, source: null, reason: 'windows-disk-auth-bridge-unavailable' }
  }
  const path = resolveOpenCodeAuthPath({ env, homeDirectory })
  const result = await readSafeOpenCodeAuth(path, { platform })
  return {
    available: result.available,
    source: result.available ? 'auth-file' : null,
    reason: result.reason
  }
}

export async function inspectClaudeFileAuthentication({
  env = process.env,
  homeDirectory,
  platform = process.platform
} = {}) {
  if (platform === 'win32') {
    return { available: false, source: null, reason: 'windows-disk-auth-bridge-unavailable' }
  }
  const path = resolveClaudeCredentialsPath({ env, homeDirectory, platform })
  const result = await readSafeClaudeCredentials(path, { platform })
  return {
    available: result.available,
    source: result.available ? 'auth-file' : null,
    reason: result.reason
  }
}

async function copyValidatedCredential({
  sourcePath,
  destinationDirectory,
  destinationName,
  platform,
  readCredential = readSafeOpenCodeAuth
}) {
  const result = await readCredential(sourcePath, { platform })
  if (!result.available) return { ...result, source: null, destinationPath: null }
  const destinationPath = join(destinationDirectory, destinationName)
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  await chmod(destinationDirectory, 0o700).catch(() => {})
  await writeFile(destinationPath, result.bytes, { flag: 'wx', mode: 0o600 })
  await chmod(destinationPath, 0o600).catch(() => {})
  return { available: true, source: 'auth-file', reason: null, destinationPath }
}

export async function bridgeClaudeAuthentication({
  sourceEnv = process.env,
  isolatedConfigDirectory,
  homeDirectory,
  platform = process.platform
} = {}) {
  if (!isolatedConfigDirectory || !isAbsolute(isolatedConfigDirectory)) {
    throw new TypeError('isolatedConfigDirectory is required')
  }
  if (platform === 'win32') {
    return invalid('windows-disk-auth-bridge-unavailable')
  }
  return copyValidatedCredential({
    sourcePath: resolveClaudeCredentialsPath({ env: sourceEnv, homeDirectory, platform }),
    destinationDirectory: isolatedConfigDirectory,
    destinationName: '.credentials.json',
    platform,
    readCredential: readSafeClaudeCredentials
  })
}

export async function bridgeOpenCodeAuthentication({
  sourceEnv = process.env,
  isolatedDataHome,
  homeDirectory = homedir(),
  platform = process.platform
} = {}) {
  if (!isolatedDataHome || !isAbsolute(isolatedDataHome)) {
    throw new TypeError('isolatedDataHome is required')
  }
  if (platform === 'win32') {
    return invalid('windows-disk-auth-bridge-unavailable')
  }
  const sourcePath = resolveOpenCodeAuthPath({ env: sourceEnv, homeDirectory })
  return copyValidatedCredential({
    sourcePath,
    destinationDirectory: join(isolatedDataHome, 'opencode'),
    destinationName: 'auth.json',
    platform
  })
}
