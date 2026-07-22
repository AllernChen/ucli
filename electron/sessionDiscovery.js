import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

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

/** Parse only Codex provider identity from config.toml. Credentials and other
 * provider settings never leave the main process. */
export function parseCodexProviderConfig(content = '') {
  const available = new Set(['openai'])
  const sectionPattern = /^\s*\[model_providers\.([^\]]+)\]\s*$/gm
  for (const match of content.matchAll(sectionPattern)) {
    const name = unquote(match[1].trim())
    if (isSafeProviderName(name)) available.add(name)
  }

  const currentMatch = content.match(/^\s*model_provider\s*=\s*([^#\r\n]+)$/m)
  const declared = currentMatch ? unquote(currentMatch[1].trim()) : 'openai'
  const currentProvider = available.has(declared) ? declared : 'openai'
  return { currentProvider, availableProviders: Array.from(available) }
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

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function normalizeCwd(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
