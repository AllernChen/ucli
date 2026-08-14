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
  DSH_BRIDGE_VERSION,
  inspectDshRuntime,
  validateDshProfileName
} from './deepSeekHarnessRuntime.js'

const BRIDGE_PACKAGE = '@ucli/dsh-bridge'
const BRIDGE_PATCH = './cordis.patch.yml'
const PROFILE_METADATA_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml'
])
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024
const MAX_BRIDGE_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_PROFILE_BUNDLES = 256
const MAX_PROFILES = 256
const WINDOWS_CMD_METACHARACTERS = /[&|<>^()%!"]/u
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u

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
    bridgeInstalled: false,
    bridgeCompatible: false,
    bridgeVersion: '',
    errorCode: 'DSH_PROFILE_INVALID'
  }
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

export function createDshProfileManager({
  env = process.env,
  homeDirectory,
  tempDirectory,
  bridgeArtifactPath,
  inspectRuntime = options => inspectDshRuntime(options),
  execute,
  platform = process.platform,
  fileOps = {}
} = {}) {
  if (typeof inspectRuntime !== 'function') throw new TypeError('inspectRuntime is required')
  if (typeof execute !== 'function') throw new TypeError('execute is required')
  if (!path.isAbsolute(String(tempDirectory || ''))) throw new TypeError('absolute tempDirectory is required')
  if (!path.isAbsolute(String(bridgeArtifactPath || ''))) throw new TypeError('absolute bridgeArtifactPath is required')
  const files = { ...nativeFiles, ...fileOps }
  const activeInstalls = new Map()

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
      const bridgeInstalled = Boolean(
        hasDependency &&
        hasBundle &&
        installedManifest?.exactName &&
        installedManifest.exactPatch
      )
      const rawBridgeVersion = installedManifest?.exactName ? installedManifest.version : ''
      const bridgeVersion = rawBridgeVersion.length <= 64 && SAFE_VERSION.test(rawBridgeVersion)
        ? rawBridgeVersion
        : ''
      const bridgeCompatible = Boolean(
        hasDependency &&
        hasBundle &&
        installedManifest?.exactName &&
        installedManifest.exactPatch &&
        bridgeVersion === DSH_BRIDGE_VERSION
      )
      return {
        profileName: identity.name,
        profileReady: true,
        bridgeInstalled,
        bridgeCompatible,
        bridgeVersion,
        errorCode: bridgeCompatible
          ? null
          : bridgeInstalled ? 'DSH_BRIDGE_VERSION_UNSUPPORTED' : 'DSH_BRIDGE_NOT_INSTALLED'
      }
    } catch {
      return invalidProfileStatus(identity.name)
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

  async function validateBridgeArtifact() {
    const artifactStat = await files.lstat(bridgeArtifactPath)
    if (
      !artifactStat.isFile() ||
      artifactStat.isSymbolicLink() ||
      artifactStat.size > MAX_BRIDGE_ARCHIVE_BYTES
    ) throw codedError('DSH_BRIDGE_INSTALL_FAILED')
    if (platform === 'win32' && WINDOWS_CMD_METACHARACTERS.test(bridgeArtifactPath)) {
      throw codedError('DSH_BRIDGE_INSTALL_FAILED')
    }
    return bridgeArtifactPath
  }

  async function performEnable(runtime, identity) {
    const runtimeFailure = runtimeErrorCode(runtime)
    if (runtimeFailure) return failure(runtimeFailure)
    if (!runtime.pnpmAvailable || !runtime.launch || !path.isAbsolute(runtime.launch.file)) {
      return failure('DSH_BRIDGE_INSTALL_FAILED')
    }
    if ((runtime.launch.prefixArgs || []).some(argument => !path.isAbsolute(argument))) {
      return failure('DSH_BRIDGE_INSTALL_FAILED')
    }
    let backupDirectory = null
    try {
      await files.mkdir(tempDirectory, { recursive: true, mode: 0o700 })
      const tempRootStat = await files.lstat(tempDirectory)
      if (!tempRootStat.isDirectory() || tempRootStat.isSymbolicLink()) {
        return failure('DSH_BRIDGE_INSTALL_FAILED')
      }
      const canonicalTempRoot = await files.realpath(tempDirectory)
      backupDirectory = await files.mkdtemp(path.join(tempDirectory, 'ucli-dsh-profile-'))
      if (!hasExactParent(path.resolve(backupDirectory), path.resolve(tempDirectory), platform)) {
        throw codedError('DSH_BRIDGE_INSTALL_FAILED')
      }
      const canonicalBackup = await files.realpath(backupDirectory)
      if (!hasExactParent(canonicalBackup, canonicalTempRoot, platform)) {
        throw codedError('DSH_BRIDGE_INSTALL_FAILED')
      }
      await files.chmod(backupDirectory, 0o700)
    } catch {
      if (backupDirectory) {
        await files.rm(backupDirectory, { recursive: true, force: true }).catch(() => {})
      }
      return failure('DSH_BRIDGE_INSTALL_FAILED')
    }
    let records
    let preserveBackup = false
    try {
      records = await snapshotMetadata(runtime, identity, backupDirectory)
      const stableArtifact = await validateBridgeArtifact()
      await assertIdentity(runtime, identity)
      const processEnvironment = {
        ...env,
        DSH_HOME: runtime.home,
        ...(runtime.launch.prefixArgs?.length ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
      let result
      try {
        result = await execute(
          runtime.launch.file,
          [
            ...(runtime.launch.prefixArgs || []),
            'plugin', '--profile', identity.name, 'add', stableArtifact, '--ignore-scripts'
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
      let installed = null
      if (result?.code === 0) {
        try {
          await assertIdentity(runtime, identity)
          installed = await inspectProfile(identity)
        } catch {}
      }
      if (result?.code === 0 && installed?.bridgeCompatible) {
        return { ok: true, errorCode: null, profile: installed }
      }
      try {
        await restoreMetadata(runtime, identity, records)
      } catch {
        preserveBackup = true
        return failure('DSH_BRIDGE_ROLLBACK_FAILED')
      }
      return failure('DSH_BRIDGE_INSTALL_FAILED')
    } catch {
      if (records) {
        try {
          await restoreMetadata(runtime, identity, records)
        } catch {
          preserveBackup = true
          return failure('DSH_BRIDGE_ROLLBACK_FAILED')
        }
      }
      return failure('DSH_BRIDGE_INSTALL_FAILED')
    } finally {
      if (!preserveBackup) await files.rm(backupDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function enableBridge(profileName) {
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
    const profile = await inspectProfile(identity)
    if (!profile.profileReady) return failure('DSH_PROFILE_NOT_READY')
    const lockKey = normalizeForComparison(identity.canonical, platform)
    const active = activeInstalls.get(lockKey)
    if (active) return active
    const operation = performEnable(runtime, identity).finally(() => {
      if (activeInstalls.get(lockKey) === operation) activeInstalls.delete(lockKey)
    })
    activeInstalls.set(lockKey, operation)
    return operation
  }

  return { listProfiles, enableBridge }
}

export function registerDshProfileIpc({ ipcMain, manager }) {
  if (typeof ipcMain?.handle !== 'function') throw new TypeError('ipcMain is required')
  if (typeof manager?.listProfiles !== 'function' || typeof manager?.enableBridge !== 'function') {
    throw new TypeError('DSH profile manager is required')
  }
  ipcMain.handle('dsh:listProfiles', () => manager.listProfiles())
  ipcMain.handle('dsh:enableBridge', (_event, profileName) => manager.enableBridge(profileName))
}
