import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync,
  readdirSync, readlinkSync, realpathSync, statSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { resolveDshAgentsRoot, resolveProjectScopeRoot, resolveSkillRoot, SKILL_ADAPTERS } from './adapters.js'
import { parseSkillManifest, validateDshSkillName } from './contracts.js'

const DEFAULT_MAX_FLAT_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FLAT_TOTAL_BYTES = 50 * 1024 * 1024

function normalizedPath(path) {
  const value = resolve(String(path || '.'))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function pathIsWithin(root, candidate) {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value))
}

function inspectEntry(entryPath) {
  const stat = lstatSync(entryPath)
  if (!stat.isDirectory() && !stat.isSymbolicLink()) return null
  if (!stat.isSymbolicLink()) return { resolvedPath: realpathSync(entryPath), link: null }
  if (!existsSync(entryPath)) {
    const rawTarget = readlinkSync(entryPath).replace(/^\\\\\?\\/, '')
    const targetPath = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(entryPath), rawTarget)
    return {
      resolvedPath: targetPath,
      health: 'broken_link',
      link: {
        type: process.platform === 'win32' ? 'junction' : 'symlink',
        targetPath,
        status: 'broken'
      }
    }
  }
  const resolvedPath = realpathSync(entryPath)
  return {
    resolvedPath,
    link: {
      type: process.platform === 'win32' ? 'junction' : 'symlink',
      targetPath: resolvedPath,
      status: 'valid'
    }
  }
}

