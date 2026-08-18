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
const DEFAULT_RANGE_MAX_ITEMS = 5000
const DEFAULT_RANGE_MAX_BYTES = 4 * 1024 * 1024
const MAX_RANGE_ITEMS = 20_000
const MAX_RANGE_BYTES = 16 * 1024 * 1024
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
    session.historyRevision ?? '',
    session.historyTruncated === true ? 'truncated' : ''
  ].join(':')
}

function historySourceKind(adapterId) {
  return adapterId === 'opencode' || adapterId === 'ucode' ? 'export' : 'transcript'
}

function digestText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of ['summary', 'text', 'content', 'checkpoint', 'digest']) {
    const result = digestText(value[key])
    if (result) return result
  }
  return null
}

function openCodeNativeDigest(source) {
  const direct = [
    source?.nativeDigest,
    source?.compactSummary,
    source?.digest,
    source?.info?.nativeDigest,
    source?.info?.compactSummary,
    source?.info?.digest,
    source?.info?.compact,
    source?.info?.compaction,
    source?.info?.summary
  ]
  for (const candidate of direct) {
    const result = digestText(candidate)
    if (result) return result
  }
  const messages = Array.isArray(source?.messages) ? source.messages : []
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = Array.isArray(messages[messageIndex]?.parts) ? messages[messageIndex].parts : []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (!['compact', 'compaction', 'summary', 'digest'].includes(part?.type)) continue
      const result = digestText(part)
      if (result) return result
    }
  }
  return null
}

function boundedInteger(value, fallback, maximum) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0
    ? Math.min(numeric, maximum)
    : fallback
}

