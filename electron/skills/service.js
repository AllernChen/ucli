import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { buildSkillVisibility, planSkillProjections, resolveSkillRoot, SKILL_ADAPTERS } from './adapters.js'
import { copySkillDirectoryAtomic, diffSkillDirectories, inspectSkillDirectory, removeManagedSkillDirectory } from './fileOps.js'

function serviceError(message, code) {
  return Object.assign(new Error(message), { code })
}

function normalizedPath(path) {
  const value = resolve(String(path || '.'))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function sourceForPackage(pkg) {
  if (pkg.sourceType === 'github') {
    return {
      type: 'github',
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
  if (prepared.source.type !== 'github') return prepared.source.type === 'zip' ? 'fixed' : 'local'
  if (['branch', 'tag', 'commit', 'default'].includes(source.refType)) return source.refType
  if (/^[a-f0-9]{40}$/i.test(prepared.source.ref)) return 'commit'
  return prepared.source.ref ? 'branch' : 'default'
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
    if (!item.enabled) return { ...item, status: 'disabled' }
    if (!existsSync(item.targetPath)) return { ...item, status: 'missing' }
    try {
      const inspection = inspectSkillDirectory(item.targetPath)
      const status = inspection.contentSha256 === item.deployedSha256
        ? (item.status === 'update_available' ? 'update_available' : 'ready')
        : 'drifted'
      return { ...item, status }
    } catch {
      return { ...item, status: 'invalid' }
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

  /** Resolve whether a directory entry points at a real directory, following
   *  symlinks (Claude Code keeps ~/.claude/skills entries as links into
   *  shared skill stores). Returns false for dangling links. */
  function entryIsDirectory(path) {
    try { return statSync(path).isDirectory() } catch { return false }
  }

  /** Scan a directory of skill folders, following symlinked skill entries. */
  function scanRoot(adapterId, scopeType, scopeKey, root, managedPaths, results, forcedOrigin = null) {
    if (!existsSync(root)) return
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(root, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (!entryIsDirectory(path)) continue
      } else {
        continue
      }
      try {
        const inspected = inspectSkillDirectory(path)
        const installation = managedPaths.get(normalizedPath(path))
        results.push({
          key: `${adapterId}:${scopeType}:${normalizedPath(path)}`,
          adapterId,
          scopeType,
          scopeKey,
          path,
          name: inspected.name,
          description: inspected.description,
          contentSha256: inspected.contentSha256,
          fileList: inspected.fileList,
          origin: forcedOrigin || (installation ? 'managed' : 'external'),
          installationId: installation?.id || null,
          visibility: buildSkillVisibility([adapterId])
        })
      } catch {
        if (!existsSync(join(path, 'SKILL.md'))) continue
        const installation = managedPaths.get(normalizedPath(path))
        results.push({
          key: `${adapterId}:${scopeType}:${normalizedPath(path)}`,
          adapterId,
          scopeType,
          scopeKey,
          path,
          name: basename(path),
          description: 'SKILL.md 清单无效',
          contentSha256: null,
          fileList: ['SKILL.md'],
          status: 'invalid',
          origin: forcedOrigin || (installation ? 'managed' : 'external'),
          installationId: installation?.id || null,
          visibility: buildSkillVisibility([adapterId])
        })
      }
    }
  }

  /** Scan a plugin/marketplace cache tree for any directory named `skills`
   *  whose children are skill folders. Used for both Claude Code
   *  (~/.claude/plugins/cache/.../skills) and OpenCode
   *  (~/.cache/opencode/packages/<spec>/node_modules/<plugin>/skills). */
  function scanPluginSkills(adapterId, pluginsRoot, managedPaths, occurrences) {
    if (!existsSync(pluginsRoot)) return
    const visitedSkillsRoots = new Set()
    function walk(directory, depth) {
      if (depth > 8) return
      let entries = []
      try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (!entryIsDirectory(path)) continue
        if (entry.name === 'skills' && !visitedSkillsRoots.has(normalizedPath(path))) {
          visitedSkillsRoots.add(normalizedPath(path))
          scanRoot(adapterId, 'system', '*', path, managedPaths, occurrences, 'bundled')
          continue // do not recurse further into a skills container
        }
        walk(path, depth + 1)
      }
    }
    walk(pluginsRoot, 0)
  }

  /** Read ~/.claude/plugins/installed_plugins.json — the source of truth for
   *  which Claude Code plugins are actually enabled. Returns install paths. */
  function readInstalledClaudePlugins() {
    const file = join(skillHome, '.claude', 'plugins', 'installed_plugins.json')
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const plugins = raw?.plugins || {}
      return Object.values(plugins).flat().map((entry) => entry?.installPath || '').filter(Boolean)
    } catch { return [] }
  }

  /** Claude Code only loads skills from plugins listed in installed_plugins.json,
   *  not from every cache/marketplace copy on disk. Scan each installed plugin's
   *  installPath (which may hold skills at <root>/skills, <root>/.claude/skills,
   *  or a nested plugin folder). */
  function scanClaudePluginSkills(managedPaths, occurrences) {
    const installedPaths = readInstalledClaudePlugins()
    for (const installPath of installedPaths) {
      scanPluginSkills('claude', installPath, managedPaths, occurrences)
    }
  }

  function scanOpenCodePluginSkills(managedPaths, occurrences) {
    const cacheHome = env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(skillHome, '.cache')
    scanPluginSkills('opencode', join(cacheHome, 'opencode', 'packages'), managedPaths, occurrences)
  }

  function discover(projectPath) {
    const installations = db.listSkillInstallations()
    const managedPaths = new Map(installations.map((item) => [normalizedPath(item.targetPath), item]))
    const occurrences = []
    for (const adapterId of Object.keys(SKILL_ADAPTERS)) {
      const userRoot = resolveSkillRoot({ adapterId, scopeType: 'user', home: skillHome, env })
      scanRoot(adapterId, 'user', '*', userRoot, managedPaths, occurrences)
      if (projectPath) {
        const projectRoot = resolveSkillRoot({ adapterId, scopeType: 'project', projectPath })
        scanRoot(adapterId, 'project', normalizedPath(projectPath), projectRoot, managedPaths, occurrences)
      }
    }
    const codexLegacyRoot = join(skillHome, '.codex', 'skills')
    scanRoot('codex', 'user', '*', codexLegacyRoot, managedPaths, occurrences)
    scanRoot('codex', 'system', '*', join(codexLegacyRoot, '.system'), managedPaths, occurrences, 'bundled')
    scanClaudePluginSkills(managedPaths, occurrences)
    scanOpenCodePluginSkills(managedPaths, occurrences)
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
        scopeType: 'system',
        scopeKey: '*',
        path: skillPath || '',
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
      const allInvalid = sources.every((source) => source.status === 'invalid')
      const allHashed = sources.every((source) => Boolean(source.contentSha256))
      return {
        name,
        description: sources[0].description,
        status: allInvalid
          ? 'invalid'
          : hashes.size > 1 ? 'conflict' : sources.length > 1 && allHashed ? 'mirror' : 'ready',
        sources
      }
    }).sort((left, right) => left.name.localeCompare(right.name))
  }

  async function install(request = {}) {
    const targetAdapterIds = [...new Set(request.targetAdapterIds || [])]
    if (!targetAdapterIds.length || targetAdapterIds.some((id) => !SKILL_ADAPTERS[id])) {
      throw serviceError('At least one valid CLI target is required', 'SKILL_TARGET_INVALID')
    }
    const scopeType = request.scopeType
    const scopeKey = scopeType === 'project' ? normalizedPath(request.projectPath) : '*'
    if (!['user', 'project'].includes(scopeType)) throw serviceError('Skill scope is invalid', 'SKILL_SCOPE_INVALID')

    return sourceLoader.withPrepared(request.source, async (prepared) => {
      const inspected = inspectSkillDirectory(prepared.workingDirectory)
      if (targetAdapterIds.includes('opencode') && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(inspected.name)) {
        throw serviceError('Skill name is incompatible with OpenCode', 'SKILL_INCOMPATIBLE')
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
      if (targets.some((item) => existsSync(item.targetPath))) {
        throw serviceError('A skill already exists at a target location', 'SKILL_TARGET_CONFLICT')
      }

      const packageId = uuid()
      const canonical = packageDirectory(packageId)
      const created = []
      const timestamp = now()
      try {
        const canonicalInspection = copySkillDirectoryAtomic(prepared.workingDirectory, canonical)
        created.push({ path: canonical, sha256: canonicalInspection.contentSha256 })
        const installations = []
        for (const target of targets) {
          const deployed = copySkillDirectoryAtomic(canonical, target.targetPath)
          created.push({ path: target.targetPath, sha256: deployed.contentSha256 })
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
        return packageView(db.getSkillPackage(packageId))
      } catch (error) {
        if (error?.code === 'SKILL_PERSISTENCE_PENDING') throw error
        for (const item of created.reverse()) {
          try { removeManagedSkillDirectory(item.path, item.sha256) } catch { /* preserve drifted data */ }
        }
        throw error
      }
    })
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
    const installation = {
      id: uuid(), packageId, targetAdapterId: request.targetAdapterId,
      scopeType: request.scopeType, scopeKey, targetPath: path, enabled: true,
      deployedSha256: inspected.contentSha256, status: 'ready', createdAt: timestamp, updatedAt: timestamp
    }
    try {
      await db.transaction(async () => {
        db.insertSkillPackage({
          id: packageId, name: inspected.name, description: inspected.description,
          sourceType: 'adopted', sourceLocator: path, sourceRef: '', sourceRefType: 'fixed', sourceSubdir: '',
          resolvedRevision: null, manifest: inspected.manifest, contentSha256: canonical.contentSha256,
          lastCheckedAt: timestamp, createdAt: timestamp, updatedAt: timestamp
        })
        db.insertSkillInstallation(installation)
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
    inspectSource: (source) => sourceLoader.inspect(source),
    install,
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
      const packages = db.listSkillPackages().map(packageView)
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
