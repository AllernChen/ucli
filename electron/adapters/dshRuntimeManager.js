import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  SUPPORTED_DSH_VERSION,
  inspectDshRuntime,
  resolveNpmLaunch,
  runResolvedProcess
} from './deepSeekHarnessRuntime.js'

export const DSH_INTEGRITY = 'sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg=='
export const MANAGED_PNPM_VERSION = '10.30.3'

const OWNER_MARKER = '.ucli-dsh-runtime.json'
const OWNER = Object.freeze({ name: 'ucli-dsh-runtime', version: '0.11.1' })
const MAX_JSON_BYTES = 8 * 1024 * 1024
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const BACKUP_NAME_PATTERN = /^\.backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function runtimeError(code) {
  return Object.assign(new Error(code), { code })
}

function readBoundedJson(file, io = { lstat: lstatSync, readFile: readFileSync }) {
  const stat = io.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw runtimeError('DSH_RUNTIME_INVALID')
  }
  const value = JSON.parse(io.readFile(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('DSH_RUNTIME_INVALID')
  }
  return value
}

function resolveBin(manifest) {
  return String(typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh || '')
    .replaceAll('\\', '/')
}

function equalPath(left, right, platform) {
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertLexicallyDisjoint(runtimeDirectory, dshHome) {
  if (
    isSameOrDescendant(runtimeDirectory, dshHome) ||
    isSameOrDescendant(dshHome, runtimeDirectory)
  ) throw runtimeError('DSH_RUNTIME_PATH_CONFLICT')
}

function assertRuntimeAncestorsUnlinked(runtimeDirectory, io) {
  const root = path.parse(runtimeDirectory).root
  const relative = path.relative(root, runtimeDirectory)
  let cursor = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    try {
      const stat = io.lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw runtimeError('DSH_RUNTIME_PATH_UNSAFE')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error?.code === 'DSH_RUNTIME_PATH_UNSAFE'
        ? error
        : runtimeError('DSH_RUNTIME_PATH_UNSAFE')
    }
  }
}