export function scanDeclaredSkillRoot({
  adapterId,
  sourceKind,
  scopeType,
  scopeKey,
  root,
  managedPaths,
  results,
  forcedOrigin = null,
  sourceProjects = new Map(),
  maxDepth = 0,
  sourceMetadata = {},
  allowFlatFiles = false,
  flatFilesOnly = false,
  flatFileLimits = {},
  flatFileOps = {},
  excludedEntryNames = [],
  containmentRoot = null,
  visitedRoots = new Set(),
  inspectSkillDirectory,
  buildSkillVisibility
}) {
  if (!existsSync(root)) return
  let canonicalRoot
  try { canonicalRoot = realpathSync(root) } catch { return }
  if (containmentRoot && !pathIsWithin(containmentRoot, canonicalRoot)) return
  const rootKey = normalizedPath(canonicalRoot)
  if (visitedRoots.has(rootKey)) return
  visitedRoots.add(rootKey)
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
  const maxFlatFileBytes = flatFileLimits.maxFileBytes ?? DEFAULT_MAX_FLAT_FILE_BYTES
  const maxFlatTotalBytes = flatFileLimits.maxTotalBytes ?? DEFAULT_MAX_FLAT_TOTAL_BYTES
  let flatBytesRead = 0
  const visibilityFor = (projectionAdapterIds) => {
    const visibility = buildSkillVisibility(projectionAdapterIds, { scopeType })
    if (projectionAdapterIds.includes('codex') && !sourceMetadata.dshSource) {
      visibility['deepseek-harness'] = { visible: false, direct: false, inheritedFrom: [] }
    }
    return visibility
  }

  for (const entry of entries) {
    if (excludedEntryNames.includes(entry.name)) continue
    const entryPath = join(root, entry.name)
    if (allowFlatFiles && (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.md')) {
      const fileName = entry.name.slice(0, -3)
      const installation = managedPaths.get(normalizedPath(entryPath))
      const addUnavailableFlat = ({
        name = fileName,
        health = 'invalid',
        description = 'Skill Markdown 清单无效'
      } = {}) => {
        const sourceProject = sourceProjects.get(name) || sourceProjects.get(fileName)
        results.push({
          key: `${adapterId}:${scopeType}:${normalizedPath(entryPath)}`,
          adapterId, sourceKind, scopeType, scopeKey,
          path: entryPath, entryPath,
          resolvedPath: entry.isSymbolicLink() ? entryPath : realpathSync(entryPath),
          link: entry.isSymbolicLink()
            ? { type: process.platform === 'win32' ? 'junction' : 'symlink', targetPath: null, status: 'unsupported' }
            : null,
          health, name, description,
          contentSha256: null, fileList: [entry.name], status: health,
          origin: forcedOrigin || (installation ? 'managed' : 'external'),
          installationId: installation?.id || null,
          visibility: visibilityFor([]),
          format: 'flat', manageable: false, readOnly: true,
          ...sourceMetadata,
          ...(sourceProject ? { sourceProject } : {})
        })
      }
      if (entry.isSymbolicLink()) {
        addUnavailableFlat({ health: 'unsupported', description: 'Skill Markdown 符号链接不受支持' })
        continue
      }
      let bounded
      try { bounded = readBoundedRegularFile(entryPath, maxFlatFileBytes, flatFileOps) } catch { continue }
      if (bounded.status === 'unsupported') {
        addUnavailableFlat({ health: 'unsupported', description: 'Skill Markdown 文件类型不受支持' })
        continue
      }
      if (bounded.status !== 'ready' || flatBytesRead + bounded.size > maxFlatTotalBytes) {
        addUnavailableFlat()
        continue
      }
      flatBytesRead += bounded.size
      const content = bounded.content
      try {
        const inspected = parseSkillManifest(content.toString('utf8'))
        validateDshSkillName(inspected.name)
        const sourceProject = sourceProjects.get(inspected.name) || sourceProjects.get(fileName)
        results.push({
          key: `${adapterId}:${scopeType}:${normalizedPath(entryPath)}`,
          adapterId,
          sourceKind,
          scopeType,
          scopeKey,
          path: entryPath,
          entryPath,
          resolvedPath: realpathSync(entryPath),
          link: null,
          health: 'ready',
          name: inspected.name,
          description: inspected.description,
          contentSha256: createHash('sha256').update(content).digest('hex'),
          fileList: [entry.name],
          origin: forcedOrigin || (installation ? 'managed' : 'external'),
          installationId: installation?.id || null,
          visibility: visibilityFor([adapterId]),
          format: 'flat', manageable: false, readOnly: true,
          ...sourceMetadata,
          ...(sourceProject ? { sourceProject } : {})
        })
      } catch {
        addUnavailableFlat()
      }
      continue
    }
    if (flatFilesOnly) continue
    let location
    try { location = inspectEntry(entryPath) } catch { continue }
    if (!location) continue
    if (containmentRoot && !pathIsWithin(containmentRoot, location.resolvedPath)) continue

    const installation = managedPaths.get(normalizedPath(entryPath))
    if (location.health === 'broken_link') {
      const sourceProject = sourceProjects.get(entry.name)
      results.push({
        key: `${adapterId}:${scopeType}:${normalizedPath(entryPath)}`,
        adapterId,
        sourceKind,
        scopeType,
        scopeKey,
        path: entryPath,
        entryPath,
        resolvedPath: location.resolvedPath,
        link: location.link,
        health: 'broken_link',
        name: entry.name,
        description: 'Skill 链接目标不存在',
        contentSha256: null,
        fileList: [],
        status: 'broken_link',
        origin: forcedOrigin || (installation ? 'managed' : 'external'),
        installationId: installation?.id || null,
        visibility: visibilityFor([]),
        ...sourceMetadata,
        ...(sourceProject ? { sourceProject } : {})
      })
      continue
    }

    try {
      const inspected = inspectSkillDirectory(entryPath)
      let dshCompatible = true
      if (sourceMetadata.dshDirect) {
        validateDshSkillName(inspected.name)
      } else if (sourceMetadata.dshSource) {
        try { validateDshSkillName(inspected.name) } catch { dshCompatible = false }
      }
      const sourceProject = sourceProjects.get(entry.name) || sourceProjects.get(inspected.name)
      results.push({
        key: `${adapterId}:${scopeType}:${normalizedPath(entryPath)}`,
        adapterId,
        sourceKind,
        scopeType,
        scopeKey,
        path: entryPath,
        entryPath,
        resolvedPath: location.resolvedPath,
        link: location.link,
        health: 'ready',
        name: inspected.name,
        description: inspected.description,
        contentSha256: inspected.contentSha256,
        fileList: inspected.fileList,
        origin: forcedOrigin || (installation ? 'managed' : 'external'),
        installationId: installation?.id || null,
        visibility: (() => {
          const visibility = visibilityFor([adapterId])
          if (!dshCompatible) visibility['deepseek-harness'] = { visible: false, direct: false, inheritedFrom: [] }
          return visibility
        })(),
        ...(sourceMetadata.dshSource ? { dshCompatible } : {}),
        ...sourceMetadata,
        ...(sourceProject ? { sourceProject } : {})
      })
    } catch {
      if (!existsSync(join(entryPath, 'SKILL.md'))) {
        if (maxDepth > 0) {
          scanDeclaredSkillRoot({
            adapterId,
            sourceKind,
            scopeType,
            scopeKey,
            root: entryPath,
            managedPaths,
            results,
            forcedOrigin,
            sourceProjects,
            maxDepth: maxDepth - 1,
            sourceMetadata,
            allowFlatFiles,
            flatFilesOnly,
            flatFileLimits,
            flatFileOps,
            excludedEntryNames,
            containmentRoot,
            visitedRoots,
            inspectSkillDirectory,
            buildSkillVisibility
          })
        }
        continue
      }
      const sourceProject = sourceProjects.get(entry.name)
      results.push({
        key: `${adapterId}:${scopeType}:${normalizedPath(entryPath)}`,
        adapterId,
        sourceKind,
        scopeType,
        scopeKey,
        path: entryPath,
        entryPath,
        resolvedPath: location.resolvedPath,
        link: location.link,
        health: 'invalid',
        name: basename(entryPath),
        description: 'SKILL.md 清单无效',
        contentSha256: null,
        fileList: ['SKILL.md'],
        status: 'invalid',
        origin: forcedOrigin || (installation ? 'managed' : 'external'),
        installationId: installation?.id || null,
        visibility: visibilityFor([]),
        ...sourceMetadata,
        ...(sourceProject ? { sourceProject } : {})
      })
    }
  }
}

function entryIsDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function readBoundedRegularFile(path, maxBytes, fileOps = {}) {
  const initial = lstatSync(path)
  if (!initial.isFile() || initial.isSymbolicLink()) return { status: 'unsupported' }
  if (initial.size > maxBytes) return { status: 'too_large', size: initial.size }
  fileOps.beforeOpen?.(path)
  const beforeOpen = lstatSync(path)
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || !sameFileIdentity(initial, beforeOpen)) {
    return { status: 'unsupported' }
  }
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  const fd = openSync(path, 'r')
  let offset = 0
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) return { status: 'unsupported' }
    while (offset <= maxBytes) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
  } finally {
    closeSync(fd)
  }
  return offset > maxBytes
    ? { status: 'too_large', size: offset }
    : { status: 'ready', content: buffer.subarray(0, offset), size: offset }
}