function clipUtf8(text, maxBytes) {
  let result = ''
  let bytes = 0
  for (const character of String(text)) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return { text: result, bytes, clipped: result !== String(text) }
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
  exportOpenCode = (sessionId) => exportOpenCodeSession(sessionId, { sanitize: false }),
  exportDshHistory = null,
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

  async function loadProviderHistory(session) {
    if (session.adapterId === 'deepseek-harness') {
      if (typeof exportDshHistory !== 'function') throw new Error('history provider unsupported')
      const history = await exportDshHistory(session)
      if (!history?.items) throw new Error('history source unavailable')
      return history
    }
    if (!session.cliSessionId) throw new Error('history source unavailable')
    if (session.adapterId === 'claude') {
      return {
        items: await readTranscript(resolveClaudeTranscript(session), parseClaudeHistory),
        nativeDigest: null,
        sourceKind: 'transcript',
        sourceTruncated: session.historyTruncated === true
      }
    }
    if (session.adapterId === 'codex') {
      return {
        items: await readTranscript(resolveCodexTranscript(session), parseCodexHistory),
        nativeDigest: null,
        sourceKind: 'transcript',
        sourceTruncated: session.historyTruncated === true
      }
    }
    if (session.adapterId === 'opencode' || session.adapterId === 'ucode') {
      let source
      try {
        source = await exportOpenCode(session.cliSessionId, session.adapterId)
      } catch {
        source = null
      }
      if (!source) throw new Error('history source unavailable')
      return {
        items: parseOpenCodeHistory(source),
        nativeDigest: openCodeNativeDigest(source),
        sourceKind: 'export',
        sourceTruncated: session.historyTruncated === true ||
          source.truncated === true || source.info?.truncated === true
      }
    }
    throw new Error('history provider unsupported')
  }

  async function providerHistory(sessionId, session) {
    const signature = sourceSignature(session)
    const currentTime = now()
    for (const [cachedSessionId, entry] of cache) {
      if (currentTime - entry.loadedAt > CACHE_TTL_MS) cache.delete(cachedSessionId)
    }
    const cached = cache.get(sessionId)
    if (
      cached &&
      cached.signature === signature &&
      currentTime - cached.loadedAt <= CACHE_TTL_MS
    ) {
      cache.delete(sessionId)
      cache.set(sessionId, cached)
      return cached.history
    }

    const history = await loadProviderHistory(session)
    cache.set(sessionId, {
      signature,
      loadedAt: now(),
      history
    })
    while (cache.size > safeCacheLimit) cache.delete(cache.keys().next().value)
    return history
  }

  async function getPage(sessionId, options = {}) {
    const session = resolveSession(sessionId)
    if (!session) throw new Error('session not found')
    if (!isSafeNativeSessionId(session.cliSessionId)) {
      throw new Error('invalid native session id')
    }

    const { items } = await providerHistory(sessionId, session)

    return {
      source: session.adapterId,
      ...historyPage(items, safePageOptions(options))
    }
  }

  async function loadRange({
    sessionId,
    start,
    endExclusive,
    maxItems = DEFAULT_RANGE_MAX_ITEMS,
    maxBytes = DEFAULT_RANGE_MAX_BYTES
  } = {}) {
    if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || start >= endExclusive) {
      throw new Error('invalid history range')
    }
    const session = resolveSession(sessionId)
    const provider = session?.adapterId || null
    const source = {
      provider,
      kind: provider ? historySourceKind(provider) : 'unavailable'
    }
    const missing = () => ({
      sessionId,
      source,
      items: [],
      missing: true,
      truncated: false,
      nativeDigest: null,
      metadata: { itemsAvailable: 0, itemsReturned: 0, bytesReturned: 0 }
    })
    const isDsh = session?.adapterId === 'deepseek-harness'
    if (!session || (!isDsh && !isSafeNativeSessionId(session.cliSessionId))) return missing()

    let history
    try {
      history = await providerHistory(sessionId, session)
    } catch {
      return missing()
    }

    const available = history.items
      .map((item, sourceIndex) => ({ item, sourceIndex }))
      .filter(({ item }) => Number.isFinite(item?.timestamp) &&
        item.timestamp >= start && item.timestamp < endExclusive)
      .sort((left, right) =>
        left.item.timestamp - right.item.timestamp || left.sourceIndex - right.sourceIndex
      )
      .map(({ item }) => ({
        id: String(item.id),
        role: item.role,
        text: String(item.text),
        timestamp: item.timestamp
      }))
    const itemLimit = boundedInteger(maxItems, DEFAULT_RANGE_MAX_ITEMS, MAX_RANGE_ITEMS)
    const byteLimit = boundedInteger(maxBytes, DEFAULT_RANGE_MAX_BYTES, MAX_RANGE_BYTES)
    const candidates = available.slice(-itemLimit)
    const selected = []
    let bytesReturned = 0
    let clipped = false
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const item = candidates[index]
      const remaining = byteLimit - bytesReturned
      const itemBytes = Buffer.byteLength(item.text, 'utf8')
      if (itemBytes <= remaining) {
        selected.unshift(item)
        bytesReturned += itemBytes
        continue
      }
      if (!selected.length && remaining > 0) {
        const bounded = clipUtf8(item.text, remaining)
        if (bounded.text) selected.unshift({ ...item, text: bounded.text })
        bytesReturned += bounded.bytes
        clipped = bounded.clipped
      }
      break
    }

    return {
      sessionId,
      source: { provider, kind: history.sourceKind },
      items: selected,
      missing: false,
      truncated: history.sourceTruncated || clipped || selected.length < available.length,
      nativeDigest: history.nativeDigest,
      metadata: {
        itemsAvailable: available.length,
        itemsReturned: selected.length,
        bytesReturned
      }
    }
  }

  function invalidate(sessionId) {
    cache.delete(sessionId)
  }

  return { getPage, loadRange, invalidate }
}

export function registerSessionHistoryIpc(ipcMain, historyService) {
  ipcMain.handle('session:get-history', (_event, sessionId, options = {}) => {
    return historyService.getPage(sessionId, safePageOptions(options))
  })
}
