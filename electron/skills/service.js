import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  buildSkillVisibility, listSkillPresentationAdapters, planSkillProjections,
  resolveDshAgentsRoot, resolveProjectScopeRoot, resolveSkillRoot, SKILL_ADAPTERS
} from './adapters.js'
import { sanitiseGitHubSource, sanitiseSkillError, validateSkillCompatibility } from './contracts.js'
import { createSkillDiscovery } from './discovery.js'
import { copySkillDirectoryAtomic, diffSkillDirectories, inspectSkillDirectory, removeManagedSkillDirectory } from './fileOps.js'
import { backfillSkillManagementMetadata } from './metadataMigration.js'

function serviceError(message, code) {
  return Object.assign(new Error(message), { code })
}

function normalizedPath(path) {
  const value = resolve(String(path || '.'))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function pathIsWithin(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value))
}

function captureDirectoryIdentity(directory) {
  try {
    const inspected = lstatSync(directory)
    if (!inspected.isDirectory() || inspected.isSymbolicLink()) return null
    return {
      dev: inspected.dev,
      ino: inspected.ino,
      realPath: normalizedPath(realpathSync(directory))
    }
  } catch {
    return null
  }
}

function directoryMatchesIdentity(directory, expected) {
  const current = captureDirectoryIdentity(directory)
  return !!current && !!expected &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.realPath === expected.realPath
}

function sourceForPackage(pkg) {
  if (pkg.sourceType === 'github' || pkg.sourceType === 'gitlab') {
    return {
      type: pkg.sourceType,
      url: pkg.sourceLocator,
      ref: pkg.sourceRef,
      refType: pkg.sourceRefType,
      subdir: pkg.sourceSubdir
    }
  }
  if (pkg.sourceType === 'local' || pkg.sourceType === 'zip') {
    return { type: 'local', path: pkg.sourceLocator }
  }
  return null
}

function sourceRefType(source, prepared) {
  if (prepared.source.type === 'server') return 'fixed'
  if (!['github', 'gitlab'].includes(prepared.source.type)) return prepared.source.type === 'zip' ? 'fixed' : 'local'
  if (['branch', 'tag', 'commit', 'default'].includes(source.refType)) return source.refType
  if (/^[a-f0-9]{40}$/i.test(prepared.source.ref)) return 'commit'
  return prepared.source.ref ? 'branch' : 'default'
}

function samePreparedSource(pkg, source = {}) {
  if (pkg.sourceType !== source.type) return false
  const packageLocator = String(pkg.sourceLocator || '')
  const sourceLocator = String(source.locator || '')
  const locatorMatches = ['local', 'zip'].includes(source.type)
    ? normalizedPath(packageLocator) === normalizedPath(sourceLocator)
    : packageLocator.replace(/\/$/, '').toLowerCase() === sourceLocator.replace(/\/$/, '').toLowerCase()
  return locatorMatches &&
    String(pkg.sourceRef || '') === String(source.ref || '') &&
    String(pkg.sourceSubdir || '') === String(source.subdir || '')
}

function readSkillSourceProjects(root) {
  const projects = new Map()
  try {
    const lock = JSON.parse(readFileSync(join(root, '.agents', '.skill-lock.json'), 'utf8'))
    for (const [skillName, metadata] of Object.entries(lock?.skills || {})) {
      if (metadata?.sourceType !== 'github') continue
      const locator = metadata.sourceUrl || (/^[\w.-]+\/[\w.-]+$/.test(metadata.source || '')
        ? `https://github.com/${metadata.source}.git`
        : '')
      if (!locator) continue
      try {
        const source = sanitiseGitHubSource({ url: locator })
        projects.set(skillName, { type: 'github', locator: source.url })
      } catch { /* ignore malformed or unsafe installer metadata */ }
    }
  } catch { /* lock file is optional */ }
  return projects
}

function readUcliSourceProjects(path) {
  const projects = new Map()
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'))
    for (const [skillName, metadata] of Object.entries(registry?.associations || {})) {
      if (metadata?.sourceType !== 'github' || !metadata.sourceUrl) continue
      try {
        const source = sanitiseGitHubSource({ url: metadata.sourceUrl })
        projects.set(skillName, { type: 'github', locator: source.url })
      } catch { /* ignore malformed or unsafe registry entries */ }
    }
  } catch { /* registry is optional */ }
  return projects
}

