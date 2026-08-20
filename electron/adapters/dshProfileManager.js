import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import {
  inspectDshRuntime,
  validateDshProfileName
} from './deepSeekHarnessRuntime.js'

const BRIDGE_PACKAGE = '@ucli/dsh-bridge'
const BRIDGE_PATCH = './cordis.patch.yml'
const OFFICIAL_WEB_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
])
const OFFICIAL_HEADLESS_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-headless'
])
const PROFILE_METADATA_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml'
])
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024
const MAX_PROFILE_BUNDLES = 256
const MAX_PROFILES = 256
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u
const TRANSACTION_DIRECTORY = /^ucli-dsh-profile-[0-9A-Za-z_-]{6,64}$/u
const TRANSACTION_OWNER_FILE = '.ucli-dsh-profile-owner.json'
const TRANSACTION_OWNER_NAME = 'ucli-dsh-profile-transaction'

const nativeFiles = {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function normalizeForComparison(value, platform) {
  const normalized = path.normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function hasExactParent(child, parent, platform) {
  return normalizeForComparison(path.dirname(child), platform) === normalizeForComparison(parent, platform)
}

function isContained(child, parent, platform) {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  if (platform === 'win32' && path.parse(relative).root) return false
  return true
}

async function readBoundedRegularFile(file, files, { optional = false, maximum = MAX_METADATA_BYTES } = {}) {
  let stat
  try {
    stat = await files.lstat(file)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw codedError('DSH_PROFILE_INVALID')
  }
  const bytes = await files.readFile(file)
  if (bytes.length > maximum) throw codedError('DSH_PROFILE_INVALID')
  return { bytes, mode: stat.mode & 0o777 }
}

function parseJsonObject(bytes) {
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw codedError('DSH_PROFILE_INVALID')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codedError('DSH_PROFILE_INVALID')
  }
  return parsed
}

function validBundleList(value) {
  return Array.isArray(value) &&
    value.length <= MAX_PROFILE_BUNDLES &&
    value.every(bundle => (
      typeof bundle === 'string' &&
      bundle.length > 0 &&
      bundle.length <= 214 &&
      PACKAGE_NAME.test(bundle) &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(bundle)
    ))
}

function invalidProfileStatus(profileName) {
  return {
    profileName,
    profileReady: false,
    surface: 'custom',
    interactive: false,
    legacyBridgeInstalled: false,
    legacyBridgeVersion: '',
    errorCode: 'DSH_PROFILE_INVALID'
  }
}

function isExactTuple(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function sanitizeRuntime(runtime) {
  const rawVersion = typeof runtime?.version === 'string' ? runtime.version : ''
  const version = rawVersion.length <= 64 && SAFE_VERSION.test(rawVersion) ? rawVersion : ''
  return {
    installed: runtime?.installed === true,
    compatible: runtime?.compatible === true,
    version,
    reason: ['not-installed', 'version-unreadable', 'unsupported-version', ''].includes(runtime?.reason)
      ? runtime.reason
      : 'version-unreadable',
    pnpmAvailable: runtime?.pnpmAvailable === true
  }
}

function runtimeErrorCode(runtime) {
  if (!runtime?.installed) return 'DSH_NOT_INSTALLED'
  if (runtime.reason === 'version-unreadable') return 'DSH_VERSION_UNREADABLE'
  if (!runtime.compatible) return 'DSH_VERSION_UNSUPPORTED'
  return null
}

function failure(errorCode, profile = null) {
  return { ok: false, errorCode, profile }
}

function operationEnvironment(env, runtime) {
  const sanitized = {}
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = key.toUpperCase()
    if (
      normalized.startsWith('UCLI_DSH_BRIDGE_') ||
      normalized === 'DSH_HOME' ||
      normalized === 'ELECTRON_RUN_AS_NODE'
    ) continue
    sanitized[key] = value
  }
  sanitized.DSH_HOME = runtime.home
  if (runtime.launch.prefixArgs?.length) sanitized.ELECTRON_RUN_AS_NODE = '1'
  return sanitized
}

export function createDshProfileManager({
  env = process.env,
  homeDirectory,
  tempDirectory,
  inspectRuntime = options => inspectDshRuntime(options),
  execute,
  platform = process.platform,
  fileOps = {}
} = {}) {
  if (typeof inspectRuntime !== 'function') throw new TypeError('inspectRuntime is required')
  if (typeof execute !== 'function') throw new TypeError('execute is required')
  if (!path.isAbsolute(String(tempDirectory || ''))) throw new TypeError('absolute tempDirectory is required')
  const files = { ...nativeFiles, ...fileOps }
  const activeRemovals = new Map()
  const activeInitializations = new Map()
  const pendingTransactionCleanups = new Map()

  async function runtimeSnapshot() {
    return inspectRuntime({ env, homeDirectory })
  }

  async function resolveProfilesRoot(runtime) {
    const configuredHome = runtime?.home
    if (!path.isAbsolute(String(configuredHome || ''))) throw codedError('DSH_HOME_INVALID')
    const profiles = path.join(configuredHome, 'profiles')
    let rootStat
    try {
      rootStat = await files.lstat(profiles)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw codedError('DSH_PROFILE_INVALID')
    return { declared: profiles, canonical: await files.realpath(profiles) }
  }

  async function enumerateProfileIdentities(runtime) {
    const root = await resolveProfilesRoot(runtime)
    if (!root) return []
    const entries = (await files.readdir(root.declared, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules')
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .slice(0, MAX_PROFILES)
    const identities = []
    for (const entry of entries) {
      try {
        validateDshProfileName(entry.name)
        const declared = path.join(root.declared, entry.name)
        const stat = await files.lstat(declared)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        const canonical = await files.realpath(declared)
        if (!hasExactParent(canonical, root.canonical, platform)) continue
        if (
          normalizeForComparison(path.basename(canonical), platform) !==
          normalizeForComparison(entry.name, platform)
        ) continue
        identities.push({
          name: entry.name,
          declared,
          canonical,
          rootCanonical: root.canonical,
          home: runtime.home,
          device: stat.dev,
          inode: stat.ino
        })
      } catch {}
    }
    return identities
  }

  async function resolveProfileIdentity(runtime, profileName) {
    validateDshProfileName(profileName)
    const matches = (await enumerateProfileIdentities(runtime)).filter(identity => identity.name === profileName)
    if (matches.length !== 1) throw codedError('DSH_PROFILE_INVALID')
    return matches[0]
  }

  async function assertIdentity(runtime, identity) {
    const current = await resolveProfileIdentity(runtime, identity.name)
    if (
      normalizeForComparison(current.canonical, platform) !== normalizeForComparison(identity.canonical, platform) ||
      normalizeForComparison(current.rootCanonical, platform) !== normalizeForComparison(identity.rootCanonical, platform) ||
      current.device !== identity.device ||
      current.inode !== identity.inode
    ) throw codedError('DSH_PROFILE_INVALID')
    return current
  }

  async function inspectInstalledBridge(identity) {
    const declaredRoot = path.join(identity.declared, 'node_modules', '@ucli', 'dsh-bridge')
    let bridgeRoot
    try {
      const rootStat = await files.lstat(declaredRoot)
      if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) return null
      bridgeRoot = await files.realpath(declaredRoot)
      if (!isContained(bridgeRoot, identity.canonical, platform)) return null
    } catch {
      return null
    }
    try {
      const manifestFile = path.join(bridgeRoot, 'package.json')
      const manifestRecord = await readBoundedRegularFile(manifestFile, files)
      const manifest = parseJsonObject(manifestRecord.bytes)
      const declaredPatch = manifest?.dsh?.bundle?.patch
      if (declaredPatch !== BRIDGE_PATCH) return null
      const patchFile = path.resolve(bridgeRoot, declaredPatch)
      if (!isContained(patchFile, bridgeRoot, platform)) return null
      const canonicalPatch = await files.realpath(patchFile)
      if (!isContained(canonicalPatch, bridgeRoot, platform)) return null
      await readBoundedRegularFile(canonicalPatch, files)
      return {
        exactName: manifest.name === BRIDGE_PACKAGE,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        exactPatch: true
      }
    } catch {
      return null
    }
  }

  async function inspectProfile(identity) {
    try {
      const manifestRecord = await readBoundedRegularFile(path.join(identity.declared, 'package.json'), files)
      await readBoundedRegularFile(path.join(identity.declared, 'cordis.patch.yml'), files, { optional: true })
      const manifest = parseJsonObject(manifestRecord.bytes)
      const bundles = manifest?.dsh?.profile?.bundles ?? []
      if (!validBundleList(bundles)) return invalidProfileStatus(identity.name)
      const dependencies = manifest.dependencies
      if (dependencies !== undefined && (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))) {
        return invalidProfileStatus(identity.name)
      }
      const bridgeDependency = dependencies?.[BRIDGE_PACKAGE]
      if (
        bridgeDependency !== undefined &&
        (
          typeof bridgeDependency !== 'string' ||
          bridgeDependency.length === 0 ||
          bridgeDependency.length > 2048 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(bridgeDependency)
        )
      ) return invalidProfileStatus(identity.name)
      const hasDependency = Object.prototype.hasOwnProperty.call(dependencies || {}, BRIDGE_PACKAGE)
      const hasBundle = bundles.filter(bundle => bundle === BRIDGE_PACKAGE).length === 1
      const installedManifest = await inspectInstalledBridge(identity)
      const legacyBridgeInstalled = Boolean(
        hasDependency &&
        hasBundle &&
        installedManifest?.exactName &&
        installedManifest.exactPatch
      )
      const rawBridgeVersion = legacyBridgeInstalled ? installedManifest.version : ''
      const legacyBridgeVersion = rawBridgeVersion.length <= 64 && SAFE_VERSION.test(rawBridgeVersion)
        ? rawBridgeVersion
        : ''
      const surface = legacyBridgeInstalled
        ? 'custom'
        : isExactTuple(bundles, OFFICIAL_WEB_BUNDLES)
          ? 'web'
          : isExactTuple(bundles, OFFICIAL_HEADLESS_BUNDLES)
            ? 'headless'
            : 'custom'
      return {
        profileName: identity.name,
        profileReady: true,
        surface,
        interactive: surface === 'web',
        legacyBridgeInstalled,
        legacyBridgeVersion,
        errorCode: null
      }
    } catch {
      return invalidProfileStatus(identity.name)
    }
  }

  async function legacyBridgeMetadataAbsent(identity) {
    try {
      const record = await readBoundedRegularFile(path.join(identity.declared, 'package.json'), files)
      const manifest = parseJsonObject(record.bytes)
      const bundles = manifest?.dsh?.profile?.bundles ?? []
      const dependencies = manifest.dependencies ?? {}
      if (!validBundleList(bundles) || !dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        return false
      }
      if (
        Object.prototype.hasOwnProperty.call(dependencies, BRIDGE_PACKAGE) ||
        bundles.includes(BRIDGE_PACKAGE)
      ) return false
      try {
        await files.lstat(path.join(identity.declared, 'node_modules', '@ucli', 'dsh-bridge'))
        return false
      } catch (error) {
        return error?.code === 'ENOENT'
      }
    } catch {
      return false
    }
  }

  async function isExactInitializedBaseProfile(identity, status) {
    if (
      !status?.profileReady ||
      status.surface !== 'custom' ||
      status.interactive ||
      status.legacyBridgeInstalled
    ) return false
    try {
      const record = await readBoundedRegularFile(path.join(identity.declared, 'package.json'), files)
      const manifest = parseJsonObject(record.bytes)
      return isExactTuple(manifest?.dsh?.profile?.bundles ?? [], ['@deepseek-ai/dsh-base']) &&
        await legacyBridgeMetadataAbsent(identity)
    } catch {
      return false
    }
  }

  async function listProfiles() {
    let runtime
    try {
      runtime = await runtimeSnapshot()
    } catch {
      return {
        runtime: {
          installed: false,
          compatible: false,
          version: '',
          reason: 'version-unreadable',
          pnpmAvailable: false
        },
        profiles: []
      }
    }
    let profiles = []
    try {
      const identities = await enumerateProfileIdentities(runtime)
      profiles = await Promise.all(identities.map(inspectProfile))
    } catch {}
    return { runtime: sanitizeRuntime(runtime), profiles }
  }

  async function snapshotMetadata(runtime, identity, backupDirectory) {
    await assertIdentity(runtime, identity)
    const records = new Map()
    for (const name of PROFILE_METADATA_FILES) {
      const source = path.join(identity.declared, name)
      const record = await readBoundedRegularFile(source, files, {
        optional: true,
        maximum: name === 'pnpm-lock.yaml' ? MAX_LOCKFILE_BYTES : MAX_METADATA_BYTES
      })
      records.set(name, record)
      if (record) {
        const target = path.join(backupDirectory, name)
        await files.writeFile(target, record.bytes, { mode: record.mode })
      }
    }
    return records
  }

  async function restoreMetadata(runtime, identity, records) {
    await assertIdentity(runtime, identity)
    for (const name of PROFILE_METADATA_FILES) {
      const target = path.join(identity.declared, name)
      const record = records.get(name)
      if (!record) {
        await files.rm(target, { force: true })
        continue
      }
      const temporary = path.join(identity.declared, `.${name}.ucli-restore-${randomUUID()}`)
      try {
        await files.writeFile(temporary, record.bytes, { mode: record.mode })
        await files.chmod(temporary, record.mode)
        await files.rename(temporary, target)
      } finally {
        await files.rm(temporary, { force: true }).catch(() => {})
      }
    }
    await assertIdentity(runtime, identity)
  }

  async function confirmMetadata(identity, records) {
    for (const name of PROFILE_METADATA_FILES) {
      const current = await readBoundedRegularFile(path.join(identity.declared, name), files, {
        optional: true,
        maximum: name === 'pnpm-lock.yaml' ? MAX_LOCKFILE_BYTES : MAX_METADATA_BYTES
      })
      const expected = records.get(name)
      if (Boolean(current) !== Boolean(expected)) return false
      if (current && (!current.bytes.equals(expected.bytes) || current.mode !== expected.mode)) return false
    }
    return true
  }

  async function verifyTransactionOwnership(transaction) {
    try {
      const directory = transaction?.directory
      if (!path.isAbsolute(String(directory || ''))) return false
      if (!TRANSACTION_DIRECTORY.test(path.basename(directory))) return false
      if (!hasExactParent(path.resolve(directory), path.resolve(tempDirectory), platform)) return false
      const tempStat = await files.lstat(tempDirectory)
      const transactionStat = await files.lstat(directory)
      if (
        !tempStat.isDirectory() || tempStat.isSymbolicLink() ||
        !transactionStat.isDirectory() || transactionStat.isSymbolicLink()
      ) return false
      if (transactionStat.dev !== transaction.device || transactionStat.ino !== transaction.inode) return false
      const canonicalTemp = await files.realpath(tempDirectory)
      const canonicalTransaction = await files.realpath(directory)
      if (!hasExactParent(canonicalTransaction, canonicalTemp, platform)) return false
      if (
        normalizeForComparison(canonicalTransaction, platform) !==
        normalizeForComparison(transaction.canonical, platform)
      ) return false
      const marker = await readBoundedRegularFile(path.join(directory, TRANSACTION_OWNER_FILE), files, {
        maximum: 512
      })
      if (!marker.bytes.equals(transaction.markerBytes)) return false
      return true
    } catch {
      return false
    }
  }

  async function cleanupTransactionDirectory(transaction) {
    try {
      if (!await verifyTransactionOwnership(transaction)) return false
      const directory = transaction.directory
      await files.rm(directory, { recursive: true, force: true })
      try {
        await files.lstat(directory)
        return false
      } catch (error) {
        return error?.code === 'ENOENT'
      }
    } catch {
      return false
    }
  }

  async function performRemove(runtime, identity) {
    const runtimeFailure = runtimeErrorCode(runtime)
    if (runtimeFailure) return failure(runtimeFailure)
    if (!runtime.pnpmAvailable || !runtime.launch || !path.isAbsolute(runtime.launch.file)) {
      return failure('DSH_BRIDGE_REMOVE_FAILED')
    }
    if ((runtime.launch.prefixArgs || []).some(argument => !path.isAbsolute(argument))) {
      return failure('DSH_BRIDGE_REMOVE_FAILED')
    }
    let backupDirectory = null
    let transaction = null
    try {
      await files.mkdir(tempDirectory, { recursive: true, mode: 0o700 })
      const tempRootStat = await files.lstat(tempDirectory)
      if (!tempRootStat.isDirectory() || tempRootStat.isSymbolicLink()) {
        return failure('DSH_BRIDGE_REMOVE_FAILED')
      }
      const canonicalTempRoot = await files.realpath(tempDirectory)
      backupDirectory = await files.mkdtemp(path.join(tempDirectory, 'ucli-dsh-profile-'))
      if (!TRANSACTION_DIRECTORY.test(path.basename(backupDirectory))) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
      if (!hasExactParent(path.resolve(backupDirectory), path.resolve(tempDirectory), platform)) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
      const canonicalBackup = await files.realpath(backupDirectory)
      if (!hasExactParent(canonicalBackup, canonicalTempRoot, platform)) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
      const backupStat = await files.lstat(backupDirectory)
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
      if ((await files.readdir(backupDirectory)).length !== 0) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
      await files.chmod(backupDirectory, 0o700)
      const markerBytes = Buffer.from(`${JSON.stringify({
        owner: TRANSACTION_OWNER_NAME,
        nonce: randomUUID()
      })}\n`)
      transaction = {
        directory: backupDirectory,
        canonical: canonicalBackup,
        device: backupStat.dev,
        inode: backupStat.ino,
        markerBytes
      }
      await files.writeFile(path.join(backupDirectory, TRANSACTION_OWNER_FILE), markerBytes, {
        flag: 'wx',
        mode: 0o600
      })
      if (!await verifyTransactionOwnership(transaction)) {
        throw codedError('DSH_BRIDGE_REMOVE_FAILED')
      }
    } catch {
      if (transaction) {
        await cleanupTransactionDirectory(transaction)
      }
      return failure('DSH_BRIDGE_REMOVE_FAILED')
    }
    let records
    let preserveBackup = false
    try {
      records = await snapshotMetadata(runtime, identity, backupDirectory)
      await assertIdentity(runtime, identity)
      const processEnvironment = operationEnvironment(env, runtime)
      let result
      try {
        result = await execute(
          runtime.launch.file,
          [
            ...(runtime.launch.prefixArgs || []),
            'plugin', '--profile', identity.name, 'remove', BRIDGE_PACKAGE, '--config.ignore-scripts=true'
          ],
          {
            env: processEnvironment,
            shell: false,
            windowsHide: true,
            timeoutMs: 10 * 60_000
          }
        )
      } catch {
        result = { code: -1 }
      }
      if (result?.terminationConfirmed === false) {
        preserveBackup = true
        return failure('DSH_BRIDGE_ROLLBACK_FAILED')
      }
      let inspected = null
      if (result?.code === 0) {
        try {
          await assertIdentity(runtime, identity)
          inspected = await inspectProfile(identity)
        } catch {}
      }
      if (
        result?.code === 0 &&
        inspected?.profileReady &&
        !inspected.legacyBridgeInstalled &&
        await legacyBridgeMetadataAbsent(identity)
      ) {
        return { ok: true, errorCode: null, profile: inspected }
      }
      try {
        await restoreMetadata(runtime, identity, records)
        if (!await confirmMetadata(identity, records)) throw codedError('DSH_BRIDGE_ROLLBACK_FAILED')
      } catch {
        preserveBackup = true
        return failure('DSH_BRIDGE_ROLLBACK_FAILED')
      }
      return failure('DSH_BRIDGE_REMOVE_FAILED')
    } catch {
      if (records) {
        try {
          await restoreMetadata(runtime, identity, records)
          if (!await confirmMetadata(identity, records)) throw codedError('DSH_BRIDGE_ROLLBACK_FAILED')
        } catch {
          preserveBackup = true
          return failure('DSH_BRIDGE_ROLLBACK_FAILED')
        }
      }
      return failure('DSH_BRIDGE_REMOVE_FAILED')
    } finally {
      if (!preserveBackup) {
        const lockKey = normalizeForComparison(identity.canonical, platform)
        if (!await cleanupTransactionDirectory(transaction)) {
          pendingTransactionCleanups.set(lockKey, transaction)
          return failure('DSH_BRIDGE_CLEANUP_FAILED')
        }
        pendingTransactionCleanups.delete(lockKey)
      }
    }
  }

  async function removeLegacyBridge(profileName) {
    try {
      validateDshProfileName(profileName)
    } catch {
      return failure('DSH_PROFILE_INVALID')
    }
    let runtime
    try {
      runtime = await runtimeSnapshot()
    } catch {
      return failure('DSH_VERSION_UNREADABLE')
    }
    const runtimeFailure = runtimeErrorCode(runtime)
    if (runtimeFailure) return failure(runtimeFailure)
    let identity
    try {
      identity = await resolveProfileIdentity(runtime, profileName)
    } catch {
      return failure('DSH_PROFILE_INVALID')
    }
    const lockKey = normalizeForComparison(identity.canonical, platform)
    const active = activeRemovals.get(lockKey)
    if (active) return active
    const operation = (async () => {
      const profile = await inspectProfile(identity)
      if (!profile.profileReady) return failure('DSH_PROFILE_NOT_READY')
      const pendingCleanup = pendingTransactionCleanups.get(lockKey)
      if (pendingCleanup) {
        if (!await cleanupTransactionDirectory(pendingCleanup)) {
          return failure('DSH_BRIDGE_CLEANUP_FAILED')
        }
        pendingTransactionCleanups.delete(lockKey)
        if (!profile.legacyBridgeInstalled) return { ok: true, errorCode: null, profile }
      }
      if (!profile.legacyBridgeInstalled) return failure('DSH_BRIDGE_NOT_INSTALLED', profile)
      return performRemove(runtime, identity)
    })().finally(() => {
      if (activeRemovals.get(lockKey) === operation) activeRemovals.delete(lockKey)
    })
    activeRemovals.set(lockKey, operation)
    return operation
  }

  async function rollbackInitializedProfile(runtime, profileName) {
    try {
      const root = await resolveProfilesRoot(runtime)
      if (!root) return true
      const candidate = path.join(root.declared, profileName)
      try {
        await files.lstat(candidate)
      } catch (error) {
        return error?.code === 'ENOENT'
      }
      const identity = await resolveProfileIdentity(runtime, profileName)
      await assertIdentity(runtime, identity)
      await files.rm(identity.declared, { recursive: true, force: true })
      try {
        await files.lstat(identity.declared)
        return false
      } catch (error) {
        return error?.code === 'ENOENT'
      }
    } catch {
      return false
    }
  }

  async function performInitialize(runtime, profileName) {
    if (
      !path.isAbsolute(String(runtime.home || '')) ||
      !runtime.pnpmAvailable ||
      !runtime.launch ||
      !path.isAbsolute(runtime.launch.file)
    ) {
      return failure('DSH_PROFILE_INITIALIZE_FAILED')
    }
    if ((runtime.launch.prefixArgs || []).some(argument => !path.isAbsolute(argument))) {
      return failure('DSH_PROFILE_INITIALIZE_FAILED')
    }
    const profilesRoot = path.join(runtime.home, 'profiles')
    try {
      const rootStat = await files.lstat(profilesRoot)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return failure('DSH_PROFILE_INITIALIZE_FAILED')
      const candidate = path.join(profilesRoot, profileName)
      try {
        await files.lstat(candidate)
        return failure('DSH_PROFILE_ALREADY_EXISTS')
      } catch (error) {
        if (error?.code !== 'ENOENT') return failure('DSH_PROFILE_INITIALIZE_FAILED')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') return failure('DSH_PROFILE_INITIALIZE_FAILED')
    }
    const processEnvironment = operationEnvironment(env, runtime)
    async function failWithContainedRollback() {
      return await rollbackInitializedProfile(runtime, profileName)
        ? failure('DSH_PROFILE_INITIALIZE_FAILED')
        : failure('DSH_PROFILE_INITIALIZE_ROLLBACK_FAILED')
    }
    let result
    try {
      result = await execute(
        runtime.launch.file,
        [
          ...(runtime.launch.prefixArgs || []),
          'plugin', '--profile', profileName, 'install', '--ignore-scripts'
        ],
        {
          env: processEnvironment,
          shell: false,
          windowsHide: true,
          timeoutMs: 10 * 60_000
        }
      )
    } catch {
      return failWithContainedRollback()
    }
    if (result?.terminationConfirmed === false) {
      return failure('DSH_PROFILE_INITIALIZE_ROLLBACK_FAILED')
    }
    if (result?.code !== 0) {
      return failWithContainedRollback()
    }
    try {
      const identity = await resolveProfileIdentity(runtime, profileName)
      const profile = await inspectProfile(identity)
      if (!await isExactInitializedBaseProfile(identity, profile)) {
        return failWithContainedRollback()
      }
      return { ok: true, errorCode: null, profile }
    } catch {
      return failWithContainedRollback()
    }
  }

  async function initializeProfile(profileName) {
    try {
      validateDshProfileName(profileName)
    } catch {
      return failure('DSH_PROFILE_INVALID')
    }
    let runtime
    try {
      runtime = await runtimeSnapshot()
    } catch {
      return failure('DSH_VERSION_UNREADABLE')
    }
    const runtimeFailure = runtimeErrorCode(runtime)
    if (runtimeFailure) return failure(runtimeFailure)
    const lockKey = normalizeForComparison(path.join(runtime.home, 'profiles', profileName), platform)
    const active = activeInitializations.get(lockKey)
    if (active) return active
    const operation = performInitialize(runtime, profileName).finally(() => {
      if (activeInitializations.get(lockKey) === operation) activeInitializations.delete(lockKey)
    })
    activeInitializations.set(lockKey, operation)
    return operation
  }

  return { listProfiles, initializeProfile, removeLegacyBridge }
}

export function registerDshProfileIpc({ ipcMain, profileManager, runtimeManager }) {
  if (typeof ipcMain?.handle !== 'function') throw new TypeError('ipcMain is required')
  if (
    typeof profileManager?.listProfiles !== 'function' ||
    typeof profileManager?.initializeProfile !== 'function' ||
    typeof profileManager?.removeLegacyBridge !== 'function'
  ) {
    throw new TypeError('DSH profile manager is required')
  }
  if (
    typeof runtimeManager?.getState !== 'function' ||
    typeof runtimeManager?.install !== 'function' ||
    typeof runtimeManager?.upgrade !== 'function' ||
    typeof runtimeManager?.repair !== 'function' ||
    typeof runtimeManager?.remove !== 'function'
  ) {
    throw new TypeError('DSH runtime manager is required')
  }
  ipcMain.handle('dsh:getState', () => runtimeManager.getState())
  ipcMain.handle('dsh:listProfiles', () => profileManager.listProfiles())
  ipcMain.handle('dsh:initializeProfile', (_event, profileName) => profileManager.initializeProfile(profileName))
  ipcMain.handle('dsh:installRuntime', () => runtimeManager.install())
  ipcMain.handle('dsh:upgradeRuntime', () => runtimeManager.upgrade())
  ipcMain.handle('dsh:repairRuntime', () => runtimeManager.repair())
  ipcMain.handle('dsh:removeRuntime', () => runtimeManager.remove())
  ipcMain.handle('dsh:removeLegacyBridge', (_event, profileName) => profileManager.removeLegacyBridge(profileName))
}