function dshSourceMetadata(adapterId, scopeType) {
  if (adapterId === 'deepseek-harness') {
    return scopeType === 'project'
      ? { dshSource: 'project-dsh', dshRank: 100, dshDirect: true }
      : { dshSource: 'user-dsh', dshRank: 400, dshDirect: true }
  }
  if (adapterId === 'codex') {
    return scopeType === 'project'
      ? { dshSource: 'project-agents', dshRank: 200 }
      : { dshSource: 'user-agents', dshRank: 500 }
  }
  return {}
}

function applyDshPrecedence(results) {
  const byName = new Map()
  for (const item of results) {
    if (!item.dshSource) continue
    const sources = byName.get(item.name) || []
    sources.push(item)
    byName.set(item.name, sources)
  }
  for (const sources of byName.values()) {
    const winner = sources
      .filter((item) => item.health === 'ready' && item.dshCompatible !== false)
      .sort((left, right) => left.dshRank - right.dshRank)[0] || null
    for (const item of sources) {
      item.effective = item === winner
      item.shadowedBy = item === winner ? null : winner?.dshSource || null
    }
  }
}

function readInstalledClaudePlugins(home, projectPath) {
  const file = join(home, '.claude', 'plugins', 'installed_plugins.json')
  try {
    const registry = JSON.parse(readFileSync(file, 'utf8'))
    const activeProject = projectPath ? normalizedPath(projectPath) : null
    const installed = []
    for (const [pluginKey, entries] of Object.entries(registry?.plugins || {})) {
      const separator = pluginKey.lastIndexOf('@')
      const pluginId = separator > 0 ? pluginKey.slice(0, separator) : pluginKey
      const marketplace = separator > 0 ? pluginKey.slice(separator + 1) : ''
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry?.installPath) continue
        const scopeType = ['project', 'local'].includes(entry.scope) ? 'project' : 'user'
        const registeredProject = entry.projectPath || entry.projectRoot || entry.cwd || ''
        const scopeKey = scopeType === 'project' && registeredProject
          ? normalizedPath(registeredProject)
          : '*'
        if (scopeType === 'project' && (!activeProject || scopeKey !== activeProject)) continue
        installed.push({ pluginId, marketplace, scopeType, scopeKey, installPath: entry.installPath })
      }
    }
    return installed
  } catch {
    return []
  }
}

function githubSourceProject(locator) {
  const value = String(locator?.url || locator || '').trim()
  const https = value.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  const ssh = value.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  const match = https || ssh
  if (!match) return null
  return { type: 'github', locator: `https://github.com/${match[1]}/${match[2]}` }
}

