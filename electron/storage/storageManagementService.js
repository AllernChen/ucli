import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { STORAGE_CATEGORY_IDS } from './storageCatalog.js'

const PROTECTED = new Set(['core-data', 'installed-skills', 'other-user-data'])
const IMMEDIATE = new Set(['summary-cache', 'summary-workspaces', 'logs'])
const RESTART = new Set(['browser-cache', 'skill-staging', 'update-downloads'])
const KNOWN = new Set(STORAGE_CATEGORY_IDS)
const MARKER_VERSION = 1

function storageError(code) {
  return Object.assign(new Error(code), { code })
}

function markerPathFor(roots) {
  if (!roots || typeof roots.userData !== 'string' || !path.isAbsolute(roots.userData)) {
    throw storageError('STORAGE_ROOT_UNSAFE')
  }
  return path.join(path.resolve(roots.userData), 'storage-cleanup.json')
}

function validateCategoryId(categoryId) {
  if (typeof categoryId !== 'string' || !KNOWN.has(categoryId)) {
    throw storageError('STORAGE_CATEGORY_UNKNOWN')
  }
  return categoryId
}

function validateMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    value.version !== MARKER_VERSION || !Array.isArray(value.categories) ||
    Object.keys(value).some(key => !['version', 'categories'].includes(key))) return null
  const categories = []
  for (const categoryId of value.categories) {
    if (typeof categoryId !== 'string' || !RESTART.has(categoryId) || categories.includes(categoryId)) return null
    categories.push(categoryId)
  }
  return categories
}

async function readPending(markerPath) {
  try {
    const categories = validateMarker(JSON.parse(await readFile(markerPath, 'utf8')))
    if (!categories) throw storageError('STORAGE_CLEANUP_MARKER_INVALID')
    return categories
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    if (error?.code === 'STORAGE_CLEANUP_MARKER_INVALID') throw error
    if (error instanceof SyntaxError) throw storageError('STORAGE_CLEANUP_MARKER_INVALID')
    throw error
  }
}

async function writePending(markerPath, categories) {
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 })
  const temporary = `${markerPath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: MARKER_VERSION, categories })}\n`, {
      flag: 'wx', mode: 0o600
    })
    await rename(temporary, markerPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function clearMode(id) {
  if (IMMEDIATE.has(id)) return 'immediate'
  if (RESTART.has(id)) return 'restart'
  return 'none'
}

export function createStorageManagementService({
  scanner,
  roots,
  summaryCache,
  summaryWorkspaces,
  isWorkspaceProtected = () => false,
  logger,
  now = Date.now
} = {}) {
  if (typeof scanner !== 'function' || !Array.isArray(roots?.descriptors) ||
    typeof summaryCache?.clear !== 'function' ||
    typeof summaryWorkspaces?.clearDerived !== 'function' ||
    typeof isWorkspaceProtected !== 'function' || typeof logger?.truncate !== 'function') {
    throw storageError('STORAGE_SERVICE_INVALID')
  }
  const markerPath = markerPathFor(roots)
  let revision = 0
  let markerQueue = Promise.resolve()

  function scheduleRestart(categoryId) {
    const operation = markerQueue.then(async () => {
      const pending = await readPending(markerPath)
      const categories = STORAGE_CATEGORY_IDS.filter(id =>
        RESTART.has(id) && (id === categoryId || pending.includes(id)))
      if (!pending.includes(categoryId)) await writePending(markerPath, categories)
      return { categoryId, pendingRestart: true }
    })
    markerQueue = operation.catch(() => {})
    return operation
  }

  async function getUsage() {
    const [scanned, pendingRestart] = await Promise.all([
      scanner(roots.descriptors),
      readPending(markerPath)
    ])
    const byId = new Map(scanned.map(category => [category.id, category]))
    const categories = STORAGE_CATEGORY_IDS.map(id => {
      const scan = byId.get(id) || {}
      const bytes = safeInteger(scan.bytes)
      const mode = clearMode(id)
      const scheduled = pendingRestart.includes(id)
      const status = scheduled ? 'scheduled' : ['ready', 'partial', 'unavailable'].includes(scan.status)
        ? scan.status
        : 'unavailable'
      return {
        id,
        bytes,
        itemCount: safeInteger(scan.itemCount),
        reclaimableBytes: mode === 'none' ? 0 : bytes,
        status,
        clearMode: mode
      }
    })
    revision = Math.min(Number.MAX_SAFE_INTEGER, revision + 1)
    return {
      revision,
      scannedAt: safeInteger(now()),
      totalBytes: categories.reduce((sum, item) => Math.min(Number.MAX_SAFE_INTEGER, sum + item.bytes), 0),
      reclaimableBytes: categories.reduce((sum, item) =>
        Math.min(Number.MAX_SAFE_INTEGER, sum + item.reclaimableBytes), 0),
      pendingRestart,
      categories
    }
  }

  async function remainingBytes(categoryId) {
    const descriptor = roots.descriptors.find(item => item.id === categoryId)
    if (!descriptor) return 0
    const [result] = await scanner([descriptor])
    return safeInteger(result?.bytes)
  }

  async function clear({ categoryId } = {}) {
    validateCategoryId(categoryId)
    if (PROTECTED.has(categoryId)) throw storageError('STORAGE_CATEGORY_PROTECTED')
    if (RESTART.has(categoryId)) {
      return scheduleRestart(categoryId)
    }

    const before = await remainingBytes(categoryId)
    let result = { removed: 0, bytes: 0 }
    try {
      if (categoryId === 'summary-cache') result = await summaryCache.clear()
      else if (categoryId === 'summary-workspaces') {
        result = await summaryWorkspaces.clearDerived({ isProtected: isWorkspaceProtected })
      } else if (categoryId === 'logs') {
        await logger.truncate()
        result = { removed: 1, bytes: 0 }
      } else throw storageError('STORAGE_CATEGORY_UNKNOWN')
    } catch (error) {
      if (error?.code === 'STORAGE_CATEGORY_UNKNOWN') throw error
      // A locked or transiently unavailable entry is observable through the
      // authoritative post-cleanup scan instead of turning partial work into failure.
    }

    const remaining = await remainingBytes(categoryId)
    return {
      categoryId,
      pendingRestart: false,
      removed: safeInteger(result?.removed),
      bytes: Math.max(0, before - remaining),
      remainingBytes: remaining,
      partial: remaining > 0
    }
  }

  return { getUsage, clear }
}
