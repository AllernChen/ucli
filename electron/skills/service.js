import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { buildSkillVisibility, planSkillProjections, resolveSkillRoot, SKILL_ADAPTERS } from './adapters.js'
import { sanitiseGitHubSource, sanitiseSkillError } from './contracts.js'
import { createSkillDiscovery } from './discovery.js'
import { copySkillDirectoryAtomic, diffSkillDirectories, inspectSkillDirectory, removeManagedSkillDirectory } from './fileOps.js'

function serviceError(message, code) {
  return Object.assign(new Error(message), { code })
}

function normalizedPath(path) {
  const value = resolve(String(path || '.'))
  return process.platform === 'win32' ? value.toLowerCase() : value
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

  const userSourceProjects = () => new Map([
    ...readSkillSourceProjects(skillHome),
    ...readUcliSourceProjects(join(skillsRoot, 'source-projects.json'))
  ])

  const packageDirectory = (packageId) => join(packagesRoot, packageId, 'current')

  async function persistOrThrow() {
    try {
      const result = await flush()
      if (result === false) throw new Error('flush failed')
    } catch {
      throw serviceError('Skill changes are pending persistence', 'SKILL_PERSISTENCE_PENDING')
    }
  }

  function inspectInstallation(item) {
    if (!item.enabled) return { ...item, status: 'disabled', visibility: buildSkillVisibility([]) }
    if (!existsSync(item.targetPath)) return { ...item, status: 'missing', visibility: buildSkillVisibility([]) }
    try {
      const inspection = inspectSkillDirectory(item.targetPath)
      const status = inspection.contentSha256 === item.deployedSha256
        ? (item.status === 'update_available' ? 'update_available' : 'ready')
        : 'drifted'
      return { ...item, status, visibility: buildSkillVisibility([item.targetAdapterId]) }
    } catch {
      return { ...item, status: 'invalid', visibility: buildSkillVisibility([]) }
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
    return {
      ...pkg,
      fileList: canonical?.fileList || [],
      totalBytes: canonical?.totalBytes || 0,
      installations,
      compatibility: Object.fromEntries(Object.keys(SKILL_ADAPTERS).map((adapterId) => [adapterId, {
        compatible: adapterId !== 'opencode' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name),
        reason: adapterId === 'opencode' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name)
          ? 'OpenCode requires a lowercase hyphenated skill name'
          : null
      }])),
      visibility: buildSkillVisibility(visibleProjections)
    }
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
    const projectionIds = planSkillProjections(context.targetAdapterIds)
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

  async function reuseManagedPackage(pkg, targetAdapterIds, matchType) {
    const canonical = inspectSkillDirectory(packageDirectory(pkg.id))
    if (canonical.contentSha256 !== pkg.contentSha256) {
      throw serviceError('Managed package was modified outside UCLI', 'SKILL_DRIFTED')
    }
    let view = packageView(pkg)
    const missingAdapterIds = targetAdapterIds.filter((adapterId) => !view.visibility[adapterId]?.visible)
    const projectionIds = planSkillProjections(missingAdapterIds)
    const appliedAdapterIds = []
    for (const adapterId of projectionIds) {
      const existing = view.installations.find((item) => item.targetAdapterId === adapterId)
      if (existing) {
        if (existing.status !== 'disabled') {
          throw serviceError('Existing managed projection requires attention', 'SKILL_TARGET_EXISTS')
        }
        await setEnabled(existing.id, true)
      } else {
        await applyToAdapter(pkg.id, adapterId)
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
    const projectSourceProjects = projectPath ? readSkillSourceProjects(resolve(projectPath)) : new Map()
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
      return {
        name,
        description: sources[0].description,
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
    const scopeKey = scopeType === 'project' ? normalizedPath(request.projectPath) : '*'
    if (!['user', 'project'].includes(scopeType)) throw serviceError('Skill scope is invalid', 'SKILL_SCOPE_INVALID')
    return { targetAdapterIds, scopeType, scopeKey }
  }

  async function installPrepared(request, prepared, validated) {
      const { targetAdapterIds, scopeType, scopeKey } = validated
      const inspected = inspectSkillDirectory(prepared.workingDirectory)
      if (targetAdapterIds.includes('opencode') && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(inspected.name)) {
        throw serviceError('Skill name is incompatible with OpenCode', 'SKILL_INCOMPATIBLE')
      }
      const packagesInScope = db.listSkillPackages().filter((pkg) => packageInScope(pkg, scopeType, scopeKey))
      const reusable = packagesInScope
        .filter((pkg) => pkg.contentSha256 === inspected.contentSha256)
        .sort((left, right) => Number(samePreparedSource(right, prepared.source)) - Number(samePreparedSource(left, prepared.source)))[0]
      if (reusable) {
        return reuseManagedPackage(
          reusable,
          targetAdapterIds,
          samePreparedSource(reusable, prepared.source) ? 'same_source_and_content' : 'same_content'
        )
      }
      if (packagesInScope.some((pkg) => samePreparedSource(pkg, prepared.source))) {
        throw serviceError('The installed source has changed; preview and update the existing Skill', 'SKILL_SOURCE_CHANGED')
      }
      const projectionIds = planSkillProjections(targetAdapterIds)
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
        const canonicalInspection = copySkillDirectoryAtomic(prepared.workingDirectory, canonical)
        created.push({ path: canonical, sha256: canonicalInspection.contentSha256 })
        const installations = []
        for (const target of targetStates) {
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
        })
        await persistOrThrow()
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
        for (const item of created.reverse()) {
          try { removeManagedSkillDirectory(item.path, item.sha256) } catch { /* preserve drifted data */ }
        }
        throw error
      }
  }

  async function install(request = {}) {
    const validated = validateInstallRequest(request)
    return sourceLoader.withPrepared(request.source, (prepared) => installPrepared(request, prepared, validated))
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

  async function applyToAdapter(packageId, targetAdapterId) {
    const pkg = db.getSkillPackage(packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (!SKILL_ADAPTERS[targetAdapterId]) throw serviceError('Skill adapter is unavailable', 'SKILL_ADAPTER_UNAVAILABLE')
    if (targetAdapterId === 'opencode' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name)) {
      throw serviceError('Skill name is incompatible with OpenCode', 'SKILL_INCOMPATIBLE')
    }

    const installations = db.listSkillInstallations({ packageId })
    if (!installations.length) throw serviceError('Skill package has no installation scope', 'SKILL_SCOPE_INVALID')
    if (installations.some((item) => item.targetAdapterId === targetAdapterId)) {
      throw serviceError('Skill is already applied to this CLI', 'SKILL_TARGET_EXISTS')
    }
    const scopes = new Set(installations.map((item) => `${item.scopeType}:${item.scopeKey}`))
    if (scopes.size !== 1) throw serviceError('Skill package has multiple installation scopes', 'SKILL_SCOPE_AMBIGUOUS')
    const scope = installations[0]
    if (!['user', 'project'].includes(scope.scopeType)) throw serviceError('Skill scope is invalid', 'SKILL_SCOPE_INVALID')

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

    let deployed = canonical
    let created = false
    if (existsSync(targetPath)) {
      const existing = inspectSkillDirectory(targetPath)
      if (existing.contentSha256 !== canonical.contentSha256) {
        throw serviceError('A different skill already exists at the target', 'SKILL_TARGET_CONFLICT')
      }
      deployed = existing
    } else {
      deployed = copySkillDirectoryAtomic(packageDirectory(pkg.id), targetPath)
      created = true
    }

    const timestamp = now()
    const installationId = uuid()
    try {
      await db.transaction(async () => {
        db.insertSkillInstallation({
          id: installationId, packageId, targetAdapterId,
          scopeType: scope.scopeType, scopeKey: scope.scopeKey, targetPath,
          enabled: true, deployedSha256: deployed.contentSha256, status: 'ready',
          createdAt: timestamp, updatedAt: timestamp
        })
      })
      await persistOrThrow()
      return packageView(db.getSkillPackage(packageId))
    } catch (error) {
      try {
        if (db.getSkillInstallation(installationId)) db.deleteSkillInstallation(installationId)
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') await flush()
      } catch { /* keep the original operation error */ }
      if (created) {
        try { removeManagedSkillDirectory(targetPath, deployed.contentSha256) } catch { /* preserve changed data */ }
      }
      throw error
    }
  }

  async function setEnabled(installationId, enabled) {
    const item = db.getSkillInstallation(installationId)
    if (!item) throw serviceError('Skill installation was not found', 'SKILL_INSTALLATION_NOT_FOUND')
    const pkg = db.getSkillPackage(item.packageId)
    if (!pkg) throw serviceError('Skill package was not found', 'SKILL_PACKAGE_NOT_FOUND')
    if (Boolean(enabled) === item.enabled) return inspectInstallation(item)
    if (enabled) {
      const deployed = copySkillDirectoryAtomic(packageDirectory(pkg.id), item.targetPath)
      db.updateSkillInstallation(item.id, {
        enabled: true,
        deployedSha256: deployed.contentSha256,
        status: 'ready',
        updatedAt: now()
      })
    } else {
      removeManagedSkillDirectory(item.targetPath, item.deployedSha256)
      db.updateSkillInstallation(item.id, {
        enabled: false,
        deployedSha256: null,
        status: 'disabled',
        updatedAt: now()
      })
    }
    await persistOrThrow()
    return inspectInstallation(db.getSkillInstallation(item.id))
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
    const remaining = db.listSkillInstallations({ packageId: item.packageId })
    if (!remaining.length) {
      const pkg = db.getSkillPackage(item.packageId)
      if (pkg) {
        removeManagedSkillDirectory(packageDirectory(pkg.id), pkg.contentSha256)
        db.deleteSkillPackage(pkg.id)
        const packageParent = join(packagesRoot, pkg.id)
        if (existsSync(packageParent)) rmSync(packageParent, { recursive: true, force: true })
      }
    }
    await persistOrThrow()
    return true
  }

  async function adopt(request = {}) {
    const path = resolve(String(request.path || ''))
    if (db.listSkillInstallations().some((item) => normalizedPath(item.targetPath) === normalizedPath(path))) {
      throw serviceError('Skill is already managed by UCLI', 'SKILL_ALREADY_MANAGED')
    }
    const inspected = inspectSkillDirectory(path)
    const packageId = uuid()
    const timestamp = now()
    const canonical = copySkillDirectoryAtomic(path, packageDirectory(packageId))
    const scopeKey = request.scopeType === 'project' ? normalizedPath(request.projectPath) : '*'
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
      const visibility = buildSkillVisibility([item.targetAdapterId])
      if (!visibility[session.adapterId]?.visible) return false
      if (item.scopeType === 'user') return true
      return normalizedPath(session.cwd || session.projectPath) === normalizedPath(item.scopeKey)
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
    applyToAdapter,
    setEnabled,
    resolveDrift,
    removeInstallation,
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
        adapters: Object.values(SKILL_ADAPTERS).map(({ id, displayName }) => ({ id, displayName })),
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
