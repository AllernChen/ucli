import { lstat, opendir } from 'node:fs/promises'
import path from 'node:path'

const MAX_SAFE = Number.MAX_SAFE_INTEGER

function storageRootError() {
  return Object.assign(new Error('Unsafe UCLI storage root'), {
    code: 'STORAGE_ROOT_UNSAFE'
  })
}

function safeAdd(left, right) {
  if (typeof right !== 'number' || !Number.isFinite(right) || right <= 0) return left
  const increment = Math.floor(right)
  return left >= MAX_SAFE - increment ? MAX_SAFE : left + increment
}

function normaliseLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function pathApiFor(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? path.win32
    : path.posix
}

function canonical(value) {
  if (typeof value !== 'string' || value.trim() === '') throw storageRootError()
  const pathApi = pathApiFor(value)
  if (!pathApi.isAbsolute(value)) throw storageRootError()
  const resolved = pathApi.resolve(value)
  return {
    path: resolved,
    key: pathApi === path.win32 ? resolved.toLowerCase() : resolved,
    pathApi
  }
}

function isAtOrBelow(candidate, excluded) {
  if (candidate.pathApi !== excluded.pathApi) return false
  const relative = candidate.pathApi.relative(excluded.path, candidate.path)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${candidate.pathApi.sep}`) &&
    !candidate.pathApi.isAbsolute(relative)
  )
}

function matchesName(name, names, patterns) {
  return names.has(name) || patterns.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(name)
  })
}

function normaliseRoot(value) {
  const config = typeof value === 'string' ? { path: value } : value
  if (!config || typeof config !== 'object') throw storageRootError()
  return {
    ...canonical(config.path),
    optional: config.optional === true,
    includeNames: new Set(Array.isArray(config.includeNames) ? config.includeNames : []),
    includePatterns: Array.isArray(config.includePatterns) ? config.includePatterns : []
  }
}

function normaliseDescriptor(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id === '') {
    throw storageRootError()
  }
  if (!Array.isArray(descriptor.roots) || descriptor.roots.length === 0) {
    throw storageRootError()
  }
  return {
    id: descriptor.id,
    roots: descriptor.roots.map(normaliseRoot),
    excludePaths: (descriptor.excludePaths || []).map(canonical),
    excludeNames: new Set(Array.isArray(descriptor.excludeNames) ? descriptor.excludeNames : []),
    excludePatterns: Array.isArray(descriptor.excludePatterns) ? descriptor.excludePatterns : []
  }
}

function result(id, bytes, itemCount, status) {
  return { id, bytes, itemCount, status }
}

/**
 * Count UCLI-owned regular-file bytes and entries without following links.
 * The return envelope intentionally contains no local path or entry name.
 */
export async function scanStorageCategories(descriptors, options = {}) {
  if (!Array.isArray(descriptors)) throw storageRootError()
  const categories = descriptors.map(normaliseDescriptor)
  const maxEntries = normaliseLimit(options.maxEntries, 100000)
  const maxDepth = normaliseLimit(options.maxDepth, 32)
  const results = []
  let visitedEntries = 0
  let stopped = false

  for (const category of categories) {
    if (stopped) {
      results.push(result(category.id, 0, 0, 'partial'))
      continue
    }

    let bytes = 0
    let itemCount = 0
    let status = 'ready'
    let limitReached = false
    const stack = []

    for (let index = category.roots.length - 1; index >= 0; index -= 1) {
      stack.push({ root: category.roots[index], depth: 0, countSelf: false })
    }

    while (stack.length > 0) {
      const current = stack.pop()
      let stats
      try {
        stats = await lstat(current.root.path)
      } catch (error) {
        if (current.root.optional && error?.code === 'ENOENT') continue
        status = 'unavailable'
        break
      }

      if (current.countSelf) {
        itemCount = safeAdd(itemCount, 1)
        if (stats.isFile()) bytes = safeAdd(bytes, stats.size)
      } else if (stats.isFile() || stats.isSymbolicLink()) {
        if (visitedEntries >= maxEntries) {
          status = 'partial'
          stopped = true
          break
        }
        visitedEntries = safeAdd(visitedEntries, 1)
        itemCount = safeAdd(itemCount, 1)
        if (stats.isFile()) bytes = safeAdd(bytes, stats.size)
      }

      if (!stats.isDirectory() || stats.isSymbolicLink()) continue
      if (limitReached) continue
      if (current.depth >= maxDepth) {
        status = 'partial'
        continue
      }

      let directory
      try {
        directory = await opendir(current.root.path)
      } catch {
        status = 'unavailable'
        break
      }

      for await (const entry of directory) {
        if (visitedEntries >= maxEntries) {
          status = 'partial'
          limitReached = true
          break
        }
        visitedEntries = safeAdd(visitedEntries, 1)
        const name = entry.name
        if (
          current.depth === 0 &&
          (current.root.includeNames.size > 0 || current.root.includePatterns.length > 0) &&
          !matchesName(name, current.root.includeNames, current.root.includePatterns)
        ) continue
        if (
          current.depth === 0 &&
          matchesName(name, category.excludeNames, category.excludePatterns)
        ) continue

        const candidatePath = current.root.pathApi.resolve(current.root.path, name)
        const candidate = canonical(candidatePath)
        if (category.excludePaths.some(excluded => isAtOrBelow(candidate, excluded))) continue
        stack.push({
          root: { ...current.root, path: candidate.path, key: candidate.key },
          depth: current.depth + 1,
          countSelf: true
        })
      }
    }

    if (limitReached) stopped = true

    results.push(result(category.id, bytes, itemCount, status))
  }

  return results
}
