import path from 'node:path'

const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const CHILD_CATEGORIES = new Set(['workspaces', 'cache'])

function storageError(code) {
  return Object.assign(new Error(code), { code })
}

function requireDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  return value
}

function requireAbsoluteDirectory(value, pathApi) {
  const directory = requireDirectory(value)
  if (!pathApi.isAbsolute(directory)) {
    throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
  }
  return directory
}

function pathApiFor(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? path.win32
    : path.posix
}

export function resolveSummaryStorageRoot({
  platform,
  env = {},
  homeDirectory
} = {}) {
  if (platform === 'win32') {
    const localAppData = requireAbsoluteDirectory(env.LOCALAPPDATA, path.win32)
    return path.win32.resolve(localAppData, 'UCLI', 'summary')
  }

  const home = requireAbsoluteDirectory(homeDirectory, path.posix)
  if (platform === 'darwin') {
    return path.posix.resolve(home, 'Library', 'Caches', 'UCLI', 'summary')
  }
  if (platform === 'linux') {
    const cacheRoot = typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME.trim() !== ''
      ? requireAbsoluteDirectory(env.XDG_CACHE_HOME, path.posix)
      : path.posix.resolve(home, '.cache')
    return path.posix.resolve(cacheRoot, 'ucli', 'summary')
  }

  throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
}

export function assertSafeSummaryChild(root, candidate) {
  const safeRoot = requireDirectory(root)
  const safeCandidate = requireDirectory(candidate)
  const pathApi = pathApiFor(safeRoot)

  if (!pathApi.isAbsolute(safeRoot) || !pathApi.isAbsolute(safeCandidate)) {
    throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
  }

  const resolvedRoot = pathApi.resolve(safeRoot)
  const resolvedCandidate = pathApi.resolve(safeCandidate)
  const relative = pathApi.relative(resolvedRoot, resolvedCandidate)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
  }

  return resolvedCandidate
}

export function resolveSummaryChild(root, category, opaqueId) {
  if (!CHILD_CATEGORIES.has(category) || !OPAQUE_ID.test(String(opaqueId || ''))) {
    throw storageError('SUMMARY_STORAGE_PATH_UNSAFE')
  }

  const safeRoot = requireDirectory(root)
  const pathApi = pathApiFor(safeRoot)
  return assertSafeSummaryChild(
    safeRoot,
    pathApi.resolve(safeRoot, category, opaqueId)
  )
}
