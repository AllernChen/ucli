import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { parseCodexProviderIdentity } from './codexRuntimeConfig.js'
import { parseCodexSessionMetadata } from './codexSessionMetadata.js'

/** Keep discovered native sessions visible so the UI can explain why a
 * transcript cannot be selected again. Removed UCLI sessions are not present
 * in `importedIds`, so their native source can still be re-added later. */
export function annotateImportedSessions(sessions, importedIds) {
  return sessions.map((session) => ({
    ...session,
    imported: importedIds.has(session.sessionId)
  }))
}

/** Claude Code encodes its project directory by replacing every non-ASCII
 * alphanumeric character. This includes separators, underscores and each CJK
 * character. */
export function claudeProjectHash(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')
}

/** Resolve ~/.claude/projects/<encoded-cwd>. Direct hash lookup is fast; the
 * metadata fallback protects against future Claude encoding changes, casing,
 * trailing separators, and paths selected through an alternate spelling. */
export function findClaudeProjectDirectory(home, cwd) {
  if (!home || !cwd) return null
  const projectsRoot = join(home, '.claude', 'projects')
  if (!existsSync(projectsRoot)) return null

  let directories
  try {
    directories = readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return null
  }

  const expected = claudeProjectHash(cwd).toLowerCase()
  const direct = directories.find((entry) => entry.name.toLowerCase() === expected)
  if (direct) return join(projectsRoot, direct.name)

  const targetCwd = normalizeCwd(cwd)
  for (const directory of directories) {
    const directoryPath = join(projectsRoot, directory.name)
    let files
    try {
      files = readdirSync(directoryPath).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const head = readFileSync(join(directoryPath, file), 'utf8').slice(0, 256 * 1024)
        for (const line of head.split('\n')) {
          if (!line.includes('"cwd"')) continue
          const row = JSON.parse(line)
          if (row.cwd && normalizeCwd(row.cwd) === targetCwd) return directoryPath
        }
      } catch { /* try the next transcript */ }
    }
  }
  return null
}

export function listClaudeTranscriptFiles(home, cwd) {
  const directory = findClaudeProjectDirectory(home, cwd)
  if (!directory) return []
  let files
  try {
    files = readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const transcripts = []
  for (const file of files) {
    try {
      const fullPath = join(directory, file)
      transcripts.push({
        sessionId: file.replace(/\.jsonl$/, ''),
        fullPath,
        startedAt: statSync(fullPath).birthtimeMs
      })
    } catch { /* one unreadable file must not erase the whole directory */ }
  }
  return transcripts
}

export function isSafeNativeSessionId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[a-zA-Z0-9._-]+$/.test(value)
}

export function findClaudeTranscriptFile(home, cwd, sessionId) {
  if (!isSafeNativeSessionId(sessionId)) return null
  const directory = findClaudeProjectDirectory(home, cwd)
  if (!directory) return null
  const transcript = join(directory, `${sessionId}.jsonl`)
  return existsSync(transcript) ? transcript : null
}

export function findCodexTranscriptFile(home, sessionId) {
  if (!home) return null
  return findCodexTranscriptFileInHome(join(home, '.codex'), sessionId)
}

function readFileHead(path, maxBytes = 256 * 1024) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch { /* ignore close failures */ }
    }
  }
}

export function readCodexSessionMetadataFromFile(path) {
  try {
    const head = readFileHead(path)
    const firstLineEnd = head.indexOf('\n')
    const firstLine = head.slice(0, firstLineEnd >= 0 ? firstLineEnd : head.length)
    return parseCodexSessionMetadata(JSON.parse(firstLine))
  } catch {
    return null
  }
}

/** Resolve a stored Codex thread to the newest rollout fork descended from it.
 * Codex assigns a fresh primary ID whenever a thread is resumed and records
 * the prior ID in `forked_from_id`. Following that chain keeps a UCLI binding
 * attached to the context the user most recently continued. */
