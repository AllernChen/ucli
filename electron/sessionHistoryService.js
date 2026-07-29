import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { Worker } from 'worker_threads'

import {
  historyPage,
  isCodexDualRecordPair,
  parseClaudeHistory,
  parseCodexHistory,
  parseOpenCodeHistory
} from './sessionHistory.js'
import {
  findClaudeTranscriptFile,
  findCodexTranscriptFile,
  isSafeNativeSessionId
} from './sessionDiscovery.js'
import { exportOpenCodeSession } from './openCodeStats.js'

const CACHE_TTL_MS = 5000
const DEFAULT_PARSE_CHUNK_SIZE = 500
const DEFAULT_WORKER_THRESHOLD_BYTES = 256 * 1024
const JSON_LINES_WORKER = String.raw`
const { parentPort, workerData } = require('worker_threads')
const records = String(workerData)
  .split(/\r?\n/)
  .map((line) => {
    if (!line.trim()) return null
    try {
      const value = JSON.parse(line)
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  })
parentPort.postMessage(records)
`

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

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

function parseJsonLinesInWorker(content, WorkerClass = Worker) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(JSON_LINES_WORKER, {
      eval: true,
      workerData: String(content)
    })
    let settled = false
    worker.once('message', (records) => {
      settled = true
      resolve(records)
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`history parser worker exited before returning data (${code})`))
    })
  })
}

async function parseJsonLinesOnMain(content, chunkSize, yieldControl) {
  const lines = String(content).split(/\r?\n/)
  const records = []
  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize)
    for (let index = start; index < end; index += 1) {
      const line = lines[index]
      if (!line.trim()) {
        records.push(null)
        continue
      }
      try {
        const value = JSON.parse(line)
        records.push(value && typeof value === 'object' ? value : null)
      } catch {
        records.push(null)
      }
    }
    if (end < lines.length) await yieldControl()
  }
  return records
}

function codexPairEndAcrossBoundary(records, end) {
  let left = end - 1
  while (left >= 0 && !parseCodexHistory([records[left]]).length) left -= 1
  let right = end
  while (right < records.length && !parseCodexHistory([records[right]]).length) right += 1
  return left >= 0 &&
    right < records.length &&
    isCodexDualRecordPair(records[left], records[right])
    ? right + 1
    : null
}

async function normalizeRecordsCooperatively(
  records,
  parser,
  chunkSize,
  yieldControl
) {
  const items = []
  for (let start = 0; start < records.length;) {
    let end = Math.min(records.length, start + chunkSize)
    if (parser === parseCodexHistory) {
      while (end < records.length) {
        const pairEnd = codexPairEndAcrossBoundary(records, end)
        if (pairEnd === null) break
        end = pairEnd
      }
    }
    items.push(...parser(records.slice(start, end), { recordOffset: start }))
    start = end
    if (start < records.length) await yieldControl()
  }
  return items
}

export async function parseJsonLinesCooperatively(content, parser, {
  chunkSize = DEFAULT_PARSE_CHUNK_SIZE,
  normalizeChunkSize = DEFAULT_PARSE_CHUNK_SIZE,
  workerThresholdBytes = DEFAULT_WORKER_THRESHOLD_BYTES,
  yieldControl = yieldToEventLoop,
  WorkerClass = Worker
} = {}) {
  const safeChunkSize = Number.isInteger(chunkSize) && chunkSize > 0
    ? chunkSize
    : DEFAULT_PARSE_CHUNK_SIZE
  const safeNormalizeChunkSize =
    Number.isInteger(normalizeChunkSize) && normalizeChunkSize > 0
      ? normalizeChunkSize
      : DEFAULT_PARSE_CHUNK_SIZE
  const safeWorkerThreshold =
    Number.isInteger(workerThresholdBytes) && workerThresholdBytes >= 0
      ? workerThresholdBytes
      : DEFAULT_WORKER_THRESHOLD_BYTES
  const text = String(content)
  const records = Buffer.byteLength(text, 'utf8') >= safeWorkerThreshold
    ? await parseJsonLinesInWorker(text, WorkerClass)
    : await parseJsonLinesOnMain(text, safeChunkSize, yieldControl)

  return normalizeRecordsCooperatively(
    records,
    parser,
    safeNormalizeChunkSize,
    yieldControl
  )
}

export function createSessionHistoryService({
  resolveSession,
  readFile: readHistoryFile = readFile,
  exportOpenCode = exportOpenCodeSession,
  resolveClaudeTranscript = (session) =>
    findClaudeTranscriptFile(defaultHome(), session.cwd, session.cliSessionId),
  resolveCodexTranscript = (session) =>
    findCodexTranscriptFile(defaultHome(), session.cliSessionId),
  now = Date.now,
  cacheLimit = 12
}) {
  const cache = new Map()
  const safeCacheLimit = Number.isInteger(cacheLimit) && cacheLimit > 0
    ? Math.min(cacheLimit, 100)
    : 12

  async function readTranscript(path, parser) {
    if (!path) throw new Error('history source unavailable')
    try {
      const content = await readHistoryFile(path, 'utf8')
      return await parseJsonLinesCooperatively(content, parser)
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
    if (!isSafeNativeSessionId(session.cliSessionId)) {
      throw new Error('invalid native session id')
    }

    const signature = sourceSignature(session)
    const currentTime = now()
    for (const [cachedSessionId, entry] of cache) {
      if (currentTime - entry.loadedAt > CACHE_TTL_MS) cache.delete(cachedSessionId)
    }
    const cached = cache.get(sessionId)
    let items
    if (
      cached &&
      cached.signature === signature &&
      currentTime - cached.loadedAt <= CACHE_TTL_MS
    ) {
      items = cached.items
      cache.delete(sessionId)
      cache.set(sessionId, cached)
    } else {
      items = await loadProviderItems(session)
      cache.set(sessionId, {
        signature,
        loadedAt: now(),
        items
      })
      while (cache.size > safeCacheLimit) {
        cache.delete(cache.keys().next().value)
      }
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
