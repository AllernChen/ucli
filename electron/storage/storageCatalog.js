import path from 'node:path'

export const STORAGE_CATEGORY_IDS = Object.freeze([
  'core-data',
  'installed-skills',
  'other-user-data',
  'summary-cache',
  'summary-workspaces',
  'browser-cache',
  'skill-staging',
  'update-downloads',
  'logs'
])

const CORE_DATA_NAMES = Object.freeze([
  'ucli.db',
  'ucli.db.bak',
  'ucli-config.json',
  'ucli-sessions.json',
  'window-state.json'
])
const CORE_DATA_PATTERNS = Object.freeze([
  /^ucli\.db\.corrupt-\d+(?:-\d+)?\.bak$/
])

function storageRootError() {
  return Object.assign(new Error('Unsafe UCLI storage root'), {
    code: 'STORAGE_ROOT_UNSAFE'
  })
}

function requireAbsolute(value, pathApi) {
  if (typeof value !== 'string' || value.trim() === '' || !pathApi.isAbsolute(value)) {
    throw storageRootError()
  }
  const resolved = pathApi.resolve(value)
  const filesystemRoot = pathApi.parse(resolved).root
  const isFilesystemRoot = pathApi === path.win32
    ? resolved.toLowerCase() === filesystemRoot.toLowerCase()
    : resolved === filesystemRoot
  if (isFilesystemRoot) throw storageRootError()
  return resolved
}

function optionalRoot(pathname, extra = {}) {
  return Object.freeze({ path: pathname, optional: true, ...extra })
}

function descriptor(id, roots, extra = {}) {
  return Object.freeze({
    id,
    roots: Object.freeze(roots),
    ...extra
  })
}

/** Resolve only storage owned by UCLI. Provider and project roots are absent by design. */
export function resolveUcliStorageRoots({
  platform,
  env = {},
  homeDirectory,
  userDataPath,
  sessionDataPath
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw storageRootError()

  const userData = requireAbsolute(userDataPath, pathApi)
  const browserCache = requireAbsolute(sessionDataPath, pathApi)
  const home = requireAbsolute(homeDirectory, pathApi)
  let cacheBase
  let summaryRoot

  if (platform === 'win32') {
    cacheBase = requireAbsolute(env.LOCALAPPDATA, path.win32)
    summaryRoot = path.win32.join(cacheBase, 'UCLI', 'summary')
  } else if (platform === 'darwin') {
    cacheBase = path.posix.join(home, 'Library', 'Caches')
    summaryRoot = path.posix.join(cacheBase, 'UCLI', 'summary')
  } else {
    cacheBase = typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME.trim() !== ''
      ? requireAbsolute(env.XDG_CACHE_HOME, path.posix)
      : path.posix.join(home, '.cache')
    summaryRoot = path.posix.join(cacheBase, 'ucli', 'summary')
  }

  const installedSkills = pathApi.join(userData, 'skills')
  const skillStaging = pathApi.join(installedSkills, '.source-staging')
  const summaryCache = pathApi.join(summaryRoot, 'cache')
  const summaryWorkspaces = pathApi.join(summaryRoot, 'workspaces')
  const updateDownloads = pathApi.join(cacheBase, 'ucli-updater')
  const logs = pathApi.join(userData, 'ucli.log')
  const coreRoot = optionalRoot(userData, {
    includeNames: CORE_DATA_NAMES,
    includePatterns: CORE_DATA_PATTERNS
  })
  const ownedUserDataPaths = [
    installedSkills,
    summaryRoot,
    browserCache,
    updateDownloads,
    logs
  ]

  const descriptors = Object.freeze([
    descriptor('core-data', [coreRoot]),
    descriptor('installed-skills', [optionalRoot(installedSkills)], {
      excludePaths: Object.freeze([skillStaging])
    }),
    descriptor('other-user-data', [optionalRoot(userData)], {
      excludePaths: Object.freeze(ownedUserDataPaths),
      excludeNames: CORE_DATA_NAMES,
      excludePatterns: CORE_DATA_PATTERNS
    }),
    descriptor('summary-cache', [optionalRoot(summaryCache)]),
    descriptor('summary-workspaces', [optionalRoot(summaryWorkspaces)]),
    descriptor('browser-cache', [optionalRoot(browserCache)]),
    descriptor('skill-staging', [optionalRoot(skillStaging)]),
    descriptor('update-downloads', [optionalRoot(updateDownloads)]),
    descriptor('logs', [optionalRoot(logs)])
  ])

  return Object.freeze({
    userData,
    baseCache: cacheBase,
    cacheBase,
    summaryRoot,
    installedSkills,
    skillStaging,
    summaryCache,
    summaryWorkspaces,
    browserCache,
    updateDownloads,
    logs,
    descriptors
  })
}