export function createSkillsService({
  db,
  userDataPath,
  home,
  env = process.env,
  sourceLoader,
  flush = () => db.flush(),
  listSessions = () => [],
  restartSession = async () => true,
  discoverUCodeSkills = () => [],
  migrationFileOps = {},
  uuid = randomUUID,
  now = Date.now
}) {
  const skillsRoot = join(resolve(userDataPath), 'skills')
  const skillHome = resolve(home || homedir())
  const packagesRoot = join(skillsRoot, 'packages')
  const updateStagingRoot = join(skillsRoot, '.staging')
  let ucodeDiscoveryCache = { key: null, checkedAt: 0, items: [] }
  mkdirSync(packagesRoot, { recursive: true })
  mkdirSync(updateStagingRoot, { recursive: true })
  const packagesRootIdentity = captureDirectoryIdentity(packagesRoot)
  const migrationCopy = migrationFileOps.copy || copySkillDirectoryAtomic
  const migrationRemove = migrationFileOps.remove || removeManagedSkillDirectory
  backfillSkillManagementMetadata({ db, now })

  const projectionOptions = (scopeType, projectPath) => ({
    scopeType, projectPath, home: skillHome, env
  })
  const projectionScopeKey = (adapterId, scopeType, projectPath) => {
    if (scopeType !== 'project') return '*'
    return ['codex', 'deepseek-harness'].includes(adapterId)
      ? normalizedPath(resolveProjectScopeRoot(projectPath))
      : normalizedPath(projectPath)
  }
  const serviceVisibility = (projectionIds, scopeType) => {
    const visibility = buildSkillVisibility(projectionIds, { scopeType })
    if (scopeType === 'user' && projectionIds.includes('codex')) {
      const codexRoot = resolveSkillRoot({ adapterId: 'codex', scopeType: 'user', home: skillHome, env })
      const dshAgentsRoot = resolveDshAgentsRoot({ home: skillHome, env })
      if (normalizedPath(codexRoot) !== normalizedPath(dshAgentsRoot)) {
        const dsh = visibility['deepseek-harness']
        dsh.inheritedFrom = dsh.inheritedFrom.filter((adapterId) => adapterId !== 'codex')
        dsh.visible = dsh.direct || dsh.inheritedFrom.length > 0
      }
    }
    return visibility
  }

  const userSourceProjects = () => new Map([
    ...readSkillSourceProjects(skillHome),
    ...readUcliSourceProjects(join(skillsRoot, 'source-projects.json'))
  ])

  const packageDirectory = (packageId) => join(packagesRoot, packageId, 'current')

  function containedNewPackageDirectory(packageId) {
    if (!directoryMatchesIdentity(packagesRoot, packagesRootIdentity)) return null
    const packageParent = join(packagesRoot, packageId)
    if (!pathIsWithin(packagesRoot, packageParent) || normalizedPath(dirname(packageParent)) !== normalizedPath(packagesRoot)) return null
    const parentIdentity = captureDirectoryIdentity(packageParent)
    if (!parentIdentity || !pathIsWithin(packagesRootIdentity.realPath, parentIdentity.realPath) || parentIdentity.realPath === packagesRootIdentity.realPath) {
      return null
    }
    const current = join(packageParent, 'current')
    const currentIdentity = captureDirectoryIdentity(current)
    if (!currentIdentity || !pathIsWithin(parentIdentity.realPath, currentIdentity.realPath) || currentIdentity.realPath === parentIdentity.realPath) {
      return null
    }
    if (!directoryMatchesIdentity(packagesRoot, packagesRootIdentity) || !directoryMatchesIdentity(packageParent, parentIdentity)) return null
    return current
  }

  function removeContainedNewPackageDirectory(packageId, expectedSha256) {
    const current = containedNewPackageDirectory(packageId)
    return current ? removeManagedSkillDirectory(current, expectedSha256) : false
  }

  function removeEmptyPackageParent(packageId) {
    const packageParent = join(packagesRoot, packageId)
    if (!directoryMatchesIdentity(packagesRoot, packagesRootIdentity)) return false
    if (!pathIsWithin(packagesRoot, packageParent) || normalizedPath(dirname(packageParent)) !== normalizedPath(packagesRoot)) return false
    try {
      const original = lstatSync(packageParent)
      if (!original.isDirectory() || original.isSymbolicLink()) return false
      const canonicalParent = realpathSync(packageParent)
      if (!pathIsWithin(packagesRootIdentity.realPath, canonicalParent) || normalizedPath(canonicalParent) === packagesRootIdentity.realPath) return false
      if (readdirSync(packageParent).length) return false
      const current = lstatSync(packageParent)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) return false
      if (!directoryMatchesIdentity(packagesRoot, packagesRootIdentity)) return false
      rmdirSync(packageParent)
      return true
    } catch {
      return false
    }
  }

  async function persistOrThrow(guard = null) {
    try {
      guard?.()
      const result = await flush()
      if (result === false) throw new Error('flush failed')
      guard?.()
    } catch (error) {
      if (error?.code === 'SERVER_SKILL_STALE' || error?.code === 'SERVER_SKILL_SHUTDOWN') throw error
      throw serviceError('Skill changes are pending persistence', 'SKILL_PERSISTENCE_PENDING')
    }
  }

  function inspectInstallation(item) {
    if (!item.enabled) return { ...item, status: 'disabled', visibility: serviceVisibility([], item.scopeType) }
    if (!existsSync(item.targetPath)) return { ...item, status: 'missing', visibility: serviceVisibility([], item.scopeType) }
    try {
      const inspection = inspectSkillDirectory(item.targetPath)
      const status = inspection.contentSha256 === item.deployedSha256
        ? (['update_available', 'cleanup_pending'].includes(item.status) ? item.status : 'ready')
        : 'drifted'
      return { ...item, status, visibility: serviceVisibility([item.targetAdapterId], item.scopeType) }
    } catch {
      return { ...item, status: 'invalid', visibility: serviceVisibility([], item.scopeType) }
    }
  }

  function packageView(pkg) {
    let canonical = null
    try { canonical = inspectSkillDirectory(packageDirectory(pkg.id)) } catch { /* surfaced by installation state */ }
    const adapterOrder = Object.keys(SKILL_ADAPTERS)
    const installations = db.listSkillInstallations({ packageId: pkg.id })
      .map(inspectInstallation)
      .sort((left, right) => adapterOrder.indexOf(left.targetAdapterId) - adapterOrder.indexOf(right.targetAdapterId))
    const visibleProjections = installations
      .filter((item) => item.enabled && !['missing', 'invalid'].includes(item.status))
      .map((item) => item.targetAdapterId)
    const recoveryInstallation = installations.find((item) =>
      ['codex', 'deepseek-harness'].includes(item.targetAdapterId)
    )
    const migrationRecovery = recoveryInstallation
      ? migrationRecoveryState(pkg, recoveryInstallation)
      : null
    const serverMapping = db.getServerSkillPackage?.(pkg.id) || null
    const serverVersion = serverMapping ? db.getServerSkillVersion?.(serverMapping.versionId) : null
    const server = serverMapping ? {
      ...serverMapping,
      lifecycleStatus: serverVersion?.lifecycleStatus || 'UNAVAILABLE',
      available: Boolean(serverVersion),
      warning: serverVersion?.lifecycleStatus === 'REVOKED' ? 'revoked'
        : serverVersion?.lifecycleStatus === 'DEPRECATED' ? 'deprecated'
          : serverVersion ? null : 'unavailable'
    } : null
    return {
      ...pkg,
      sourceIdentity: db.getSkillSourceIdentity?.(pkg.id) || null,
      cliDesiredStates: db.listSkillCliDesiredStates?.({ packageId: pkg.id }) || [],
      fileList: canonical?.fileList || [],
      totalBytes: canonical?.totalBytes || 0,
      installations,
      migrationRecovery,
      server,
      compatibility: validateSkillCompatibility(pkg.name),
      visibility: serviceVisibility(visibleProjections, installations[0]?.scopeType)
    }
  }

  function sourceIdentityFor(packageId, source, timestamp) {
    if (source?.serverOrigin) {
      const resolvedName = typeof source.organizationName === 'string' && source.organizationName.trim()
        ? source.organizationName.trim()
        : null
      return {
        packageId,
        originKind: 'organization',
        serverOrigin: source.serverOrigin,
        organizationId: source.organizationId,
        organizationName: resolvedName || source.organizationId,
        identityStatus: resolvedName ? 'resolved' : 'name_pending',
        catalogVersionId: source.versionId,
        artifactSha256: source.sha256.toLowerCase(),
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
    return {
      packageId,
      originKind: ['github', 'gitlab'].includes(source?.type) ? source.type : 'local',
      serverOrigin: null,
      organizationId: null,
      organizationName: null,
      identityStatus: 'resolved',
      catalogVersionId: null,
      artifactSha256: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }

  function initialDesiredStates(installations, timestamp) {
    const directTargets = new Set(installations.map((installation) => installation.targetAdapterId))
    const states = new Map()
    for (const installation of installations) {
      states.set(installation.targetAdapterId, {
        packageId: installation.packageId,
        scopeType: installation.scopeType,
        scopeKey: installation.scopeKey,
        adapterId: installation.targetAdapterId,
        desiredState: installation.enabled ? 'enabled' : 'disabled',
        enforcementStatus: 'satisfied',
        reasonCode: null,
        updatedAt: timestamp
      })
      const visibility = serviceVisibility([installation.targetAdapterId], installation.scopeType)
      for (const [adapterId, visibilityState] of Object.entries(visibility)) {
        if (!visibilityState.visible || visibilityState.direct || directTargets.has(adapterId)) continue
        states.set(adapterId, {
          packageId: installation.packageId,
          scopeType: installation.scopeType,
          scopeKey: installation.scopeKey,
          adapterId,
          desiredState: 'inherit',
          enforcementStatus: 'satisfied',
          reasonCode: null,
          updatedAt: timestamp
        })
      }
    }
    return [...states.values()]
  }

  function installedMatches(preview) {
    const priority = {
      same_source_and_content: 0,
      same_content: 1,
      same_source_changed: 2
    }
    return db.listSkillPackages().flatMap((pkg) => {
      const sourceMatches = samePreparedSource(pkg, preview.source)
      const contentMatches = pkg.contentSha256 === preview.contentSha256
      if (!sourceMatches && !contentMatches) return []
      const view = packageView(pkg)
      return [{
        packageId: pkg.id,
        name: pkg.name,
        description: pkg.description,
        matchType: sourceMatches && contentMatches
          ? 'same_source_and_content'
          : contentMatches ? 'same_content' : 'same_source_changed',
        installations: view.installations,
        visibility: view.visibility
      }]
    }).sort((left, right) => priority[left.matchType] - priority[right.matchType])
  }

  function inspectTargetMatches(preview, context = {}) {
    if (!Array.isArray(context.targetAdapterIds) || !context.targetAdapterIds.length) return []
    if (!['user', 'project'].includes(context.scopeType)) return []
    const projectionIds = planSkillProjections(context.targetAdapterIds, projectionOptions(context.scopeType, context.projectPath))
    return projectionIds.flatMap((adapterId) => {
      let targetPath
      try {
        targetPath = join(resolveSkillRoot({
          adapterId,
          scopeType: context.scopeType,
          projectPath: context.projectPath,
          home: skillHome,
          env
        }), preview.name)
      } catch { return [] }
      if (!existsSync(targetPath)) return []
      try {
        const existing = inspectSkillDirectory(targetPath)
        return [{
          adapterId,
          targetPath,
          matchType: existing.contentSha256 === preview.contentSha256 ? 'same_content' : 'conflict'
        }]
      } catch {
        return [{ adapterId, targetPath, matchType: 'invalid' }]
      }
    })
  }

  function packageInScope(pkg, scopeType, scopeKey) {
    return db.listSkillInstallations({ packageId: pkg.id }).some((item) =>
      item.scopeType === scopeType && normalizedPath(item.scopeKey) === normalizedPath(scopeKey)
    )
  }

  async function reuseManagedPackage(pkg, targetAdapterIds, matchType, guard = null) {
    guard?.()
    const canonical = inspectSkillDirectory(packageDirectory(pkg.id))
    if (canonical.contentSha256 !== pkg.contentSha256) {
      throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
    }
    let view = packageView(pkg)
    const missingAdapterIds = targetAdapterIds.filter((adapterId) => !view.visibility[adapterId]?.visible)
    const scope = view.installations[0]
    const projectionIds = planSkillProjections(missingAdapterIds, projectionOptions(scope?.scopeType, scope?.scopeKey))
    const appliedAdapterIds = []
    for (const adapterId of projectionIds) {
      guard?.()
      const existing = view.installations.find((item) => item.targetAdapterId === adapterId)
      if (existing) {
        if (existing.status !== 'disabled') {
          throw serviceError('Existing managed projection requires attention', 'SKILL_TARGET_EXISTS')
        }
        await setEnabled(existing.id, true, { guard })
      } else {
        await applyToAdapter(pkg.id, adapterId, { guard })
      }
      appliedAdapterIds.push(adapterId)
      view = packageView(db.getSkillPackage(pkg.id))
    }
    return {
      ...view,
      installOutcome: {
        kind: appliedAdapterIds.length ? 'applied_existing' : 'already_installed',
        matchType,
        appliedAdapterIds
      }
    }
  }

  const skillDiscovery = createSkillDiscovery({
    home: skillHome,
    env,
    inspectSkillDirectory,
    buildSkillVisibility
  })

  function discover(projectPath) {
    const installations = db.listSkillInstallations()
    const sourceProjects = userSourceProjects()
    const canonicalProject = projectPath ? resolveProjectScopeRoot(projectPath) : null
    const projectSourceProjects = canonicalProject ? readSkillSourceProjects(canonicalProject) : new Map()
    const occurrences = skillDiscovery.discover({
      projectPath,
      managedInstallations: installations,
      sourceProjects,
      projectSourceProjects
    })
    const ucodeKey = projectPath ? normalizedPath(projectPath) : '*'
    if (ucodeDiscoveryCache.key !== ucodeKey || now() - ucodeDiscoveryCache.checkedAt > 30000) {
      ucodeDiscoveryCache = {
        key: ucodeKey,
        checkedAt: now(),
        items: discoverUCodeSkills({ cwd: projectPath || undefined })
      }
    }
    for (const skill of ucodeDiscoveryCache.items) {
      // ucode may report either a skill directory or a SKILL.md file location;
      // normalize to the skill directory for inspection and dedup.
      let skillPath = skill.path || ''
      if (skillPath && existsSync(skillPath)) {
        try { if (!statSync(skillPath).isDirectory()) skillPath = dirname(skillPath) } catch { /* keep as-is */ }
      } else if (skillPath) {
        skillPath = dirname(skillPath)
      }
      const duplicatePath = skillPath && occurrences.some((item) =>
        item.name === skill.name && item.path && normalizedPath(item.path) === normalizedPath(skillPath)
      )
      if (duplicatePath) continue
      let inspected = null
      if (skillPath && existsSync(skillPath)) {
        try { inspected = inspectSkillDirectory(skillPath) } catch { /* keep authoritative metadata */ }
      }
      occurrences.push({
        key: `ucode:${skill.origin}:${skill.name}:${skillPath || ''}`,
        adapterId: 'ucode',
        sourceKind: ['bundled', 'system'].includes(skill.origin) ? 'ucode_builtin' : 'ucode_user',
        scopeType: 'system',
        scopeKey: '*',
        path: skillPath || '',
        entryPath: skillPath || '',
        resolvedPath: skillPath || '',
        link: null,
        health: 'ready',
        name: skill.name,
        description: skill.description,
        contentSha256: inspected?.contentSha256 || null,
        fileList: inspected?.fileList || [],
        origin: skill.origin,
        hidden: skill.hidden === true,
        installationId: null,
        visibility: buildSkillVisibility(['ucode'])
      })
    }
    const groups = new Map()
    for (const occurrence of occurrences) {
      const group = groups.get(occurrence.name) || []
      group.push(occurrence)
      groups.set(occurrence.name, group)
    }
    return [...groups.entries()].map(([name, sources]) => {
      const hashes = new Set(sources.map((source) => source.contentSha256).filter(Boolean))
      const allBroken = sources.every((source) => source.status === 'broken_link')
      const allInvalid = sources.every((source) => source.status === 'invalid')
      const allHashed = sources.every((source) => Boolean(source.contentSha256))
      const effectiveSource = sources.find((source) => source.effective) || sources[0]
      return {
        name,
        description: effectiveSource.description,
        status: allBroken
          ? 'broken_link'
          : allInvalid ? 'invalid'
          : hashes.size > 1 ? 'conflict' : sources.length > 1 && allHashed ? 'mirror' : 'ready',
        sources
      }
    }).sort((left, right) => left.name.localeCompare(right.name))
  }

  function validateInstallRequest(request = {}) {
    const targetAdapterIds = [...new Set(request.targetAdapterIds || [])]
    if (!targetAdapterIds.length || targetAdapterIds.some((id) => !SKILL_ADAPTERS[id])) {
      throw serviceError('At least one valid CLI target is required', 'SKILL_TARGET_INVALID')
    }
    const scopeType = request.scopeType
    if (!['user', 'project'].includes(scopeType)) throw serviceError('Skill scope is invalid', 'SKILL_SCOPE_INVALID')
    const projectionIds = planSkillProjections(targetAdapterIds, projectionOptions(scopeType, request.projectPath))
    const scopeKeys = new Set(projectionIds.map((adapterId) =>
      projectionScopeKey(adapterId, scopeType, request.projectPath)
    ))
    if (scopeKeys.size !== 1) {
      throw serviceError('Selected CLIs use different project scope roots', 'SKILL_SCOPE_AMBIGUOUS')
    }
    return { targetAdapterIds, projectionIds, scopeType, scopeKey: [...scopeKeys][0] }
  }

  async function installPrepared(request, prepared, validated, serverMapping = null, guard = null) {
      guard?.()
      const { targetAdapterIds, projectionIds, scopeType, scopeKey } = validated
      const inspected = inspectSkillDirectory(prepared.workingDirectory)
      const compatibility = validateSkillCompatibility(inspected.name)
      if (targetAdapterIds.some((adapterId) => compatibility[adapterId]?.compatible === false)) {
        throw serviceError('Skill name is incompatible with a selected CLI', 'SKILL_INCOMPATIBLE')
      }
      const packagesInScope = db.listSkillPackages().filter((pkg) => packageInScope(pkg, scopeType, scopeKey))
      const reusable = packagesInScope
        .filter(pkg => !serverMapping || pkg.sourceType === 'server')
        .filter((pkg) => pkg.contentSha256 === inspected.contentSha256)
        .sort((left, right) => Number(samePreparedSource(right, prepared.source)) - Number(samePreparedSource(left, prepared.source)))[0]
      if (reusable) {
        const result = await reuseManagedPackage(
          reusable,
          targetAdapterIds,
          samePreparedSource(reusable, prepared.source) ? 'same_source_and_content' : 'same_content',
          guard
        )
        if (serverMapping) {
          const timestamp = now()
          await db.transaction(() => {
            guard?.()
            db.linkServerSkillPackage({ ...serverMapping, packageId: reusable.id })
            db.upsertSkillSourceIdentity(sourceIdentityFor(reusable.id, serverMapping, timestamp))
            guard?.()
          })
          await persistOrThrow(guard)
        }
        return result
      }
      if (packagesInScope.some((pkg) => samePreparedSource(pkg, prepared.source))) {
        throw serviceError('The installed source has changed; preview and update the existing Skill', 'SKILL_SOURCE_CHANGED')
      }
      const targets = projectionIds.map((targetAdapterId) => ({
        targetAdapterId,
        targetPath: join(resolveSkillRoot({
          adapterId: targetAdapterId,
          scopeType,
          projectPath: request.projectPath,
          home: skillHome,
          env
        }), inspected.name)
      }))
      const managedPaths = new Set(db.listSkillInstallations().map((item) => normalizedPath(item.targetPath)))
      const targetStates = targets.map((target) => {
        if (!existsSync(target.targetPath)) return { ...target, existing: null }
        if (managedPaths.has(normalizedPath(target.targetPath))) {
          throw serviceError('A skill target is already managed', 'SKILL_TARGET_CONFLICT')
        }
        let existing
        try { existing = inspectSkillDirectory(target.targetPath) } catch {
          throw serviceError('An invalid skill already exists at the target', 'SKILL_TARGET_CONFLICT')
        }
        if (existing.contentSha256 !== inspected.contentSha256) {
          throw serviceError('A different skill already exists at the target', 'SKILL_TARGET_CONFLICT')
        }
        return { ...target, existing }
      })
      const adoptedAdapterIds = targetStates.filter((item) => item.existing).map((item) => item.targetAdapterId)
      const appliedAdapterIds = targetStates.filter((item) => !item.existing).map((item) => item.targetAdapterId)

      const packageId = uuid()
      const canonical = packageDirectory(packageId)
      const created = []
      const timestamp = now()
      try {
        guard?.()
        const canonicalInspection = copySkillDirectoryAtomic(prepared.workingDirectory, canonical)
        created.push({ path: canonical, sha256: canonicalInspection.contentSha256 })
        const installations = []
        for (const target of targetStates) {
          guard?.()
          const deployed = target.existing || copySkillDirectoryAtomic(canonical, target.targetPath)
          if (!target.existing) created.push({ path: target.targetPath, sha256: deployed.contentSha256 })
          installations.push({
            id: uuid(),
            packageId,
            targetAdapterId: target.targetAdapterId,
            scopeType,
            scopeKey,
            targetPath: target.targetPath,
            enabled: true,
            deployedSha256: deployed.contentSha256,
            status: 'ready',
            createdAt: timestamp,
            updatedAt: timestamp
          })
        }
        await db.transaction(async () => {
          guard?.()
          db.insertSkillPackage({
            id: packageId,
            name: inspected.name,
            description: inspected.description,
            sourceType: prepared.source.type,
            sourceLocator: prepared.source.locator,
            sourceRef: prepared.source.ref || '',
            sourceRefType: sourceRefType(request.source || {}, prepared),
            sourceSubdir: prepared.source.subdir || '',
            resolvedRevision: prepared.resolvedRevision || null,
            manifest: inspected.manifest,
            contentSha256: canonicalInspection.contentSha256,
            lastCheckedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          for (const installation of installations) db.insertSkillInstallation(installation)
          if (serverMapping) db.linkServerSkillPackage({ ...serverMapping, packageId })
          db.upsertSkillSourceIdentity(sourceIdentityFor(packageId, serverMapping || prepared.source, timestamp))
          for (const state of initialDesiredStates(installations, timestamp)) db.upsertSkillCliDesiredState(state)
          guard?.()
        })
        await persistOrThrow(guard)
        const view = packageView(db.getSkillPackage(packageId))
        return adoptedAdapterIds.length
          ? {
              ...view,
              installOutcome: {
                kind: 'adopted_existing',
                matchType: 'same_content',
                appliedAdapterIds,
                adoptedAdapterIds
              }
            }
          : view
      } catch (error) {
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
        try {
          await db.transaction(() => {
            for (const installation of db.listSkillInstallations({ packageId })) {
              db.deleteSkillInstallation(installation.id)
            }
            db.deleteSkillPackage(packageId)
          })
          let removedCanonical = false
          for (const item of created.reverse()) {
            try {
              const removed = normalizedPath(item.path) === normalizedPath(canonical)
                ? removeContainedNewPackageDirectory(packageId, item.sha256)
                : removeManagedSkillDirectory(item.path, item.sha256)
              if (normalizedPath(item.path) === normalizedPath(canonical)) removedCanonical = removed
            } catch { /* preserve drifted data */ }
          }
          if (removedCanonical) removeEmptyPackageParent(packageId)
          const result = await flush()
          if (result === false) throw new Error('flush failed')
        } catch {
          throw serviceError('Skill changes are pending persistence', 'SKILL_PERSISTENCE_PENDING')
        }
        throw error
      }
  }

  async function install(request = {}) {
    const validated = validateInstallRequest(request)
    return sourceLoader.withPrepared(request.source, (prepared) => installPrepared(request, prepared, validated))
  }

  function validServerSource(source = {}) {
    const fields = ['locator', 'versionId', 'serverOrigin', 'organizationId', 'slug', 'version', 'sha256']
    if (!source || typeof source !== 'object' || fields.some((key) => typeof source[key] !== 'string' || !source[key])) {
      throw serviceError('Server Skill source is invalid', 'SKILL_SOURCE_INVALID')
    }
    if (!/^[a-f0-9]{64}$/i.test(source.sha256)) throw serviceError('Server Skill source is invalid', 'SKILL_SOURCE_INVALID')
    return source
  }

  // This is deliberately not reachable through Skills IPC. The server catalog
  // adapter is the only caller that can turn a verified staging archive into a
  // persistent `server` package source.
  async function installVerifiedServerArchive({ archivePath, archiveIdentity, source, targets, guard = null }) {
    const serverSource = validServerSource(source)
    const validated = validateInstallRequest(targets)
    const prepare = sourceLoader.withVerifiedArchive
      ? work => sourceLoader.withVerifiedArchive({ path: archivePath, identity: archiveIdentity, sha256: serverSource.sha256, guard }, work)
      : work => sourceLoader.withPrepared({ type: 'local', path: archivePath }, work, { guard })
    return prepare(async (prepared) => {
      guard?.()
      const serverPrepared = {
        ...prepared,
        source: { type: 'server', locator: serverSource.locator, ref: serverSource.versionId, subdir: '' },
        resolvedRevision: serverSource.sha256
      }
      return installPrepared({ ...targets, source: serverPrepared.source }, serverPrepared, validated, serverSource, guard)
    })
  }

  async function updateVerifiedServerArchive({ packageId, archivePath, archiveIdentity, source, targets, guard = null }) {
    const serverSource = validServerSource(source)
    const pkg = db.getSkillPackage(packageId)
    if (!pkg || pkg.sourceType !== 'server') throw serviceError('Server Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    const validated = validateInstallRequest(targets)
    if (!db.listSkillInstallations({ packageId }).some(item => item.scopeType === validated.scopeType &&
      normalizedPath(item.scopeKey) === normalizedPath(validated.scopeKey) && validated.projectionIds.includes(item.targetAdapterId))) {
      throw serviceError('Server Skill package is not installed for these targets', 'SKILL_PACKAGE_NOT_FOUND')
    }
    const prepare = sourceLoader.withVerifiedArchive
      ? work => sourceLoader.withVerifiedArchive({ path: archivePath, identity: archiveIdentity, sha256: serverSource.sha256, guard }, work)
      : work => sourceLoader.withPrepared({ type: 'local', path: archivePath }, work, { guard })
    return prepare(async (prepared) => {
      guard?.()
      const next = inspectSkillDirectory(prepared.workingDirectory)
      if (next.name !== pkg.name) throw serviceError('Updated source changed the skill name', 'SKILL_UPDATE_NAME_CHANGED')
      const current = inspectSkillDirectory(packageDirectory(pkg.id))
      if (current.contentSha256 !== pkg.contentSha256) throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
      const installations = db.listSkillInstallations({ packageId }).map(inspectInstallation)
      if (installations.some((item) => item.enabled && item.status !== 'ready' && item.status !== 'update_available')) {
        throw serviceError('A managed projection has drifted', 'SKILL_DRIFTED')
      }
      if (next.contentSha256 === pkg.contentSha256) {
        const timestamp = now()
        await db.transaction(() => {
          guard?.()
          db.linkServerSkillPackage({ ...serverSource, packageId })
          db.upsertSkillSourceIdentity(sourceIdentityFor(packageId, serverSource, timestamp))
          guard?.()
        })
        await persistOrThrow(guard)
        return packageView(db.getSkillPackage(packageId))
      }
      const backup = join(updateStagingRoot, `${pkg.id}-${uuid()}`)
      copySkillDirectoryAtomic(packageDirectory(pkg.id), backup)
      const updatedTargets = []
      try {
        guard?.()
        const canonical = copySkillDirectoryAtomic(prepared.workingDirectory, packageDirectory(pkg.id), {
          expectedExistingSha256: pkg.contentSha256
        })
        for (const item of installations.filter((entry) => entry.enabled)) {
          guard?.()
          const deployed = copySkillDirectoryAtomic(canonical.root, item.targetPath, {
            expectedExistingSha256: item.deployedSha256
          })
          updatedTargets.push(item)
          db.updateSkillInstallation(item.id, { deployedSha256: deployed.contentSha256, status: 'ready', updatedAt: now() })
        }
        await db.transaction(() => {
          guard?.()
          db.updateSkillPackage(packageId, {
            description: next.description, sourceLocator: serverSource.locator, sourceRef: serverSource.versionId,
            sourceRefType: 'fixed', sourceSubdir: '', resolvedRevision: serverSource.sha256,
            manifest: next.manifest, contentSha256: next.contentSha256, lastCheckedAt: now(), updatedAt: now()
          })
          db.linkServerSkillPackage({ ...serverSource, packageId })
          db.upsertSkillSourceIdentity(sourceIdentityFor(packageId, serverSource, now()))
          guard?.()
        })
        await persistOrThrow(guard)
        return packageView(db.getSkillPackage(packageId))
      } catch (error) {
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
        for (const item of updatedTargets.reverse()) {
          try { copySkillDirectoryAtomic(backup, item.targetPath, { expectedExistingSha256: next.contentSha256 }) } catch {}
        }
        try { copySkillDirectoryAtomic(backup, packageDirectory(pkg.id), { expectedExistingSha256: next.contentSha256 }) } catch {}
        throw error
      } finally {
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      }
    })
  }

  async function installMany(requests = []) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 200) {
      throw serviceError('Skill batch install request is invalid', 'SKILL_SOURCE_INVALID')
    }
    const validated = requests.map((request) => validateInstallRequest(request))
    if (requests.some((request) =>
      typeof request.expectedRevision !== 'string' || !request.expectedRevision.trim() ||
      request.expectedRevision.length > 256 || request.expectedRevision.includes('\0'))) {
      throw serviceError('Skill batch source revision is invalid', 'SKILL_SOURCE_INVALID')
    }
    const batchContexts = new Set(validated.map(({ targetAdapterIds, scopeType, scopeKey }) => JSON.stringify({
      targetAdapterIds: [...targetAdapterIds].sort(),
      scopeType,
      scopeKey: normalizedPath(scopeKey)
    })))
    if (batchContexts.size !== 1) {
      throw serviceError('Skill batch targets and scope must match', 'SKILL_BATCH_CONTEXT_INVALID')
    }
    return sourceLoader.withPreparedMany(requests.map((request) => ({
      ...request.source,
      expectedRevision: request.expectedRevision
    })), async (preparedItems) => {
      const installed = []
      const failed = []
      for (let index = 0; index < requests.length; index += 1) {
        try {
          installed.push({
            request: requests[index],
            result: await installPrepared(requests[index], preparedItems[index], validated[index])
          })
        } catch (error) {
          const safeError = sanitiseSkillError(error)
          if (error?.code === 'SKILL_PERSISTENCE_PENDING') {
            return {
              installed,
              failed,
              aborted: {
                request: requests[index],
                error: { code: safeError.code, message: safeError.message },
                skippedRequests: requests.slice(index + 1)
              }
            }
          }
          failed.push({
            request: requests[index],
            error: { code: safeError.code, message: safeError.message }
          })
        }
      }
      return { installed, failed }
    })
  }

  function dshProjectionPath(pkg, installation) {
    const projectPath = installation.scopeType === 'project' ? installation.scopeKey : undefined
    const dshRoot = resolveSkillRoot({
      adapterId: 'deepseek-harness', scopeType: installation.scopeType,
      projectPath, home: skillHome, env
    })
    return join(dshRoot, pkg.name)
  }

  function migrationRecoveryState(pkg, installation) {
    if (installation.targetAdapterId !== 'codex' || installation.status !== 'cleanup_pending') return null
    const oldTarget = dshProjectionPath(pkg, installation)
    if (!existsSync(oldTarget)) {
      return { status: 'finalize_pending', action: 'retry_apply_codex', targetAdapterId: 'codex' }
    }
    try {
      const old = inspectSkillDirectory(oldTarget)
      if (old.contentSha256 !== pkg.contentSha256) return {
        status: 'cleanup_conflict', action: null, targetAdapterId: 'codex'
      }
    } catch {
      return { status: 'cleanup_conflict', action: null, targetAdapterId: 'codex' }
    }
    return { status: 'cleanup_pending', action: 'retry_apply_codex', targetAdapterId: 'codex' }
  }

  function migrationRecoveryError(message = 'Skill projection rollback failed') {
    const error = serviceError(message, 'SKILL_PROJECTION_ROLLBACK_FAILED')
    error.recoveryAction = 'retry_apply_codex'
    return error
  }

  async function recoverCommittedDshMigration(pkg, installation) {
    if (installation.status !== 'cleanup_pending') return null
    const oldTarget = dshProjectionPath(pkg, installation)
    const current = inspectInstallation(installation)
    if (!current.enabled || !['cleanup_pending', 'ready', 'update_available'].includes(current.status)) {
      throw migrationRecoveryError('Codex projection requires repair before migration cleanup')
    }
    if (existsSync(oldTarget)) {
      try {
        const old = inspectSkillDirectory(oldTarget)
        if (old.contentSha256 !== pkg.contentSha256) {
          throw new Error('old projection content differs')
        }
        migrationRemove(oldTarget, pkg.contentSha256)
      } catch {
        throw migrationRecoveryError('Skill migration cleanup still requires recovery')
      }
    }
    db.updateSkillInstallation(installation.id, { status: 'ready', updatedAt: now() })
    await persistOrThrow()
    return {
      ...packageView(db.getSkillPackage(pkg.id)),
      installOutcome: {
        kind: 'recovered_migration', matchType: 'cleanup_recovered', appliedAdapterIds: []
      }
    }
  }

  async function migrateDshInstallationToCodex({ pkg, installation, targetPath, canonical }) {
    const oldTarget = dshProjectionPath(pkg, installation)
    const current = inspectInstallation(installation)
    if (!current.enabled || !['ready', 'update_available'].includes(current.status)) {
      throw serviceError('DSH projection must be healthy before migration', 'SKILL_DRIFTED')
    }

    let deployed = canonical
    let createdTarget = false
    let recordMigrated = false
    try {
      if (existsSync(targetPath)) {
        const existing = inspectSkillDirectory(targetPath)
        if (existing.contentSha256 !== canonical.contentSha256) {
          throw serviceError('A different skill already exists at the shared target', 'SKILL_TARGET_CONFLICT')
        }
        deployed = existing
      } else {
        deployed = migrationCopy(packageDirectory(pkg.id), targetPath)
        createdTarget = true
      }

      const migrated = {
        ...installation,
        targetAdapterId: 'codex',
        targetPath,
        deployedSha256: deployed.contentSha256,
        status: 'cleanup_pending',
        updatedAt: now()
      }
      await db.transaction(async () => {
        db.deleteSkillInstallation(installation.id)
        db.insertSkillInstallation(migrated)
      })
      recordMigrated = true
      await persistOrThrow()
    } catch (error) {
      const rollbackFailures = []
      if (recordMigrated) {
        try {
          await db.transaction(async () => {
            if (db.getSkillInstallation(installation.id)) db.deleteSkillInstallation(installation.id)
            db.insertSkillInstallation(installation)
          })
          if (error?.code === 'SKILL_PERSISTENCE_PENDING') await flush()
          else await persistOrThrow()
        } catch {
          rollbackFailures.push('database')
        }
      }

      if (!rollbackFailures.length && createdTarget) {
        try { migrationRemove(targetPath, deployed.contentSha256) } catch { rollbackFailures.push('target') }
      }
      const stored = db.getSkillInstallation(installation.id)
      if (!stored || !existsSync(stored.targetPath)) rollbackFailures.push('consistency')
      if (rollbackFailures.length) {
        throw migrationRecoveryError()
      }
      throw error
    }

    try {
      const old = inspectSkillDirectory(oldTarget)
      if (old.contentSha256 !== installation.deployedSha256) throw new Error('old projection content differs')
      migrationRemove(oldTarget, installation.deployedSha256)
    } catch {
      throw migrationRecoveryError('Codex migration committed; retry apply to finish old projection cleanup')
    }
    db.updateSkillInstallation(installation.id, { status: 'ready', updatedAt: now() })
    await persistOrThrow()
    return packageView(db.getSkillPackage(pkg.id))
  }

  async function applyToAdapter(packageId, targetAdapterId, { guard = null } = {}) {
    guard?.()
    const pkg = db.getSkillPackage(packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (!SKILL_ADAPTERS[targetAdapterId]) throw serviceError('Skill adapter is unavailable', 'SKILL_ADAPTER_UNAVAILABLE')
    if (validateSkillCompatibility(pkg.name)[targetAdapterId]?.compatible === false) {
      throw serviceError('Skill name is incompatible with this CLI', 'SKILL_INCOMPATIBLE')
    }

    const installations = db.listSkillInstallations({ packageId })
    if (!installations.length) throw serviceError('Skill package has no installation scope', 'SKILL_SCOPE_INVALID')
    if (targetAdapterId === 'codex') {
      const codexInstallation = installations.find((item) => item.targetAdapterId === 'codex')
      if (codexInstallation) {
        const recovered = await recoverCommittedDshMigration(pkg, codexInstallation)
        if (recovered) return recovered
      }
    }
    if (targetAdapterId === 'deepseek-harness') {
      const currentView = packageView(pkg)
      if (currentView.visibility['deepseek-harness'].visible) {
        return {
          ...currentView,
          installOutcome: {
            kind: 'already_installed', matchType: 'shared_projection', appliedAdapterIds: []
          }
        }
      }
    }
    if (installations.some((item) => item.targetAdapterId === targetAdapterId)) {
      throw serviceError('Skill is already applied to this CLI', 'SKILL_TARGET_EXISTS')
    }
    const scopes = new Set(installations.map((item) => `${item.scopeType}:${item.scopeKey}`))
    if (scopes.size !== 1) throw serviceError('Skill package has multiple installation scopes', 'SKILL_SCOPE_AMBIGUOUS')
    const scope = installations[0]
    if (!['user', 'project'].includes(scope.scopeType)) throw serviceError('Skill scope is invalid', 'SKILL_SCOPE_INVALID')
    const targetScopeKey = projectionScopeKey(
      targetAdapterId,
      scope.scopeType,
      scope.scopeType === 'project' ? scope.scopeKey : undefined
    )
    if (normalizedPath(targetScopeKey) !== normalizedPath(scope.scopeKey)) {
      throw serviceError('Target CLI uses a different project scope root', 'SKILL_SCOPE_AMBIGUOUS')
    }

    const canonical = inspectSkillDirectory(packageDirectory(pkg.id))
    if (canonical.contentSha256 !== pkg.contentSha256) {
      throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
    }
    const targetPath = join(resolveSkillRoot({
      adapterId: targetAdapterId,
      scopeType: scope.scopeType,
      projectPath: scope.scopeType === 'project' ? scope.scopeKey : undefined,
      home: skillHome,
      env
    }), pkg.name)
    const managedTarget = db.listSkillInstallations()
      .find((item) => normalizedPath(item.targetPath) === normalizedPath(targetPath))
    if (managedTarget) throw serviceError('Skill target is already managed', 'SKILL_TARGET_EXISTS')

    const dshInstallation = installations.find((item) => item.targetAdapterId === 'deepseek-harness')
    const sharedCodexDshRoot = planSkillProjections(
      ['codex', 'deepseek-harness'],
      projectionOptions(scope.scopeType, scope.scopeType === 'project' ? scope.scopeKey : undefined)
    ).length === 1
    if (targetAdapterId === 'codex' && dshInstallation && sharedCodexDshRoot) {
      return migrateDshInstallationToCodex({ pkg, installation: dshInstallation, targetPath, canonical })
    }

    let deployed = canonical
    let created = false
    if (existsSync(targetPath)) {
      const existing = inspectSkillDirectory(targetPath)
      if (existing.contentSha256 !== canonical.contentSha256) {
        throw serviceError('A different skill already exists at the target', 'SKILL_TARGET_CONFLICT')
      }
      deployed = existing
    } else {
      guard?.()
      deployed = copySkillDirectoryAtomic(packageDirectory(pkg.id), targetPath)
      created = true
    }

    const timestamp = now()
    const installationId = uuid()
    try {
      await db.transaction(async () => {
        guard?.()
        db.insertSkillInstallation({
          id: installationId, packageId, targetAdapterId,
          scopeType: scope.scopeType, scopeKey: scope.scopeKey, targetPath,
          enabled: true, deployedSha256: deployed.contentSha256, status: 'ready',
          createdAt: timestamp, updatedAt: timestamp
        })
        guard?.()
      })
      await persistOrThrow(guard)
      return packageView(db.getSkillPackage(packageId))
    } catch (error) {
      const requiresDurableCompensation = error?.code === 'SKILL_PERSISTENCE_PENDING' || error?.code === 'SERVER_SKILL_STALE'
      let compensationPending = false
      try {
        if (db.getSkillInstallation(installationId)) db.deleteSkillInstallation(installationId)
        if (requiresDurableCompensation) {
          const result = await flush()
          if (result === false) throw new Error('flush failed')
        }
      } catch {
        if (requiresDurableCompensation) {
          compensationPending = true
        }
      }
      if (created) {
        try { removeManagedSkillDirectory(targetPath, deployed.contentSha256) } catch { /* preserve changed data */ }
      }
      if (compensationPending) throw serviceError('Skill changes are pending persistence', 'SKILL_PERSISTENCE_PENDING')
      throw error
    }
  }

  async function setEnabled(installationId, enabled, { guard = null } = {}) {
    guard?.()
    const item = db.getSkillInstallation(installationId)
    if (!item) throw serviceError('Skill installation was not found', 'SKILL_INSTALLATION_NOT_FOUND')
    const pkg = db.getSkillPackage(item.packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (Boolean(enabled) === item.enabled) return inspectInstallation(item)
    let changed = false
    try {
      if (enabled) {
        guard?.()
        const deployed = copySkillDirectoryAtomic(packageDirectory(pkg.id), item.targetPath)
        changed = true
        db.updateSkillInstallation(item.id, {
          enabled: true, deployedSha256: deployed.contentSha256, status: 'ready', updatedAt: now()
        })
      } else {
        guard?.()
        removeManagedSkillDirectory(item.targetPath, item.deployedSha256)
        changed = true
        db.updateSkillInstallation(item.id, {
          enabled: false, deployedSha256: null, status: 'disabled', updatedAt: now()
        })
      }
      await persistOrThrow(guard)
      return inspectInstallation(db.getSkillInstallation(item.id))
    } catch (error) {
      if (!changed) throw error
      try {
        if (item.enabled) {
          copySkillDirectoryAtomic(packageDirectory(pkg.id), item.targetPath)
        } else if (existsSync(item.targetPath)) {
          const changedItem = db.getSkillInstallation(item.id)
          removeManagedSkillDirectory(item.targetPath, changedItem?.deployedSha256)
        }
        db.updateSkillInstallation(item.id, {
          enabled: item.enabled, deployedSha256: item.deployedSha256, status: item.status, updatedAt: item.updatedAt
        })
        const result = await flush()
        if (result === false) throw new Error('flush failed')
      } catch {
        throw serviceError('Skill changes are pending persistence', 'SKILL_PERSISTENCE_PENDING')
      }
      throw error
    }
  }

  async function resolveDrift(installationId, resolution) {
    const item = db.getSkillInstallation(installationId)
    if (!item) throw serviceError('Skill installation was not found', 'SKILL_INSTALLATION_NOT_FOUND')
    if (!['restore', 'adopt'].includes(resolution)) throw serviceError('Drift resolution is invalid', 'SKILL_DRIFT_RESOLUTION_INVALID')
    const pkg = db.getSkillPackage(item.packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (!existsSync(item.targetPath)) throw serviceError('Drifted projection is missing', 'SKILL_TARGET_MISSING')
    const target = inspectSkillDirectory(item.targetPath)
    if (target.contentSha256 === item.deployedSha256) return resolution === 'restore' ? inspectInstallation(item) : packageView(pkg)

    if (resolution === 'restore') {
      const backup = join(updateStagingRoot, `${pkg.id}-drift-${uuid()}`)
      copySkillDirectoryAtomic(item.targetPath, backup)
      try {
        const deployed = copySkillDirectoryAtomic(packageDirectory(pkg.id), item.targetPath, {
          expectedExistingSha256: target.contentSha256
        })
        await db.transaction(async () => {
          db.updateSkillInstallation(item.id, {
            deployedSha256: deployed.contentSha256,
            status: 'ready',
            updatedAt: now()
          })
        })
        await persistOrThrow()
        return inspectInstallation(db.getSkillInstallation(item.id))
      } catch (error) {
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
        try { copySkillDirectoryAtomic(backup, item.targetPath, { expectedExistingSha256: pkg.contentSha256 }) } catch {}
        throw error
      } finally {
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      }
    }

    const canonical = inspectSkillDirectory(packageDirectory(pkg.id))
    if (canonical.contentSha256 !== pkg.contentSha256) throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
    const installations = db.listSkillInstallations({ packageId: pkg.id }).map(inspectInstallation)
    if (installations.some((entry) => entry.id !== item.id && entry.enabled && !['ready', 'update_available'].includes(entry.status))) {
      throw serviceError('Another managed projection has drifted', 'SKILL_DRIFTED')
    }
    const backup = join(updateStagingRoot, `${pkg.id}-canonical-${uuid()}`)
    copySkillDirectoryAtomic(packageDirectory(pkg.id), backup)
    const updatedTargets = []
    try {
      copySkillDirectoryAtomic(item.targetPath, packageDirectory(pkg.id), { expectedExistingSha256: pkg.contentSha256 })
      for (const entry of installations.filter((candidate) => candidate.id !== item.id && candidate.enabled)) {
        copySkillDirectoryAtomic(item.targetPath, entry.targetPath, { expectedExistingSha256: entry.deployedSha256 })
        updatedTargets.push(entry)
      }
      const timestamp = now()
      await db.transaction(async () => {
        db.updateSkillPackage(pkg.id, {
          description: target.description,
          sourceType: 'adopted',
          sourceLocator: item.targetPath,
          sourceRef: null,
          sourceRefType: 'fixed',
          sourceSubdir: null,
          resolvedRevision: null,
          manifest: target.manifest,
          contentSha256: target.contentSha256,
          lastCheckedAt: timestamp,
          updatedAt: timestamp
        })
        for (const entry of installations) {
          if (!entry.enabled) continue
          db.updateSkillInstallation(entry.id, {
            deployedSha256: target.contentSha256,
            status: 'ready',
            updatedAt: timestamp
          })
        }
      })
      await persistOrThrow()
      return packageView(db.getSkillPackage(pkg.id))
    } catch (error) {
      if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
      for (const entry of updatedTargets.reverse()) {
        try { copySkillDirectoryAtomic(backup, entry.targetPath, { expectedExistingSha256: target.contentSha256 }) } catch {}
      }
      try { copySkillDirectoryAtomic(backup, packageDirectory(pkg.id), { expectedExistingSha256: target.contentSha256 }) } catch {}
      throw error
    } finally {
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
    }
  }

  async function removeInstallation(installationId) {
    const item = db.getSkillInstallation(installationId)
    if (!item) return false
    if (item.enabled && existsSync(item.targetPath)) removeManagedSkillDirectory(item.targetPath, item.deployedSha256)
    db.deleteSkillInstallation(item.id)
    await persistOrThrow()
    return true
  }

  async function removePackage(packageId) {
    const pkg = db.getSkillPackage(packageId)
    if (!pkg) return false
    for (const installation of db.listSkillInstallations({ packageId })) {
      if (installation.enabled && existsSync(installation.targetPath)) {
        removeManagedSkillDirectory(installation.targetPath, installation.deployedSha256)
      }
      db.deleteSkillInstallation(installation.id)
    }
    removeManagedSkillDirectory(packageDirectory(pkg.id), pkg.contentSha256)
    db.deleteSkillPackage(pkg.id)
    removeEmptyPackageParent(pkg.id)
    await persistOrThrow()
    return true
  }

  async function adopt(request = {}) {
    const path = resolve(String(request.path || ''))
    const bundledRoot = typeof env.DSH_BUNDLED_SKILL_DIR === 'string' && isAbsolute(env.DSH_BUNDLED_SKILL_DIR)
      ? resolve(env.DSH_BUNDLED_SKILL_DIR)
      : null
    if (bundledRoot && (pathIsWithin(bundledRoot, path) || (
      existsSync(bundledRoot) && existsSync(path) &&
      pathIsWithin(realpathSync(bundledRoot), realpathSync(path))
    ))) {
      throw serviceError('Bundled DSH Skills are read-only', 'SKILL_SOURCE_READ_ONLY')
    }
    try {
      if (statSync(path).isFile() && path.toLowerCase().endsWith('.md')) {
        throw serviceError('Flat DSH Skills are read-only', 'SKILL_FLAT_READ_ONLY')
      }
    } catch (error) {
      if (error?.code === 'SKILL_FLAT_READ_ONLY') throw error
    }
    if (db.listSkillInstallations().some((item) => normalizedPath(item.targetPath) === normalizedPath(path))) {
      throw serviceError('Skill is already managed by UCLI', 'SKILL_ALREADY_MANAGED')
    }
    const inspected = inspectSkillDirectory(path)
    const packageId = uuid()
    const timestamp = now()
    const canonical = copySkillDirectoryAtomic(path, packageDirectory(packageId))
    const scopeKey = projectionScopeKey(request.targetAdapterId, request.scopeType, request.projectPath)
    const scopeFilter = request.scopeType === 'project'
      ? { scopeType: 'project', scopeKey }
      : { scopeType: 'user', scopeKey: '*' }

    // Same-named external skill folders (mirror deployments, e.g. both
    // ~/.agents/skills/x and ~/.codex/skills/x) are registered under the same
    // package so adopting one adopts the whole skill instead of duplicating it.
    const siblingPaths = discover(request.projectPath)
      .flatMap((group) => group.sources)
      .filter((source) =>
        source.origin === 'external' &&
        source.name === inspected.name &&
        source.contentSha256 === inspected.contentSha256
      )
      .map((source) => ({ path: resolve(source.path), adapterId: source.adapterId, scopeType: source.scopeType }))
      .filter((item) => item.scopeType === scopeFilter.scopeType)

    const installations = []
    const seen = new Set()
    for (const sibling of [path, ...siblingPaths.map((item) => item.path)]) {
      const target = resolve(sibling)
      const key = normalizedPath(target)
      if (seen.has(key)) continue
      seen.add(key)
      if (db.listSkillInstallations().some((item) => normalizedPath(item.targetPath) === key)) continue
      let contentSha256 = inspected.contentSha256
      try {
        const siblingInspection = inspectSkillDirectory(target)
        contentSha256 = siblingInspection.contentSha256
      } catch { /* keep primary inspection */ }
      const siblingEntry = siblingPaths.find((item) => normalizedPath(item.path) === key)
      installations.push({
        id: uuid(), packageId, targetAdapterId: siblingEntry?.adapterId || request.targetAdapterId,
        scopeType: scopeFilter.scopeType, scopeKey: scopeFilter.scopeKey, targetPath: target, enabled: true,
        deployedSha256: contentSha256, status: 'ready', createdAt: timestamp, updatedAt: timestamp
      })
    }
    try {
      await db.transaction(async () => {
        db.insertSkillPackage({
          id: packageId, name: inspected.name, description: inspected.description,
          sourceType: 'adopted', sourceLocator: path, sourceRef: '', sourceRefType: 'fixed', sourceSubdir: '',
          resolvedRevision: null, manifest: inspected.manifest, contentSha256: canonical.contentSha256,
          lastCheckedAt: timestamp, createdAt: timestamp, updatedAt: timestamp
        })
        for (const installation of installations) db.insertSkillInstallation(installation)
      })
      await persistOrThrow()
      return packageView(db.getSkillPackage(packageId))
    } catch (error) {
      if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
      try { removeManagedSkillDirectory(packageDirectory(packageId), canonical.contentSha256) } catch {}
      throw error
    }
  }

  async function previewUpdate(packageId) {
    const pkg = db.getSkillPackage(packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    const source = sourceForPackage(pkg)
    if (!source) return { packageId, updateable: false, hasChanges: false, reason: 'fixed_source' }
    return sourceLoader.withPrepared(source, async (prepared) => {
      const next = inspectSkillDirectory(prepared.workingDirectory)
      if (next.name !== pkg.name) throw serviceError('Updated source changed the skill name', 'SKILL_UPDATE_NAME_CHANGED')
      const current = inspectSkillDirectory(packageDirectory(pkg.id))
      const diff = diffSkillDirectories(current.root, next.root)
      return {
        packageId,
        updateable: true,
        hasChanges: next.contentSha256 !== pkg.contentSha256,
        fromRevision: pkg.resolvedRevision,
        toRevision: prepared.resolvedRevision || null,
        fromSha256: pkg.contentSha256,
        toSha256: next.contentSha256,
        ...diff
      }
    })
  }

  async function update(packageId, expectedRevision = null) {
    const pkg = db.getSkillPackage(packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (expectedRevision && pkg.resolvedRevision !== expectedRevision) {
      throw serviceError('Skill source revision changed', 'SKILL_UPDATE_STALE')
    }
    const source = sourceForPackage(pkg)
    if (!source) throw serviceError('This skill source cannot be updated', 'SKILL_UPDATE_UNAVAILABLE')
    return sourceLoader.withPrepared(source, async (prepared) => {
      const next = inspectSkillDirectory(prepared.workingDirectory)
      if (next.name !== pkg.name) throw serviceError('Updated source changed the skill name', 'SKILL_UPDATE_NAME_CHANGED')
      const current = inspectSkillDirectory(packageDirectory(pkg.id))
      if (current.contentSha256 !== pkg.contentSha256) throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
      const installations = db.listSkillInstallations({ packageId }).map(inspectInstallation)
      if (installations.some((item) => item.enabled && item.status !== 'ready' && item.status !== 'update_available')) {
        throw serviceError('A managed projection has drifted', 'SKILL_DRIFTED')
      }
      if (next.contentSha256 === pkg.contentSha256) return packageView(pkg)

      const backup = join(updateStagingRoot, `${pkg.id}-${uuid()}`)
      copySkillDirectoryAtomic(packageDirectory(pkg.id), backup)
      const updatedTargets = []
      try {
        const canonical = copySkillDirectoryAtomic(prepared.workingDirectory, packageDirectory(pkg.id), {
          expectedExistingSha256: pkg.contentSha256
        })
        for (const item of installations.filter((entry) => entry.enabled)) {
          const deployed = copySkillDirectoryAtomic(canonical.root, item.targetPath, {
            expectedExistingSha256: item.deployedSha256
          })
          updatedTargets.push(item)
          db.updateSkillInstallation(item.id, {
            deployedSha256: deployed.contentSha256,
            status: 'ready',
            updatedAt: now()
          })
        }
        db.updateSkillPackage(packageId, {
          description: next.description,
          manifest: next.manifest,
          resolvedRevision: prepared.resolvedRevision || null,
          contentSha256: next.contentSha256,
          lastCheckedAt: now(),
          updatedAt: now()
        })
        await persistOrThrow()
        return packageView(db.getSkillPackage(packageId))
      } catch (error) {
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
        for (const item of updatedTargets.reverse()) {
          try { copySkillDirectoryAtomic(backup, item.targetPath, { expectedExistingSha256: next.contentSha256 }) } catch {}
        }
        try { copySkillDirectoryAtomic(backup, packageDirectory(pkg.id), { expectedExistingSha256: next.contentSha256 }) } catch {}
        throw error
      } finally {
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      }
    })
  }

  async function checkUpdates(packageIds = null) {
    const selected = db.listSkillPackages().filter((pkg) => !packageIds || packageIds.includes(pkg.id))
    const results = []
    for (const pkg of selected) {
      if (pkg.sourceRefType === 'tag' || pkg.sourceRefType === 'commit' || pkg.sourceType === 'adopted') {
        results.push({ packageId: pkg.id, checked: false, reason: 'fixed_source' })
        continue
      }
      try {
        const preview = await previewUpdate(pkg.id)
        db.updateSkillPackage(pkg.id, { lastCheckedAt: now() })
        for (const item of db.listSkillInstallations({ packageId: pkg.id })) {
          if (!item.enabled || item.status === 'drifted') continue
          db.updateSkillInstallation(item.id, {
            status: preview.hasChanges ? 'update_available' : 'ready',
            updatedAt: now()
          })
        }
        results.push({ packageId: pkg.id, checked: true, updateAvailable: preview.hasChanges })
      } catch (error) {
        results.push({ packageId: pkg.id, checked: false, errorCode: error.code || 'SKILL_UPDATE_CHECK_FAILED' })
      }
    }
    await persistOrThrow()
    return results
  }

  function getAffectedSessions(installationIds = []) {
    const selected = installationIds.map((id) => db.getSkillInstallation(id)).filter(Boolean)
    return listSessions().filter((session) => selected.some((item) => {
      const visibility = serviceVisibility([item.targetAdapterId], item.scopeType)
      if (!visibility[session.adapterId]?.visible) return false
      if (item.scopeType === 'user') return true
      const sessionProject = session.cwd || session.projectPath
      if (!sessionProject) return false
      return projectionScopeKey(item.targetAdapterId, 'project', sessionProject) === normalizedPath(item.scopeKey)
    }))
  }

  return {
    inspectSource: async (source, context = {}) => {
      const preview = await sourceLoader.inspect(source)
      if (preview.kind === 'collection') {
        return {
          ...preview,
          skills: preview.skills.map((skill) => ({
            ...skill,
            installedMatches: installedMatches(skill),
            targetMatches: inspectTargetMatches(skill, context)
          }))
        }
      }
      return {
        ...preview,
        installedMatches: installedMatches(preview),
        targetMatches: inspectTargetMatches(preview, context)
      }
    },
    install,
    installMany,
    installVerifiedServerArchive,
    updateVerifiedServerArchive,
    applyToAdapter,
    setEnabled,
    resolveDrift,
    removeInstallation,
    removePackage,
    adopt,
    previewUpdate,
    update,
    checkUpdates,
    getAffectedSessions,
    async restartSessions(sessionIds = []) {
      const results = []
      for (const sessionId of [...new Set(sessionIds)]) {
        try { results.push({ sessionId, restarted: await restartSession(sessionId) !== false }) } catch {
          results.push({ sessionId, restarted: false })
        }
      }
      return results
    },
    async getState({ projectPath } = {}) {
      const sourceProjects = userSourceProjects()
      const packages = db.listSkillPackages().map((pkg) => {
        const view = packageView(pkg)
        const sourceProject = sourceProjects.get(view.name)
        return sourceProject ? { ...view, sourceProject } : view
      })
      const discovered = discover(projectPath)
      const conflicts = discovered.filter((item) => item.status === 'conflict').length
      return {
        adapters: listSkillPresentationAdapters(),
        dshRoots: {
          custom: 'unsupported',
          bundled: typeof env.DSH_BUNDLED_SKILL_DIR === 'string' && isAbsolute(env.DSH_BUNDLED_SKILL_DIR)
            ? 'configured'
            : 'unconfigured'
        },
        projects: db.listProjects(),
        packages,
        discovered,
        lastCheckedAt: Math.max(0, ...packages.map((pkg) => pkg.lastCheckedAt || 0)) || null,
        summary: {
          managedPackages: packages.length,
          activeInstallations: packages.flatMap((pkg) => pkg.installations)
            .filter((item) => item.enabled && ['ready', 'update_available'].includes(item.status)).length,
          updates: packages.flatMap((pkg) => pkg.installations)
            .filter((item) => item.status === 'update_available').length,
          conflicts
        }
      }
    }
  }
}
