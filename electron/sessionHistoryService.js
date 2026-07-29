import { readFileSync } from 'fs'
import { homedir } from 'os'

import {
  historyPage,
  parseClaudeHistory,
  parseCodexHistory,
  parseOpenCodeHistory
} from './sessionHistory.js'
import {
  findClaudeTranscriptFile,
  findCodexTranscriptFile
} from './sessionDiscovery.js'
import { exportOpenCodeSession } from './openCodeStats.js'

const CACHE_TTL_MS = 5000

function defaultHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

function sourceSignature(session) {
  return [
    session.adapterId,
    session.cliSessionId,
    session.historyRevision ?? ''
  ].join(':')
}

function safePageOptions(options) {
  const source = options && typeof options === 'object' ? options : {}
  return {
    before: source.before ?? null,
    limit: source.limit
  }
}

export function createSessionHistoryService({
  resolveSession,
  readFile = readFileSync,
  exportOpenCode = exportOpenCodeSession,
  resolveClaudeTranscript = (session) =>
    findClaudeTranscriptFile(defaultHome(), session.cwd, session.cliSessionId),
  resolveCodexTranscript = (session) =>
    findCodexTranscriptFile(defaultHome(), session.cliSessionId),
  now = Date.now
}) {
  const cache = new Map()

  async function readTranscript(path, parser) {
    if (!path) throw new Error('history source unavailable')
    try {
      const content = await readFile(path, 'utf8')
      return parser(String(content).split(/\r?\n/))
    } catch {
      throw new Error('history source unavailable')
    }
  }

  async function loadProviderItems(session) {
    if (!session.cliSessionId) throw new Error('history source unavailable')
    if (session.adapterId === 'claude') {
      return readTranscript(resolveClaudeTranscript(session), parseClaudeHistory)
    }
    if (session.adapterId === 'codex') {
      return readTranscript(resolveCodexTranscript(session), parseCodexHistory)
    }
    if (session.adapterId === 'opencode') {
      let source
      try {
        source = await exportOpenCode(session.cliSessionId)
      } catch {
        source = null
      }
      if (!source) throw new Error('history source unavailable')
      return parseOpenCodeHistory(source)
    }
    throw new Error('history provider unsupported')
  }

  async function getPage(sessionId, options = {}) {
    const session = resolveSession(sessionId)
    if (!session) throw new Error('session not found')

    const signature = sourceSignature(session)
    const cached = cache.get(sessionId)
    let items
    if (
      cached &&
      cached.signature === signature &&
      now() - cached.loadedAt <= CACHE_TTL_MS
    ) {
      items = cached.items
    } else {
      items = await loadProviderItems(session)
      cache.set(sessionId, {
        signature,
        loadedAt: now(),
        items
      })
    }

    return {
      source: session.adapterId,
      ...historyPage(items, safePageOptions(options))
    }
  }

  function invalidate(sessionId) {
    cache.delete(sessionId)
  }

  return { getPage, invalidate }
}

export function registerSessionHistoryIpc(ipcMain, historyService) {
  ipcMain.handle('session:get-history', (_event, sessionId, options = {}) => {
    return historyService.getPage(sessionId, safePageOptions(options))
  })
}
