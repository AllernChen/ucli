import { randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
  await rejectPathChain(parent)
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
  rejectPathChainSync(parent)
  rejectLinkSync(target)
}

function chainPaths(target) {
  const resolved = path.resolve(target)
  const root = path.parse(resolved).root
  const relative = path.relative(root, resolved)
  const paths = []
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    paths.push(current)
  }
  return paths
}

async function rejectPathChain(target) {
  for (const candidate of chainPaths(target)) await rejectLink(candidate)
}

function rejectPathChainSync(target) {
  for (const candidate of chainPaths(target)) rejectLinkSync(candidate)
}

async function prepareTarget(categoryId, roots) {
  const target = targetFor(categoryId, roots)
  const parent = roots[CATEGORY_TARGETS[categoryId].parent]
  await rejectConfiguredLinks(parent, target)
  const parentRealpath = await realpath(parent)
  return { target, parent: path.resolve(parent), parentRealpath: path.resolve(parentRealpath) }
}

function prepareTargetSync(categoryId, roots) {
  const target = targetFor(categoryId, roots)
  const parent = roots[CATEGORY_TARGETS[categoryId].parent]
  rejectConfiguredLinksSync(parent, target)
  const parentRealpath = realpathSync(parent)
  return { target, parent: path.resolve(parent), parentRealpath: path.resolve(parentRealpath) }
}

async function restoreQuarantine(quarantine, target) {
  try {
    await rejectLink(quarantine)
    try { await lstat(target); return } catch (error) { if (error?.code !== 'ENOENT') return }
    await rename(quarantine, target)
  } catch { /* Leave the quarantined entry untouched for a later safe cleanup. */ }
}

function restoreQuarantineSync(quarantine, target) {
  try {
    rejectLinkSync(quarantine)
    if (existsSync(target)) return
    renameSync(quarantine, target)
  } catch { /* Leave the quarantined entry untouched for a later safe cleanup. */ }
}

async function quarantineAndRemove(entry, { categoryId, beforeRemove, removeTarget }) {
  const { target, parent, parentRealpath } = entry
  await beforeRemove?.({ categoryId, target, parent })
  await rejectConfiguredLinks(parent, target)
  if (path.resolve(await realpath(parent)) !== parentRealpath) throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
  try { await lstat(target) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  const quarantine = path.join(parent, `.ucli-cleanup-${randomUUID()}`)
  await rename(target, quarantine)
  try {
    await rejectPathChain(parent)
    await rejectLink(quarantine)
    const quarantineRealpath = path.resolve(await realpath(quarantine))
    if (path.resolve(await realpath(parent)) !== parentRealpath ||
      path.dirname(quarantineRealpath) !== parentRealpath ||
      path.basename(quarantineRealpath) !== path.basename(quarantine)) {
      throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
    }
  } catch (error) {
    await restoreQuarantine(quarantine, target)
    throw error
  }
  const removeOwned = removeTarget || (pathname => rm(pathname, { recursive: true, force: true }))
  try {
    // Node has no handle-relative recursive removal API. The unpredictable
    // same-parent rename plus immediate link/realpath checks minimize the
    // remaining check-to-rm window; a remove failure restores the exact name.
    await removeOwned(quarantine, { categoryId, originalTarget: target })
  } catch (error) {
    await restoreQuarantine(quarantine, target)
    throw error
  }
}

function quarantineAndRemoveSync(entry, { categoryId, beforeRemove }) {
  const { target, parent, parentRealpath } = entry
  beforeRemove?.({ categoryId, target, parent })
  rejectConfiguredLinksSync(parent, target)
  if (path.resolve(realpathSync(parent)) !== parentRealpath) throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
  try { lstatSync(target) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  const quarantine = path.join(parent, `.ucli-cleanup-${randomUUID()}`)
  renameSync(target, quarantine)
  try {
    rejectPathChainSync(parent)
    rejectLinkSync(quarantine)
    const quarantineRealpath = path.resolve(realpathSync(quarantine))
    if (path.resolve(realpathSync(parent)) !== parentRealpath ||
      path.dirname(quarantineRealpath) !== parentRealpath ||
      path.basename(quarantineRealpath) !== path.basename(quarantine)) {
      throw cleanupError('STORAGE_CLEANUP_TARGET_UNSAFE')
    }
  } catch (error) {
    restoreQuarantineSync(quarantine, target)
    throw error
  }
  try {
    // See the async boundary note above; Node exposes no handle-relative rmSync.
    rmSync(quarantine, { recursive: true, force: true })
  } catch (error) {
    restoreQuarantineSync(quarantine, target)
    throw error
  }
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

export async function runScheduledStorageCleanup({ markerPath, roots, removeTarget, beforeRemove } = {}) {
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
    targets.set(categoryId, await prepareTarget(categoryId, roots))
  }

  const removed = []
  const failed = []
  for (const categoryId of categories) {
    try {
      await quarantineAndRemove(targets.get(categoryId), { categoryId, beforeRemove, removeTarget })
      removed.push(categoryId)
    } catch {
      failed.push(categoryId)
    }
  }
  if (failed.length === 0) await rm(markerPath, { force: true })
  else await writeMarker(markerPath, failed)
  return { removed, failed }
}

export function runScheduledStorageCleanupSync({ markerPath, roots, beforeRemove } = {}) {
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
    targets.set(categoryId, prepareTargetSync(categoryId, roots))
  }
  const removed = []
  const failed = []
  for (const categoryId of categories) {
    try {
      quarantineAndRemoveSync(targets.get(categoryId), { categoryId, beforeRemove })
      removed.push(categoryId)
    } catch {
      failed.push(categoryId)
    }
  }
  if (failed.length === 0) rmSync(markerPath, { force: true })
  else writeMarkerSync(markerPath, failed)
  return { removed, failed }
}
