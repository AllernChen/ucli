import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { assertSafeSummaryChild, resolveSummaryChild } from './summaryStoragePaths.js'

const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024
const DEFAULT_QUOTA_BYTES = 1_073_741_824
const CACHE_KINDS = new Set(['map', 'project', 'final'])
const CACHE_KEY = /^sha256:[a-f0-9]{64}$/

function cacheError(code) {
  return Object.assign(new Error(code), { code })
}

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw cacheError('SUMMARY_CACHE_KEY_INVALID')
    return value
  }
  if (Array.isArray(value)) return value.map(item => canonicalize(item, stack))
  if (!value || typeof value !== 'object' || stack.has(value)) {
    throw cacheError('SUMMARY_CACHE_KEY_INVALID')
  }
  stack.add(value)
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') {
      throw cacheError('SUMMARY_CACHE_KEY_INVALID')
    }
    result[key] = canonicalize(value[key], stack)
  }
  stack.delete(value)
  return result
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function cacheKeyForInvocation({
  stage,
  prompt,
  schema,
  executorId,
  profileFingerprint,
  model,
  promptVersion
} = {}) {
  const semanticInput = {
    executorId,
    model,
    profileFingerprint,
    prompt,
    promptVersion,
    schema,
    stage
  }
  if ([stage, prompt, executorId, profileFingerprint, model, promptVersion]
    .some(value => typeof value !== 'string')) {
    throw cacheError('SUMMARY_CACHE_KEY_INVALID')
  }
  return `sha256:${createHash('sha256').update(stableJson(semanticInput)).digest('hex')}`
}

function assertKey(key) {
  if (!CACHE_KEY.test(String(key || ''))) throw cacheError('SUMMARY_CACHE_ENTRY_INVALID')
}

function relativePathFor(key, kind) {
  assertKey(key)
  if (!CACHE_KINDS.has(kind)) throw cacheError('SUMMARY_CACHE_ENTRY_INVALID')
  const hex = key.slice('sha256:'.length)
  return `${kind}/${hex.slice(0, 2)}/${hex}.json`
}