export function resolveCodexTranscriptSessionInHome(codexHome, sessionId) {
  if (!codexHome || !isSafeNativeSessionId(sessionId)) return null
  const sessionsRoot = join(codexHome, 'sessions')
  if (!existsSync(sessionsRoot)) return null

  const rollouts = []
  let directMatch = null
  let recoveredParentId = null
  let years
  try {
    years = readdirSync(sessionsRoot)
  } catch {
    return null
  }
  for (const year of years) {
    const yearDirectory = join(sessionsRoot, year)
    let months
    try { months = readdirSync(yearDirectory) } catch { continue }
    for (const month of months) {
      const monthDirectory = join(yearDirectory, month)
      let days
      try { days = readdirSync(monthDirectory) } catch { continue }
      for (const day of days) {
        const dayDirectory = join(monthDirectory, day)
        let files
        try { files = readdirSync(dayDirectory) } catch { continue }
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const fullPath = join(dayDirectory, file)
          if (file.endsWith(`${sessionId}.jsonl`)) directMatch = fullPath
          try {
            const meta = readCodexSessionMetadataFromFile(fullPath)
            if (!meta || !isSafeNativeSessionId(meta.sessionId)) continue
            if (meta.isSubagent) {
              if (meta.sessionId === sessionId && isSafeNativeSessionId(meta.parentThreadId)) {
                recoveredParentId = meta.parentThreadId
              }
              if (fullPath === directMatch) directMatch = null
              continue
            }
            const stat = statSync(fullPath)
            const parsedStart = Date.parse(meta.timestamp)
            rollouts.push({
              sessionId: meta.sessionId,
              forkedFromId: isSafeNativeSessionId(meta.forkedFromId) ? meta.forkedFromId : null,
              path: fullPath,
              startedAt: Number.isFinite(parsedStart) ? parsedStart : stat.birthtimeMs,
              updatedAt: stat.mtimeMs
            })
          } catch { /* an unreadable rollout cannot hide other descendants */ }
        }
      }
    }
  }

  const reachable = new Set([recoveredParentId || sessionId])
  let changed = true
  while (changed) {
    changed = false
    for (const rollout of rollouts) {
      if (reachable.has(rollout.sessionId)) continue
      if (rollout.forkedFromId && reachable.has(rollout.forkedFromId)) {
        reachable.add(rollout.sessionId)
        changed = true
      }
    }
  }

  const latest = rollouts
    .filter((rollout) => reachable.has(rollout.sessionId))
    .sort((a, b) => b.startedAt - a.startedAt || b.updatedAt - a.updatedAt)[0]
  if (latest) return latest
  return directMatch ? { sessionId, path: directMatch, startedAt: 0, updatedAt: 0 } : null
}

export function findCodexTranscriptFileInHome(codexHome, sessionId) {
  if (!codexHome || !isSafeNativeSessionId(sessionId)) return null
  const sessionsRoot = join(codexHome, 'sessions')
  if (!existsSync(sessionsRoot)) return null
  let years
  try { years = readdirSync(sessionsRoot) } catch { return null }
  for (const year of years) {
    const yearDirectory = join(sessionsRoot, year)
    let months
    try { months = readdirSync(yearDirectory) } catch { continue }
    for (const month of months) {
      const monthDirectory = join(yearDirectory, month)
      let days
      try { days = readdirSync(monthDirectory) } catch { continue }
      for (const day of days) {
        const dayDirectory = join(monthDirectory, day)
        let files
        try { files = readdirSync(dayDirectory) } catch { continue }
        const match = files.find((file) => file.endsWith(`${sessionId}.jsonl`))
        if (match) return join(dayDirectory, match)
      }
    }
  }
  return null
}

/** List Codex native sessions for restart recovery. Codex can write multiple
 * rollout files for the same resumed session, so preserve its earliest start
 * time while retaining the latest activity time. */
export function listCodexTranscriptSessions(home, cwd) {
  if (!home) return []
  return listCodexTranscriptSessionsInHome(join(home, '.codex'), cwd)
}

export function listCodexTranscriptSessionsInHome(codexHome, cwd) {
  if (!codexHome || !cwd) return []
  const sessionsRoot = join(codexHome, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const targetCwd = normalizeCwd(cwd)
  const sessions = new Map()

  let years
  try { years = readdirSync(sessionsRoot) } catch { return [] }
  for (const year of years) {
    const yearDirectory = join(sessionsRoot, year)
    let months
    try { months = readdirSync(yearDirectory) } catch { continue }
    for (const month of months) {
      const monthDirectory = join(yearDirectory, month)
      let days
      try { days = readdirSync(monthDirectory) } catch { continue }
      for (const day of days) {
        const dayDirectory = join(monthDirectory, day)
        let files
        try { files = readdirSync(dayDirectory) } catch { continue }
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const fullPath = join(dayDirectory, file)
          try {
            const meta = readCodexSessionMetadataFromFile(fullPath)
            if (!meta || meta.isSubagent) continue
            const sessionId = meta.sessionId
            if (!isSafeNativeSessionId(sessionId) || normalizeCwd(meta.cwd) !== targetCwd) continue
            const stat = statSync(fullPath)
            const parsedStart = Date.parse(meta.timestamp)
            const startedAt = Number.isFinite(parsedStart) ? parsedStart : stat.birthtimeMs
            const existing = sessions.get(sessionId)
            sessions.set(sessionId, {
              sessionId,
              forkedFromId: existing?.forkedFromId || meta.forkedFromId || null,
              startedAt: existing ? Math.min(existing.startedAt, startedAt) : startedAt,
              updatedAt: existing ? Math.max(existing.updatedAt, stat.mtimeMs) : stat.mtimeMs
            })
          } catch { /* one unreadable transcript must not hide the rest */ }
        }
      }
    }
  }
  return Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Parse only Codex provider identity from config.toml. Credentials and other
 * provider settings never leave the main process. */
export function parseCodexProviderConfig(content = '') {
  return parseCodexProviderIdentity(content)
}

export function resolveCodexResumeProvider(sourceProvider, config) {
  const available = new Set(config.availableProviders || [])
  const source = isSafeProviderName(sourceProvider) ? sourceProvider : null
  const resumeProvider = source && available.has(source)
    ? source
    : config.currentProvider || 'openai'
  return {
    sourceProvider: source,
    resumeProvider,
    providerChanged: Boolean(source && source !== resumeProvider)
  }
}

export function isSafeProviderName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value)
}

function normalizeCwd(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
