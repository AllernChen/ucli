import { randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const CATEGORY_TARGETS = Object.freeze({
  'browser-cache': {
    target: 'browserCache', parent: 'browserCacheParent', names: ['electron-session-data', 'electron-session-data-dev']
  },
  'skill-staging': { target: 'skillStaging', parent: 'installedSkills', names: ['.source-staging'] },
  'update-downloads': { target: 'updateDownloads', parent: 'baseCache', names: ['ucli-updater'] }
})

function cleanupError(code) {
  return Object.assign(new Error(code), { code })
}

function validateMarkerPath(markerPath, roots) {
  if (typeof markerPath !== 'string' || typeof roots?.userData !== 'string' ||
    !path.isAbsolute(markerPath) || !path.isAbsolute(roots.userData) ||
    path.resolve(markerPath) !== path.join(path.resolve(roots.userData), 'storage-cleanup.json')) {
    throw cleanupError('STORAGE_CLEANUP_MARKER_UNSAFE')
  }
}

async function rejectMarkerLink(markerPath) {
  try {
    if ((await lstat(markerPath)).isSymbolicLink()) throw cleanupError('STORAGE_CLEANUP_MARKER_UNSAFE')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function rejectMarkerLinkSync(markerPath) {
  try {
    if (lstatSync(markerPath).isSymbolicLink()) throw cleanupError('STORAGE_CLEANUP_MARKER_UNSAFE')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function validateMarker(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || marker.version !== VERSION ||
    !Array.isArray(marker.categories) ||
    Object.keys(marker).some(key => !['version', 'categories'].includes(key))) {
    throw cleanupError('STORAGE_CLEANUP_MARKER_INVALID')
  }
  const seen = new Set()
  for (const categoryId of marker.categories) {
    if (typeof categoryId !== 'string' || !(categoryId in CATEGORY_TARGETS) || seen.has(categoryId)) {
      throw cleanupError('STORAGE_CLEANUP_MARKER_INVALID')
    }
    seen.add(categoryId)
  }
  return marker.categories
}

function exactDescendant(parent, target) {
  if (typeof parent !== 'string' || typeof target !== 'string' ||
    !path.isAbsolute(parent) || !path.isAbsolute(target)) return false
  const resolvedParent = path.resolve(parent)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget === path.parse(resolvedTarget).root) return false
  const relative = path.relative(resolvedParent, resolvedTarget)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function targetFor(categoryId, roots) {
  const config = CATEGORY_TARGETS[categoryId]
  const target = roots?.[config.target]
  const parent = roots?.[config.parent]
  if (!exactDescendant(parent, target) || !config.names.includes(path.basename(path.resolve(target)))) {
    throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
  }
  return path.resolve(target)
}

async function rejectLink(target) {
  try {
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function rejectConfiguredLinks(parent, target) {
  await rejectLink(parent)
  await rejectLink(target)
}

function rejectLinkSync(target) {
  try {
    if (lstatSync(target).isSymbolicLink()) throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function rejectConfiguredLinksSync(parent, target) {
  rejectLinkSync(parent)
  rejectLinkSync(target)
}

async function writeMarker(markerPath, categories) {
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 })
  const temporary = `${markerPath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: VERSION, categories })}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, markerPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function writeMarkerSync(markerPath, categories) {
  mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 })
  const temporary = `${markerPath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: VERSION, categories })}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, markerPath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export async function runScheduledStorageCleanup({ markerPath, roots, removeTarget } = {}) {
  validateMarkerPath(markerPath, roots)
  await rejectMarkerLink(markerPath)
  let text
  try {
    text = await readFile(markerPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: [], failed: [] }
    throw error
  }
  let marker
  try { marker = JSON.parse(text) } catch { throw cleanupError('STORAGE_CLEANUP_MARKER_INVALID') }
  const categories = validateMarker(marker)
  const targets = new Map()
  for (const categoryId of categories) {
    const target = targetFor(categoryId, roots)
    const parent = roots[CATEGORY_TARGETS[categoryId].parent]
    await rejectConfiguredLinks(parent, target)
    targets.set(categoryId, target)
  }

  const removeOwned = removeTarget || (target => rm(target, { recursive: true, force: true }))
  const removed = []
  const failed = []
  for (const categoryId of categories) {
    try {
      await removeOwned(targets.get(categoryId))
      removed.push(categoryId)
    } catch {
      failed.push(categoryId)
    }
  }
  if (failed.length === 0) await rm(markerPath, { force: true })
  else await writeMarker(markerPath, failed)
  return { removed, failed }
}

export function runScheduledStorageCleanupSync({ markerPath, roots } = {}) {
  validateMarkerPath(markerPath, roots)
  rejectMarkerLinkSync(markerPath)
  if (!existsSync(markerPath)) return { removed: [], failed: [] }
  let marker
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch {
    throw cleanupError('STORAGE_CLEANUP_MARKER_INVALID')
  }
  const categories = validateMarker(marker)
  const targets = new Map()
  for (const categoryId of categories) {
    const target = targetFor(categoryId, roots)
    const parent = roots[CATEGORY_TARGETS[categoryId].parent]
    rejectConfiguredLinksSync(parent, target)
    targets.set(categoryId, target)
  }
  const removed = []
  const failed = []
  for (const categoryId of categories) {
    try {
      rmSync(targets.get(categoryId), { recursive: true, force: true })
      removed.push(categoryId)
    } catch {
      failed.push(categoryId)
    }
  }
  if (failed.length === 0) rmSync(markerPath, { force: true })
  else writeMarkerSync(markerPath, failed)
  return { removed, failed }
}