function targetFor(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw cacheError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  const segments = relativePath.split('/')
  if (segments.length !== 3 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw cacheError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  const cacheRoot = resolveSummaryChild(root, 'cache', segments[0])
  const target = path.resolve(cacheRoot, segments[1], segments[2])
  return assertSafeSummaryChild(cacheRoot, target)
}

async function atomicExclusiveWrite(target, data) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    try {
      await access(target)
      await rm(temporary, { force: true })
      return false
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
      await rm(temporary, { force: true })
      return false
    }
    return true
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function createSummaryCacheService({
  root,
  repository,
  now = Date.now,
  quotaBytes = DEFAULT_QUOTA_BYTES,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES
} = {}) {
  if (!repository) throw new TypeError('repository is required')
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) {
    throw cacheError('SUMMARY_CACHE_QUOTA_INVALID')
  }
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1) {
    throw cacheError('SUMMARY_CACHE_ENTRY_LIMIT')
  }
  const pendingPuts = new Map()

  async function readBounded(target) {
    const handle = await open(target, 'r')
    try {
      const buffer = Buffer.alloc(maxEntryBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxEntryBytes) throw cacheError('SUMMARY_CACHE_ENTRY_LIMIT')
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async function discard(entry, target = null) {
    if (target) await rm(target, { force: true }).catch(() => {})
    repository.deleteSummaryCacheEntries([entry.key])
  }

  async function get(key) {
    assertKey(key)
    const entry = repository.getSummaryCacheEntry(key)
    if (!entry) return null
    let target
    try {
      if (entry.relativePath !== relativePathFor(entry.key, entry.kind)) {
        throw cacheError('SUMMARY_STORAGE_PATH_UNSAFE')
      }
      target = targetFor(root, entry.relativePath)
      const file = await stat(target)
      if (!file.isFile() || file.size > maxEntryBytes || file.size !== entry.sizeBytes) {
        throw cacheError('SUMMARY_CACHE_ENTRY_INVALID')
      }
      const data = await readBounded(target)
      const decoded = JSON.parse(data.toString('utf8'))
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) ||
        decoded.version !== 1 || !Object.hasOwn(decoded, 'value')) {
        throw cacheError('SUMMARY_CACHE_ENTRY_INVALID')
      }
      repository.touchSummaryCacheEntry(key, now())
      return decoded.value
    } catch {
      await discard(entry, target)
      return null
    }
  }

  async function publish({ key, kind, value, expiresAt }) {
    const relativePath = relativePathFor(key, kind)
    const encoded = Buffer.from(JSON.stringify({ version: 1, value }), 'utf8')
    if (encoded.byteLength > maxEntryBytes) throw cacheError('SUMMARY_CACHE_ENTRY_LIMIT')
    const target = targetFor(root, relativePath)
    const published = await atomicExclusiveWrite(target, encoded)
    let stored = encoded
    let storedValue = value
    if (!published) {
      stored = await readBounded(target)
      const decoded = JSON.parse(stored.toString('utf8'))
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) ||
        decoded.version !== 1 || !Object.hasOwn(decoded, 'value')) {
        throw cacheError('SUMMARY_CACHE_ENTRY_INVALID')
      }
      storedValue = decoded.value
    }
    const createdAt = now()
    const entry = {
      key,
      kind,
      relativePath,
      sizeBytes: stored.byteLength,
      createdAt,
      lastAccessedAt: createdAt,
      expiresAt: expiresAt ?? null
    }
    repository.upsertSummaryCacheEntry(entry)
    return storedValue
  }

  function put(entry = {}) {
    const key = entry.key
    assertKey(key)
    const pending = pendingPuts.get(key)
    if (pending) return pending
    const operation = publish(entry).finally(() => {
      if (pendingPuts.get(key) === operation) pendingPuts.delete(key)
    })
    pendingPuts.set(key, operation)
    return operation
  }

  async function prune(maxBytes = quotaBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw cacheError('SUMMARY_CACHE_QUOTA_INVALID')
    }
    const entries = repository.listSummaryCacheEntries()
    let bytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0)
    const sorted = [...entries].sort((left, right) =>
      left.lastAccessedAt - right.lastAccessedAt ||
      left.createdAt - right.createdAt ||
      left.key.localeCompare(right.key)
    )
    const removed = []
    for (const entry of sorted) {
      if (bytes <= maxBytes) break
      let target = null
      try { target = targetFor(root, entry.relativePath) } catch { /* index only */ }
      if (target) {
        try {
          await rm(target, { force: true })
        } catch {
          continue
        }
      }
      removed.push(entry.key)
      bytes -= entry.sizeBytes
    }
    repository.deleteSummaryCacheEntries(removed)
    return { removed: removed.length, bytes: Math.max(0, bytes) }
  }

  async function stats() {
    const entries = repository.listSummaryCacheEntries()
    return {
      bytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
      entries: entries.length,
      quotaBytes
    }
  }

  async function evict(key) {
    assertKey(key)
    const entry = repository.getSummaryCacheEntry(key)
    if (!entry) return false
    let target = null
    try {
      const expected = relativePathFor(entry.key, entry.kind)
      if (entry.relativePath !== expected) throw cacheError('SUMMARY_STORAGE_PATH_UNSAFE')
      target = targetFor(root, expected)
    } catch {
      // Unsafe metadata is removed from the index without touching any file.
    }
    if (target) await rm(target, { force: true })
    repository.deleteSummaryCacheEntries([key])
    return true
  }

  async function clear() {
    const entries = repository.listSummaryCacheEntries()
    const cacheRoot = resolveSummaryChild(root, 'cache', 'entries')
    const cacheDirectory = path.dirname(cacheRoot)
    assertSafeSummaryChild(root, cacheDirectory)
    await rm(cacheDirectory, { recursive: true, force: true })
    repository.deleteSummaryCacheEntries(entries.map(entry => entry.key))
    return { removed: entries.length, bytes: 0 }
  }

  async function verify() {
    const entries = repository.listSummaryCacheEntries()
    let removed = 0
    for (const entry of entries) {
      try {
        const value = await get(entry.key)
        if (value === null) removed += 1
      } catch {
        try {
          const existed = await evict(entry.key)
          if (existed) removed += 1
        } catch {
          repository.deleteSummaryCacheEntries([entry.key])
          removed += 1
        }
      }
    }
    const remaining = repository.listSummaryCacheEntries()
    return {
      checked: entries.length,
      removed,
      bytes: Math.min(Number.MAX_SAFE_INTEGER, remaining.reduce(
        (total, entry) => total + Math.max(0, entry.sizeBytes), 0
      ))
    }
  }

  return { get, put, evict, prune, stats, clear, verify }
}