function canonicalProjection(target, io) {
  let existing = target
  const missing = []
  while (true) {
    try {
      io.lstat(existing)
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw runtimeError('DSH_RUNTIME_PATH_UNSAFE')
      const parent = path.dirname(existing)
      if (parent === existing) throw runtimeError('DSH_RUNTIME_PATH_UNSAFE')
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
  let canonical
  try {
    canonical = io.realpath(existing)
  } catch {
    throw runtimeError('DSH_RUNTIME_PATH_UNSAFE')
  }
  return path.resolve(canonical, ...missing)
}

function assertSafeRuntimePlacement(runtimeDirectory, dshHome, io) {
  assertLexicallyDisjoint(runtimeDirectory, dshHome)
  assertRuntimeAncestorsUnlinked(runtimeDirectory, io)
  const runtimeCanonical = canonicalProjection(runtimeDirectory, io)
  const homeCanonical = canonicalProjection(dshHome, io)
  if (
    isSameOrDescendant(runtimeCanonical, homeCanonical) ||
    isSameOrDescendant(homeCanonical, runtimeCanonical)
  ) throw runtimeError('DSH_RUNTIME_PATH_CONFLICT')
}

function safeDirectory(io, directory, expectedParent, platform) {
  const stat = io.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError('DSH_RUNTIME_INVALID')
  const canonical = io.realpath(directory)
  if (expectedParent && !equalPath(path.dirname(canonical), expectedParent, platform)) {
    throw runtimeError('DSH_RUNTIME_INVALID')
  }
  return canonical
}

function safeFile(io, file, expectedParent, platform) {
  const stat = io.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw runtimeError('DSH_RUNTIME_INVALID')
  const canonical = io.realpath(file)
  if (!equalPath(path.dirname(canonical), expectedParent, platform)) {
    throw runtimeError('DSH_RUNTIME_INVALID')
  }
  return canonical
}

function verifyTreeRoot(tree, io, runtimeDirectory, platform) {
  const runtimeCanonical = safeDirectory(io, runtimeDirectory, null, platform)
  return safeDirectory(io, tree, runtimeCanonical, platform)
}

function readSafeDshManifest(tree, rootCanonical, io, platform) {
  const nodeModules = path.join(tree, 'node_modules')
  const nodeModulesCanonical = safeDirectory(io, nodeModules, rootCanonical, platform)
  const scope = path.join(nodeModules, '@deepseek-ai')
  const scopeCanonical = safeDirectory(io, scope, nodeModulesCanonical, platform)
  const packageDirectory = path.join(scope, 'dsh')
  const packageCanonical = safeDirectory(io, packageDirectory, scopeCanonical, platform)
  const manifestPath = path.join(packageDirectory, 'package.json')
  safeFile(io, manifestPath, packageCanonical, platform)
  return readBoundedJson(manifestPath, io)
}

function verifyStaging(staging, io, runtimeDirectory, platform) {
  try {
    const stagingCanonical = verifyTreeRoot(staging, io, runtimeDirectory, platform)
    const nodeModules = path.join(staging, 'node_modules')
    const nodeModulesCanonical = safeDirectory(io, nodeModules, stagingCanonical, platform)
    const scope = path.join(nodeModules, '@deepseek-ai')
    const scopeCanonical = safeDirectory(io, scope, nodeModulesCanonical, platform)
    const packageDirectory = path.join(scope, 'dsh')
    const packageCanonical = safeDirectory(io, packageDirectory, scopeCanonical, platform)
    const manifestPath = path.join(packageDirectory, 'package.json')
    safeFile(io, manifestPath, packageCanonical, platform)
    const manifest = readBoundedJson(manifestPath, io)
    const lib = path.join(packageDirectory, 'lib')
    const libCanonical = safeDirectory(io, lib, packageCanonical, platform)
    const entry = path.join(lib, 'bin.js')
    safeFile(io, entry, libCanonical, platform)
    if (
      manifest.name !== '@deepseek-ai/dsh' ||
      manifest.version !== SUPPORTED_DSH_VERSION ||
      resolveBin(manifest) !== 'lib/bin.js'
    ) throw runtimeError('DSH_RUNTIME_INVALID')
    const pnpmDirectory = path.join(nodeModules, 'pnpm')
    const pnpmCanonical = safeDirectory(io, pnpmDirectory, nodeModulesCanonical, platform)
    const pnpmManifestPath = path.join(pnpmDirectory, 'package.json')
    safeFile(io, pnpmManifestPath, pnpmCanonical, platform)
    const pnpmManifest = readBoundedJson(pnpmManifestPath, io)
    if (pnpmManifest.name !== 'pnpm' || pnpmManifest.version !== MANAGED_PNPM_VERSION) {
      throw runtimeError('DSH_RUNTIME_INVALID')
    }
    const lockPath = path.join(staging, 'package-lock.json')
    safeFile(io, lockPath, stagingCanonical, platform)
    const lock = readBoundedJson(lockPath, io)
    const locked = lock.packages?.['node_modules/@deepseek-ai/dsh']
    if (locked?.version !== SUPPORTED_DSH_VERSION || locked?.integrity !== DSH_INTEGRITY) {
      throw runtimeError('DSH_RUNTIME_INVALID')
    }
    return { packageDirectory, entry, rootCanonical: stagingCanonical }
  } catch (error) {
    if (error?.code === 'DSH_RUNTIME_INVALID') throw error
    throw runtimeError('DSH_RUNTIME_INVALID')
  }
}

function hasExactOwner(tree, rootCanonical, io, platform) {
  const markerPath = path.join(tree, OWNER_MARKER)
  safeFile(io, markerPath, rootCanonical, platform)
  const marker = readBoundedJson(markerPath, io)
  return marker.name === OWNER.name && marker.version === OWNER.version &&
    Object.keys(marker).length === 2
}

function missingRuntime() {
  return { installed: false, compatible: false, version: '', health: 'missing' }
}

function sanitizeRuntime(runtime) {
  const installed = runtime?.installed === true
  const candidateVersion = installed && typeof runtime?.version === 'string' ? runtime.version : ''
  const version = candidateVersion.length <= 64 && VERSION_PATTERN.test(candidateVersion)
    ? candidateVersion
    : ''
  const compatible = installed && runtime?.compatible === true && version === SUPPORTED_DSH_VERSION
  const health = !installed ? 'missing' : compatible ? 'healthy' : 'unhealthy'
  return { installed, compatible, version, health }
}

export function createDshRuntimeManager({
  runtimeDirectory,
  dshHome,
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  resolveNpm = () => resolveNpmLaunch({ env, platform, nodeExecutable }),
  inspectSystem = () => inspectDshRuntime({ env }),
  execute = runResolvedProcess,
  assertQuiescent = async () => true,
  id = randomUUID,
  fs = {}
} = {}) {
  if (!path.isAbsolute(runtimeDirectory || '') || !path.isAbsolute(dshHome || '')) {
    throw new TypeError('Absolute runtimeDirectory and dshHome are required')
  }
  assertLexicallyDisjoint(runtimeDirectory, dshHome)
  const io = {
    mkdir: fs.mkdir || ((target, options) => mkdirSync(target, options)),
    rename: fs.rename || renameSync,
    remove: fs.remove || ((target, options) => rmSync(target, options)),
    writeFile: fs.writeFile || writeFileSync,
    realpath: fs.realpath || realpathSync,
    lstat: fs.lstat || lstatSync,
    readFile: fs.readFile || readFileSync,
    readdir: fs.readdir || readdirSync
  }
  assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
  const current = path.join(runtimeDirectory, 'current')
  let operation = null
  let revision = 1
  let lastErrorCode = null
  let managed = missingRuntime()
  let managedOwned = false
  let system = missingRuntime()
  let managedLaunch = null
  let systemLaunch = null
  let pendingBackupCleanup = null

  const refreshManaged = () => {
    try {
      assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
    } catch {
      managed = missingRuntime()
      managedOwned = false
      managedLaunch = null
      return
    }
    try {
      const stat = io.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError('DSH_RUNTIME_INVALID')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        managed = missingRuntime()
        managedOwned = false
        managedLaunch = null
        return
      }
      managed = { installed: true, compatible: false, version: '', health: 'unhealthy' }
      managedOwned = false
      managedLaunch = null
      return
    }
    let detectedVersion = ''
    let currentCanonical = null
    try {
      currentCanonical = verifyTreeRoot(current, io, runtimeDirectory, platform)
      const manifest = readSafeDshManifest(current, currentCanonical, io, platform)
      if (typeof manifest.version === 'string' && manifest.version.length <= 64 && VERSION_PATTERN.test(manifest.version)) {
        detectedVersion = manifest.version
      }
    } catch {}
    try {
      currentCanonical ||= verifyTreeRoot(current, io, runtimeDirectory, platform)
      managedOwned = hasExactOwner(current, currentCanonical, io, platform)
    } catch {
      managedOwned = false
    }
    try {
      const verified = verifyStaging(current, io, runtimeDirectory, platform)
      if (!managedOwned) throw runtimeError('DSH_RUNTIME_INVALID')
      managed = { installed: true, compatible: true, version: SUPPORTED_DSH_VERSION, health: 'healthy' }
      managedLaunch = {
        source: 'managed',
        launch: { file: nodeExecutable, prefixArgs: [path.resolve(verified.entry)] },
        home: dshHome
      }
    } catch {
      managed = { installed: true, compatible: false, version: detectedVersion, health: 'unhealthy' }
      managedLaunch = null
    }
  }

  const refreshSystem = async () => {
    try {
      const inspected = await inspectSystem()
      system = sanitizeRuntime(inspected)
      systemLaunch = system.compatible && system.health === 'healthy'
        ? { source: 'system', launch: inspected.launch, home: inspected.home || dshHome }
        : null
    } catch {
      system = missingRuntime()
      systemLaunch = null
    }
  }

  const publicState = (busy = operation !== null) => {
    const selected = managed.compatible && managed.health === 'healthy'
      ? 'managed'
      : system.compatible && system.health === 'healthy' ? 'system' : null
    let action = null
    if (!['DSH_RUNTIME_PATH_UNSAFE', 'DSH_RUNTIME_PATH_CONFLICT'].includes(lastErrorCode)) {
      if (!managed.installed) action = 'install'
      else if (managedOwned && !pendingBackupCleanup) {
        action = !managed.compatible && managed.version && managed.version !== SUPPORTED_DSH_VERSION
          ? 'upgrade'
          : managed.health !== 'healthy' ? 'repair' : 'remove'
      }
    }
    return Object.freeze({
      revision,
      supportedVersion: SUPPORTED_DSH_VERSION,
      managed: Object.freeze({ ...managed }),
      system: Object.freeze({ ...system }),
      selected,
      action,
      busy,
      errorCode: lastErrorCode
    })
  }

  const initialize = async () => {
    refreshManaged()
    if (managedOwned && managed.health === 'healthy') {
      let names = []
      try { names = io.readdir(runtimeDirectory) } catch {}
      for (const name of names) {
        if (!BACKUP_NAME_PATTERN.test(name)) continue
        const candidate = path.join(runtimeDirectory, name)
        try {
          const rootCanonical = verifyTreeRoot(candidate, io, runtimeDirectory, platform)
          if (!hasExactOwner(candidate, rootCanonical, io, platform)) continue
          io.remove(candidate, { recursive: true, force: true })
          revision += 1
        } catch (error) {
          try {
            const rootCanonical = verifyTreeRoot(candidate, io, runtimeDirectory, platform)
            if (!hasExactOwner(candidate, rootCanonical, io, platform)) continue
          } catch {
            continue
          }
          pendingBackupCleanup = candidate
          lastErrorCode = 'DSH_RUNTIME_BACKUP_CLEANUP_FAILED'
          break
        }
      }
    }
    await refreshSystem()
  }
  let initialized = initialize()

  const fail = async (code, busy = operation !== null) => {
    lastErrorCode = code
    refreshManaged()
    await refreshSystem()
    return publicState(busy)
  }

  const completeMutation = state => {
    revision += 1
    return Object.freeze({ ...state, revision })
  }

  const transact = expected => {
    if (operation) return operation
    const work = (async () => {
      await initialized
      try {
        assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
      } catch (error) {
        return fail(error?.code || 'DSH_RUNTIME_PATH_UNSAFE', false)
      }
      if (
        (expected === 'install' && managed.installed) ||
        (expected !== 'install' && !managedOwned) ||
        (expected === 'upgrade' && (
          !managed.installed || !managed.version || managed.version === SUPPORTED_DSH_VERSION
        )) ||
        (expected === 'repair' && (
          !managed.installed ||
          (managed.version && managed.version !== SUPPORTED_DSH_VERSION) ||
          managed.health === 'healthy'
        ))
      ) return fail('DSH_RUNTIME_ACTION_INVALID', false)
      try {
        if (await assertQuiescent() !== true) return fail('DSH_RUNTIME_BUSY', false)
      } catch {
        return fail('DSH_RUNTIME_BUSY', false)
      }
      try {
        assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
      } catch (error) {
        return fail(error?.code || 'DSH_RUNTIME_PATH_UNSAFE', false)
      }
      let npm
      try {
        npm = resolveNpm()
      } catch {
        return fail('DSH_NPM_UNAVAILABLE', false)
      }
      if (!npm || !path.isAbsolute(npm.file || '') || !Array.isArray(npm.prefixArgs) || !npm.prefixArgs.every(path.isAbsolute)) {
        return fail('DSH_NPM_UNAVAILABLE', false)
      }
      let staging = null
      let backup = null
      let backedUp = false
      let promoted = false
      try {
        io.mkdir(runtimeDirectory, { recursive: true })
        const transactionId = id()
        if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
          throw runtimeError('DSH_RUNTIME_INSTALL_FAILED')
        }
        staging = path.join(runtimeDirectory, `.staging-${transactionId}`)
        backup = path.join(runtimeDirectory, `.backup-${transactionId}`)
        io.mkdir(staging, { recursive: false })
        const result = await execute(npm.file, [
          ...npm.prefixArgs,
          'install', '--prefix', staging,
          '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund',
          '--package-lock=true', `@deepseek-ai/dsh@${SUPPORTED_DSH_VERSION}`, `pnpm@${MANAGED_PNPM_VERSION}`
        ], {
          cwd: runtimeDirectory, env, shell: false, timeoutMs: 900_000, maxOutputBytes: 16 * 1024
        })
        if (result?.code !== 0 || result?.terminationConfirmed === false) throw runtimeError('DSH_RUNTIME_INSTALL_FAILED')
        assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
        verifyStaging(staging, io, runtimeDirectory, platform)
        io.writeFile(path.join(staging, OWNER_MARKER), `${JSON.stringify(OWNER)}\n`, { flag: 'wx' })
        const ownedStaging = verifyStaging(staging, io, runtimeDirectory, platform)
        if (!hasExactOwner(staging, ownedStaging.rootCanonical, io, platform)) {
          throw runtimeError('DSH_RUNTIME_INVALID')
        }
        try {
          io.lstat(current)
          io.rename(current, backup)
          backedUp = true
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        try {
          io.rename(staging, current)
          promoted = true
        } catch {
          if (backedUp) {
            try {
              io.rename(backup, current)
              backedUp = false
            } catch {
              throw runtimeError('DSH_RUNTIME_ROLLBACK_FAILED')
            }
          }
          throw runtimeError('DSH_RUNTIME_INSTALL_FAILED')
        }
        try {
          assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
          const verifiedCurrent = verifyStaging(current, io, runtimeDirectory, platform)
          if (!hasExactOwner(current, verifiedCurrent.rootCanonical, io, platform)) {
            throw runtimeError('DSH_RUNTIME_INVALID')
          }
        } catch {
          try {
            assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
            io.rename(current, staging)
            promoted = false
            if (backedUp) {
              io.rename(backup, current)
              backedUp = false
            }
            io.remove(staging, { recursive: true, force: true })
          } catch {
            throw runtimeError('DSH_RUNTIME_ROLLBACK_FAILED')
          }
          throw runtimeError('DSH_RUNTIME_INSTALL_FAILED')
        }
        if (backedUp) {
          try {
            assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
            const backupCanonical = verifyTreeRoot(backup, io, runtimeDirectory, platform)
            if (!hasExactOwner(backup, backupCanonical, io, platform)) {
              throw runtimeError('DSH_RUNTIME_BACKUP_CLEANUP_FAILED')
            }
            io.remove(backup, { recursive: true, force: true })
          } catch {
            lastErrorCode = 'DSH_RUNTIME_BACKUP_CLEANUP_FAILED'
            pendingBackupCleanup = backup
            refreshManaged()
            await refreshSystem()
            return publicState(false)
          }
        }
        lastErrorCode = null
        refreshManaged()
        await refreshSystem()
        return publicState(false)
      } catch (error) {
        if (staging && !promoted && error?.code !== 'DSH_RUNTIME_ROLLBACK_FAILED') {
          try {
            assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
            verifyTreeRoot(staging, io, runtimeDirectory, platform)
            io.remove(staging, { recursive: true, force: true })
          } catch {}
        }
        return fail(error?.code === 'DSH_RUNTIME_ROLLBACK_FAILED'
          ? 'DSH_RUNTIME_ROLLBACK_FAILED'
          : 'DSH_RUNTIME_INSTALL_FAILED', false)
      }
    })()
    const pending = work.then(completeMutation)
    operation = pending
    pending.finally(() => { if (operation === pending) operation = null })
    return pending
  }

  const removeRuntime = (...args) => {
    if (operation) return operation
    const work = (async () => {
      await initialized
      refreshManaged()
      try {
        assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
      } catch (error) {
        return fail(error?.code || 'DSH_RUNTIME_PATH_UNSAFE', false)
      }
      if (args.length !== 0 || !managed.installed) {
        return fail('DSH_RUNTIME_ACTION_INVALID', false)
      }
      if (pendingBackupCleanup) {
        return fail('DSH_RUNTIME_BACKUP_CLEANUP_FAILED', false)
      }
      try {
        if (await assertQuiescent() !== true) return fail('DSH_RUNTIME_BUSY', false)
      } catch {
        return fail('DSH_RUNTIME_BUSY', false)
      }
      try {
        assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
      } catch (error) {
        return fail(error?.code || 'DSH_RUNTIME_PATH_UNSAFE', false)
      }
      try {
        const currentStat = io.lstat(current)
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          throw runtimeError('DSH_RUNTIME_REMOVE_REJECTED')
        }
        const rootRealpath = io.realpath(runtimeDirectory)
        const currentRealpath = io.realpath(current)
        const normalize = value => platform === 'win32' ? value.toLowerCase() : value
        if (
          normalize(path.dirname(currentRealpath)) !== normalize(rootRealpath) ||
          path.basename(currentRealpath).toLowerCase() !== 'current'
        ) throw runtimeError('DSH_RUNTIME_REMOVE_REJECTED')
        const verified = verifyStaging(current, io, runtimeDirectory, platform)
        if (!hasExactOwner(current, verified.rootCanonical, io, platform)) throw runtimeError('DSH_RUNTIME_REMOVE_REJECTED')
      } catch (error) {
        return fail(error?.code === 'DSH_RUNTIME_REMOVE_REJECTED'
          ? error.code
          : 'DSH_RUNTIME_REMOVE_REJECTED', false)
      }
      try {
        const transactionId = id()
        if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
          throw runtimeError('DSH_RUNTIME_REMOVE_FAILED')
        }
        const removed = path.join(runtimeDirectory, `.removed-${transactionId}`)
        io.rename(current, removed)
        try {
          assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
          const removedCanonical = verifyTreeRoot(removed, io, runtimeDirectory, platform)
          if (!hasExactOwner(removed, removedCanonical, io, platform)) {
            throw runtimeError('DSH_RUNTIME_REMOVE_FAILED')
          }
          io.remove(removed, { recursive: true, force: true })
        } catch {
          try { io.rename(removed, current) } catch {}
          throw runtimeError('DSH_RUNTIME_REMOVE_FAILED')
        }
        lastErrorCode = null
        refreshManaged()
        await refreshSystem()
        return publicState(false)
      } catch (error) {
        return fail(error?.code === 'DSH_RUNTIME_REMOVE_FAILED'
          ? error.code
          : 'DSH_RUNTIME_REMOVE_FAILED', false)
      }
    })()
    const pending = work.then(completeMutation)
    operation = pending
    pending.finally(() => { if (operation === pending) operation = null })
    return pending
  }

  const retryPendingBackup = () => {
    if (!pendingBackupCleanup || operation || !managedOwned || managed.health !== 'healthy') return false
    try {
      assertSafeRuntimePlacement(runtimeDirectory, dshHome, io)
      const rootCanonical = verifyTreeRoot(pendingBackupCleanup, io, runtimeDirectory, platform)
      if (!hasExactOwner(pendingBackupCleanup, rootCanonical, io, platform)) {
        throw runtimeError('DSH_RUNTIME_BACKUP_CLEANUP_FAILED')
      }
      io.remove(pendingBackupCleanup, { recursive: true, force: true })
      pendingBackupCleanup = null
      lastErrorCode = null
      revision += 1
      return true
    } catch {
      lastErrorCode = 'DSH_RUNTIME_BACKUP_CLEANUP_FAILED'
      return false
    }
  }

  return Object.freeze({
    async getState() {
      await initialized
      refreshManaged()
      retryPendingBackup()
      await refreshSystem()
      return publicState()
    },
    install: () => transact('install'),
    upgrade: () => transact('upgrade'),
    repair: () => transact('repair'),
    remove: (...args) => removeRuntime(...args),
    async selectLaunch() {
      await initialized
      refreshManaged()
      await refreshSystem()
      return managedLaunch || systemLaunch
    }
  })
}