function gitOriginProject(directory) {
  try {
    const config = readFileSync(join(directory, '.git', 'config'), 'utf8')
    const origin = config.match(/\[remote "origin"\]([\s\S]*?)(?=\r?\n\[|$)/)?.[1]
    const url = origin?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]
    return githubSourceProject(url)
  } catch {
    return null
  }
}

function readClaudeMarketplaceProjects(home) {
  const projects = new Map()
  try {
    const registry = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'))
    for (const [name, entry] of Object.entries(registry || {})) {
      const githubRepo = entry?.source?.source === 'github' ? entry.source.repo : null
      const project = githubSourceProject(githubRepo ? `https://github.com/${githubRepo}` : '') ||
        gitOriginProject(entry?.installLocation || entry?.source?.path || '')
      if (project) projects.set(name, project)
    }
  } catch { /* marketplace metadata is optional */ }
  return projects
}

function pluginSourceProject(plugin, marketplaceProjects) {
  try {
    const manifest = JSON.parse(readFileSync(join(plugin.installPath, '.claude-plugin', 'plugin.json'), 'utf8'))
    const project = githubSourceProject(manifest.repository) || githubSourceProject(manifest.homepage)
    if (project) return project
  } catch { /* plugin manifest is optional */ }
  return marketplaceProjects.get(plugin.marketplace) || null
}

function scanPluginSkills({ adapterId, pluginsRoot, scanRoot, ...options }) {
  if (!existsSync(pluginsRoot)) return
  let canonicalPluginRoot
  try { canonicalPluginRoot = realpathSync(pluginsRoot) } catch { return }
  const visitedSkillsRoots = new Set()
  const visitedDirectories = new Set()
  function walk(directory, depth) {
    if (depth > 8) return
    let canonicalDirectory
    try { canonicalDirectory = realpathSync(directory) } catch { return }
    if (!pathIsWithin(canonicalPluginRoot, canonicalDirectory)) return
    const directoryKey = normalizedPath(canonicalDirectory)
    if (visitedDirectories.has(directoryKey)) return
    visitedDirectories.add(directoryKey)
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !entryIsDirectory(path)) continue
      if (entry.name === 'skills' && !visitedSkillsRoots.has(normalizedPath(path))) {
        visitedSkillsRoots.add(normalizedPath(path))
        scanRoot({
          adapterId,
          root: path,
          maxDepth: 6,
          containmentRoot: canonicalPluginRoot,
          ...options
        })
        continue
      }
      walk(path, depth + 1)
    }
  }
  walk(pluginsRoot, 0)
}

