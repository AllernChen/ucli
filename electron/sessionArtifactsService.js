import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { parseJsonLinesCooperatively } from './sessionHistoryService.js'
import { findClaudeTranscriptFile, findCodexTranscriptFile } from './sessionDiscovery.js'
import { exportOpenCodeSession } from './openCodeStats.js'
import {
  assertInsideDirectory,
  artifactKindFromPath,
  imageMimeTypeFromPath,
  parseClaudeArtifactPaths,
  parseCodexArtifactPaths,
  parseOpenCodeArtifactPaths,
  resolveArtifactAbsolutePath
} from './sessionArtifacts.js'

const CACHE_TTL_MS = 5000

function artifactError(code) {
  return Object.assign(new Error(code), { code })
}

function defaultHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

function winKey(value) {
  return String(value).replace(/\\/g, '/').toLowerCase()
}

function pathApiFor(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? path.win32
    : path.posix
}

export function createSessionArtifactsService({
  resolveSession,
  readFile: readArtifactFile = readFile,
  exportOpenCode = (sessionId) => exportOpenCodeSession(sessionId, { sanitize: false }),
  resolveClaudeTranscript = (session) =>
    findClaudeTranscriptFile(defaultHome(), session.cwd, session.cliSessionId),
  resolveCodexTranscript = (session) =>
    findCodexTranscriptFile(defaultHome(), session.cliSessionId),
  statFile = (path) => stat(path),
  realpathFile = (path) => realpath(path),
  parseJsonl = (content) => parseJsonLinesCooperatively(content, (records) => records),
  now = Date.now,
  maxArtifacts = 500,
  maxFileBytes = 10 * 1024 * 1024,
  cacheLimit = 12
}) {
  const cache = new Map()
  const safeCacheLimit = Number.isInteger(cacheLimit) && cacheLimit > 0
    ? Math.min(cacheLimit, 100)
    : 12

  async function readTranscript(path) {
    if (!path) return []
    try {
      const content = await readArtifactFile(path, 'utf8')
      return await parseJsonl(content)
    } catch {
      return []
    }
  }

  // Canonicalize the session cwd (resolve symlinked ancestors on macOS/`/tmp`,
  // restore on-disk case on Windows) so the containment check compares
  // real-to-real. Falls back to the raw cwd when the directory no longer
  // exists (no artifacts could resolve then anyway).
  async function canonicalizeRoot(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return cwd
    try {
      return await realpathFile(cwd)
    } catch {
      return cwd
    }
  }

  async function collectForSession(session) {
    if (session.adapterId === 'claude') {
      return parseClaudeArtifactPaths(await readTranscript(resolveClaudeTranscript(session)))
    }
    if (session.adapterId === 'codex') {
      return parseCodexArtifactPaths(await readTranscript(resolveCodexTranscript(session)))
    }
    if (session.adapterId === 'opencode' || session.adapterId === 'ucode') {
      let source
      try {
        source = await exportOpenCode(session.cliSessionId, session.adapterId)
      } catch {
        source = null
      }
      return source ? parseOpenCodeArtifactPaths(source) : []
    }
    return null
  }

  async function listArtifacts(sessionId) {
    const session = resolveSession(sessionId)
    if (!session) return { artifacts: [], source: null, missing: true, truncated: false }
    const root = await canonicalizeRoot(session.cwd)

    const currentTime = now()
    for (const [key, entry] of cache) {
      if (currentTime - entry.loadedAt > CACHE_TTL_MS) cache.delete(key)
    }
    let rawPaths
    const cached = cache.get(sessionId)
    if (cached && currentTime - cached.loadedAt <= CACHE_TTL_MS) {
      rawPaths = cached.paths
    } else {
      rawPaths = await collectForSession(session)
      cache.set(sessionId, { paths: rawPaths, loadedAt: now() })
      while (cache.size > safeCacheLimit) cache.delete(cache.keys().next().value)
    }

    if (rawPaths === null) {
      return { artifacts: [], source: session.adapterId, missing: true, truncated: false }
    }

    const seen = new Set()
    const artifacts = []
    for (const raw of rawPaths || []) {
      if (artifacts.length >= maxArtifacts) break
      const absolutePath = resolveArtifactAbsolutePath(raw, session.cwd)
      if (!absolutePath) continue
      let real
      try {
        real = await realpathFile(absolutePath)
      } catch {
        continue
      }
      let safe
      try {
        safe = assertInsideDirectory(root, real)
      } catch {
        continue
      }
      let stat
      try {
        stat = await statFile(safe)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      const key = winKey(safe)
      if (seen.has(key)) continue
      seen.add(key)
      artifacts.push({
        path: raw,
        absolutePath: safe,
        name: pathApiFor(safe).basename(safe),
        kind: artifactKindFromPath(safe),
        size: stat.size,
        mtime: stat.mtimeMs
      })
    }

    return {
      artifacts,
      source: session.adapterId,
      missing: false,
      truncated: (rawPaths?.length ?? 0) > artifacts.length
    }
  }

  async function readArtifact(sessionId, absolutePath, options = {}) {
    const session = resolveSession(sessionId)
    if (!session) throw artifactError('ARTIFACT_SESSION_NOT_FOUND')
    const root = await canonicalizeRoot(session.cwd)
    const kind = options && typeof options.kind === 'string'
      ? options.kind
      : artifactKindFromPath(absolutePath)

    let real
    try {
      real = await realpathFile(absolutePath)
    } catch {
      throw artifactError('ARTIFACT_NOT_FOUND')
    }
    let safe
    try {
      safe = assertInsideDirectory(root, real)
    } catch {
      throw artifactError('ARTIFACT_PATH_UNSAFE')
    }
    let stat
    try {
      stat = await statFile(safe)
    } catch {
      throw artifactError('ARTIFACT_NOT_FOUND')
    }
    if (!stat.isFile()) throw artifactError('ARTIFACT_NOT_FOUND')
    if (stat.size > maxFileBytes) throw artifactError('ARTIFACT_TOO_LARGE')

    if (kind === 'image') {
      const buffer = await readArtifactFile(safe)
      return {
        kind: 'image',
        base64: buffer.toString('base64'),
        mimeType: imageMimeTypeFromPath(safe) || 'application/octet-stream',
        truncated: false
      }
    }

    const text = await readArtifactFile(safe, 'utf8')
    return { kind, text, truncated: false }
  }

  function invalidate(sessionId) {
    cache.delete(sessionId)
  }

  return { listArtifacts, readArtifact, invalidate }
}

function envelope(handler) {
  return async (...args) => {
    try {
      return { ok: true, value: await handler(...args) }
    } catch (error) {
      return { ok: false, error: { code: error.code || 'ARTIFACT_FAILED', message: error.message } }
    }
  }
}

export function registerSessionArtifactsIpc(ipcMain, artifactsService) {
  ipcMain.handle('session:list-artifacts', envelope((_event, sessionId) =>
    artifactsService.listArtifacts(sessionId)))
  ipcMain.handle('session:read-artifact', envelope((_event, sessionId, absolutePath, options) =>
    artifactsService.readArtifact(sessionId, absolutePath, options)))
}