export function createSkillDiscovery({
  home, env = process.env, inspectSkillDirectory, buildSkillVisibility,
  flatFileLimits = {}, flatFileOps = {}
}) {
  const skillHome = resolve(home)

  return {
    discover({
      projectPath,
      managedInstallations = [],
      sourceProjects = new Map(),
      projectSourceProjects = new Map()
    } = {}) {
      const results = []
      const marketplaceProjects = readClaudeMarketplaceProjects(skillHome)
      const managedPaths = new Map(managedInstallations.map((item) => [normalizedPath(item.targetPath), item]))
      const dshAgentsRoot = resolveDshAgentsRoot({ home: skillHome, env })
      const codexUserRoot = resolveSkillRoot({ adapterId: 'codex', scopeType: 'user', home: skillHome, env })
      const scanRoot = ({
        adapterId,
        sourceKind,
        scopeType,
        scopeKey = '*',
        root,
        forcedOrigin = null,
        projects = new Map(),
        maxDepth = 0,
        sourceMetadata = {},
        allowFlatFiles = Boolean(sourceMetadata.dshDirect),
        flatFilesOnly = false,
        excludedEntryNames = [],
        containmentRoot = null
      }) => scanDeclaredSkillRoot({
        adapterId,
        sourceKind,
        scopeType,
        scopeKey,
        root,
        managedPaths,
        results,
        forcedOrigin,
        sourceProjects: projects,
        maxDepth,
        sourceMetadata,
        allowFlatFiles,
        flatFilesOnly,
        flatFileLimits,
        flatFileOps,
        excludedEntryNames,
        containmentRoot,
        inspectSkillDirectory,
        buildSkillVisibility
      })

      const canonicalProject = projectPath ? resolveProjectScopeRoot(projectPath) : null
      for (const adapterId of Object.keys(SKILL_ADAPTERS)) {
        const userRoot = resolveSkillRoot({ adapterId, scopeType: 'user', home: skillHome, env })
        const userMetadata = adapterId === 'codex' && normalizedPath(userRoot) !== normalizedPath(dshAgentsRoot)
          ? {}
          : dshSourceMetadata(adapterId, 'user')
        scanRoot({
          adapterId,
          sourceKind: `${adapterId}_user`,
          scopeType: 'user',
          root: userRoot,
          projects: sourceProjects,
          sourceMetadata: userMetadata,
          excludedEntryNames: adapterId === 'deepseek-harness' ? ['.system'] : []
        })
        if (projectPath) {
          scanRoot({
            adapterId,
            sourceKind: `${adapterId}_project`,
            scopeType: 'project',
            scopeKey: ['codex', 'deepseek-harness'].includes(adapterId)
              ? normalizedPath(canonicalProject)
              : normalizedPath(projectPath),
            root: resolveSkillRoot({ adapterId, scopeType: 'project', projectPath }),
            projects: projectSourceProjects,
            sourceMetadata: dshSourceMetadata(adapterId, 'project')
          })
        }
      }

      if (normalizedPath(codexUserRoot) === normalizedPath(dshAgentsRoot)) {
        scanRoot({
          adapterId: 'deepseek-harness',
          sourceKind: 'deepseek-harness_user_agents_flat',
          scopeType: 'user',
          root: dshAgentsRoot,
          projects: sourceProjects,
          sourceMetadata: { dshSource: 'user-agents', dshRank: 500 },
          allowFlatFiles: true,
          flatFilesOnly: true
        })
      } else {
        scanRoot({
          adapterId: 'deepseek-harness',
          sourceKind: 'deepseek-harness_user_agents',
          scopeType: 'user',
          root: dshAgentsRoot,
          projects: sourceProjects,
          sourceMetadata: { dshSource: 'user-agents', dshRank: 500 },
          allowFlatFiles: true
        })
      }

      if (canonicalProject) {
        scanRoot({
          adapterId: 'deepseek-harness',
          sourceKind: 'deepseek-harness_project_agents_flat',
          scopeType: 'project',
          scopeKey: normalizedPath(canonicalProject),
          root: resolveSkillRoot({ adapterId: 'codex', scopeType: 'project', projectPath: canonicalProject }),
          projects: projectSourceProjects,
          sourceMetadata: { dshSource: 'project-agents', dshRank: 200 },
          allowFlatFiles: true,
          flatFilesOnly: true
        })
      }

      const bundledRoot = typeof env.DSH_BUNDLED_SKILL_DIR === 'string' &&
        isAbsolute(env.DSH_BUNDLED_SKILL_DIR)
        ? resolve(env.DSH_BUNDLED_SKILL_DIR)
        : null
      if (bundledRoot) {
        scanRoot({
          adapterId: 'deepseek-harness',
          sourceKind: 'deepseek-harness_bundled',
          scopeType: 'system',
          root: bundledRoot,
          forcedOrigin: 'bundled',
          sourceMetadata: {
            dshSource: 'bundled', dshRank: 600, dshDirect: true,
            readOnly: true, manageable: false
          },
          containmentRoot: bundledRoot
        })
      }

      const codexLegacyRoot = join(skillHome, '.codex', 'skills')
      scanRoot({
        adapterId: 'codex',
        sourceKind: 'codex_user',
        scopeType: 'user',
        root: codexLegacyRoot,
        projects: sourceProjects
      })
      scanRoot({
        adapterId: 'codex',
        sourceKind: 'codex_builtin',
        scopeType: 'system',
        root: join(codexLegacyRoot, '.system'),
        forcedOrigin: 'bundled'
      })

      for (const plugin of readInstalledClaudePlugins(skillHome, projectPath)) {
        const sourceProject = pluginSourceProject(plugin, marketplaceProjects)
        scanPluginSkills({
          adapterId: 'claude',
          pluginsRoot: plugin.installPath,
          scanRoot,
          sourceKind: 'claude_plugin',
          scopeType: plugin.scopeType,
          scopeKey: plugin.scopeKey,
          forcedOrigin: 'plugin',
          sourceMetadata: {
            plugin: { id: plugin.pluginId, marketplace: plugin.marketplace },
            ...(sourceProject ? { sourceProject } : {})
          }
        })
      }

      const cacheHome = env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(skillHome, '.cache')
      scanPluginSkills({
        adapterId: 'opencode',
        pluginsRoot: join(cacheHome, 'opencode', 'packages'),
        scanRoot,
        sourceKind: 'opencode_builtin',
        scopeType: 'system',
        forcedOrigin: 'bundled'
      })
      applyDshPrecedence(results)
      return results
    }
  }
}
