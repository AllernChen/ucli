import { isAllowedGitLabUrl } from './gitRemotePolicy.js'

const STATUSES = {
  ready: { label: '可用', color: 'green' },
  disabled: { label: '已停用', color: 'default' },
  drifted: { label: '已被外部修改', color: 'orange' },
  conflict: { label: '同名内容冲突', color: 'red' },
  missing: { label: '投放文件缺失', color: 'red' },
  invalid: { label: 'Skill 无效', color: 'red' },
  broken_link: { label: '链接失效', color: 'red' },
  update_available: { label: '有可用更新', color: 'blue' },
  mirror: { label: '兼容镜像', color: 'cyan' }
}

const ORIGINS = {
  managed: 'UCLI 托管',
  external: '现有 Skill',
  plugin: 'CLI 插件',
  bundled: 'CLI 内置',
  system: 'CLI 系统'
}

const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', ucode: 'U-Code', 'deepseek-harness': 'DeepSeek Harness' }
const SOURCE_KINDS = {
  claude_user: 'Claude 用户目录',
  claude_project: 'Claude 项目目录',
  claude_plugin: 'Claude 插件',
  codex_user: 'Codex / Agent Skills',
  codex_project: 'Codex 项目目录',
  codex_builtin: 'CLI 内置',
  claude_builtin: 'CLI 内置',
  opencode_builtin: 'CLI 内置',
  ucode_builtin: 'CLI 内置'
}
const BUILT_IN_ORIGINS = new Set(['bundled', 'system'])
const INSTALLATION_STATUS_ORDER = ['drifted', 'broken_link', 'invalid', 'missing', 'update_available', 'ready', 'disabled']

export function createLatestRequestGuard() {
  let current = 0
  return {
    begin() {
      current += 1
      return current
    },
    invalidate() {
      current += 1
    },
    isCurrent(requestId) {
      return requestId === current
    }
  }
}

export function canConfirmSkillInstall(options = {}) {
  const preview = options.preview
  if (!preview || preview.kind === 'collection' || options.inspecting) return false
  if (!(options.targetAdapterIds || []).length) return false
  if ((options.targetAdapterIds || []).some((adapterId) =>
    preview.compatibility?.[adapterId]?.compatible === false)) return false
  if (options.scopeType !== 'user' && !options.projectPath) return false
  if (['source_changed', 'target_conflict'].includes(options.preflightKind)) return false
  if (options.sourceType !== 'local' &&
      String(preview.source?.subdir || '') !== String(options.subdir || '')) return false
  return true
}

export function resolveSkillCollectionInstallSelection(options = {}) {
  const preview = options.preview
  const skills = preview?.kind === 'collection' && Array.isArray(preview.skills) ? preview.skills : []
  const selected = new Set(options.selectedSubdirs || [])
  const selectedSkills = skills.filter((skill) => selected.has(skill.subdir))
  const nameCounts = new Map()
  for (const skill of selectedSkills) {
    const nameKey = String(skill.name || '').toLowerCase()
    nameCounts.set(nameKey, (nameCounts.get(nameKey) || 0) + 1)
  }

  const blockedSkills = selectedSkills.flatMap((skill) => {
    if (nameCounts.get(String(skill.name || '').toLowerCase()) > 1) return [{ skill, reason: 'duplicate_name' }]
    if ((options.targetAdapterIds || []).some((adapterId) =>
      skill.compatibility?.[adapterId]?.compatible === false)) {
      return [{ skill, reason: 'incompatible' }]
    }
    const preflight = resolveSkillInstallPreflight(skill, {
      scopeType: options.scopeType,
      projectPath: options.projectPath,
      targetAdapterIds: options.targetAdapterIds
    })
    if (canConfirmSkillInstall({
      preview: skill,
      inspecting: options.inspecting,
      sourceType: options.sourceType,
      subdir: skill.subdir,
      targetAdapterIds: options.targetAdapterIds,
      scopeType: options.scopeType,
      projectPath: options.projectPath,
      preflightKind: preflight.kind
    })) return []
    return [{ skill, reason: options.inspecting ? 'inspecting' : preflight.kind }]
  })
  const allSelected = skills.length > 0 && selectedSkills.length === skills.length
  return {
    selectedSkills,
    blockedSkills,
    allSelected,
    partiallySelected: selectedSkills.length > 0 && !allSelected,
    canInstall: selectedSkills.length > 0 && blockedSkills.length === 0
  }
}

export function buildSkillCollectionInstallRequests(options = {}) {
  if (options.preview?.kind !== 'collection' || !options.preview.resolvedRevision) return []
  const selected = new Set(options.selectedSubdirs || [])
  return options.preview.skills
    .filter((skill) => selected.has(skill.subdir))
    .map((skill) => ({
      ...buildSkillInstallRequest({
        source: { ...options.source, subdir: skill.subdir },
        targetAdapterIds: options.targetAdapterIds || [],
        scopeType: options.scopeType,
        projectPath: options.projectPath || ''
      }),
      expectedRevision: options.preview.resolvedRevision
    }))
}

export function skillInstallAffectedInstallationIds(pkg = {}) {
  const installations = pkg.installations || []
  if (pkg.installOutcome?.kind === 'already_installed') return []
  if (['applied_existing', 'adopted_existing'].includes(pkg.installOutcome?.kind)) {
    const applied = pkg.installOutcome.appliedAdapterIds || []
    return installations
      .filter((item) => applied.includes(item.targetAdapterId))
      .map((item) => item.id)
  }
  return installations.map((item) => item.id)
}

function mergeVisibility(target, source = {}) {
  for (const [adapterId, visibility] of Object.entries(source || {})) {
    const current = target[adapterId] || { visible: false, direct: false, inheritedFrom: [] }
    target[adapterId] = {
      visible: current.visible || Boolean(visibility?.visible),
      direct: current.direct || Boolean(visibility?.direct),
      inheritedFrom: [...new Set([...(current.inheritedFrom || []), ...(visibility?.inheritedFrom || [])])]
    }
  }
}

function catalogStatus(entry) {
  const hashes = new Set([
    ...entry.installations.map((item) => item.deployedSha256),
    ...entry.sources.map((source) => source.contentSha256)
  ].filter(Boolean))
  if (hashes.size > 1) return 'conflict'

  const installationStatus = INSTALLATION_STATUS_ORDER.find((status) =>
    entry.installations.some((item) => item.status === status)
  )
  if (installationStatus) return installationStatus
  if (entry.sources.length && entry.sources.every((source) =>
    source.health === 'broken_link' || source.status === 'broken_link'
  )) return 'broken_link'
  if (entry.sources.some((source) => source.status === 'invalid')) return 'invalid'
  if (entry.sources.length > 1 && entry.sources.every((source) => Boolean(source.contentSha256))) return 'mirror'
  return 'ready'
}

export function aggregateSkillCatalog({ packages = [], discovered = [], includeBuiltIn = false } = {}) {
  const entries = new Map()
  const getEntry = (name, description = '') => {
    if (!entries.has(name)) {
      entries.set(name, {
        key: name,
        name,
        description,
        packages: [],
        installations: [],
        sources: [],
        visibility: {}
      })
    }
    const entry = entries.get(name)
    if (!entry.description && description) entry.description = description
    return entry
  }

  for (const pkg of packages) {
    const entry = getEntry(pkg.name, pkg.description)
    entry.packages.push(pkg)
    mergeVisibility(entry.visibility, pkg.visibility)
    for (const installation of pkg.installations || []) {
      entry.installations.push({ ...installation, packageId: pkg.id, visibility: installation.visibility || {} })
    }
  }

  const installationsById = new Map(
    [...entries.values()].flatMap((entry) => entry.installations).map((item) => [item.id, item])
  )
  for (const group of discovered) {
    const visibleSources = (group.sources || []).filter((source) =>
      includeBuiltIn || !BUILT_IN_ORIGINS.has(source.origin)
    )
    for (const source of visibleSources) {
      const managedInstallation = source.installationId && installationsById.get(source.installationId)
      if (managedInstallation) {
        managedInstallation.origin = 'managed'
        managedInstallation.visibility = source.visibility
        managedInstallation.sourceKind = source.sourceKind
        managedInstallation.entryPath = source.entryPath || source.path
        managedInstallation.resolvedPath = source.resolvedPath || source.path
        managedInstallation.link = source.link || null
        managedInstallation.health = source.health || source.status || 'ready'
        if (source.plugin) managedInstallation.plugin = source.plugin
        if (source.sourceProject) managedInstallation.sourceProject = source.sourceProject
        if (managedInstallation.health === 'broken_link') managedInstallation.status = 'broken_link'
        mergeVisibility(getEntry(group.name, group.description).visibility, source.visibility)
        continue
      }
      const entry = getEntry(group.name, group.description)
      if (!entry.sources.some((item) => item.key === source.key)) entry.sources.push(source)
      mergeVisibility(entry.visibility, source.visibility)
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.packages.length || entry.sources.length)
    .map((entry) => ({
      ...entry,
      status: catalogStatus(entry),
      builtinOnly: entry.packages.length === 0 && entry.sources.length > 0 && entry.sources.every((source) => BUILT_IN_ORIGINS.has(source.origin))
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function matchesCatalogStatus(entry, status) {
  return status === 'all' ||
    entry.status === status ||
    entry.installations.some((item) => item.status === status) ||
    entry.sources.some((source) => source.status === status || source.health === status)
}

export function filterSkillCatalog(entries = [], {
  search = '', adapterId = 'all', status = 'all', scopeType = 'all'
} = {}) {
  const query = String(search || '').trim().toLowerCase()
  return entries.flatMap((entry) => {
    if (query && !`${entry.name} ${entry.description}`.toLowerCase().includes(query)) return []

    const matchesSource = (location) => {
      if (scopeType !== 'all' && location.scopeType !== scopeType) return false
      if (adapterId !== 'all' && location.adapterId !== adapterId && !location.visibility?.[adapterId]?.visible) return false
      return true
    }
    const matchesInstallation = (location) => {
      if (scopeType !== 'all' && location.scopeType !== scopeType) return false
      if (adapterId !== 'all' && location.targetAdapterId !== adapterId && !location.visibility?.[adapterId]?.visible) return false
      return true
    }
    const sources = entry.sources.filter(matchesSource)
    const installations = entry.installations.filter(matchesInstallation)
    if (!sources.length && !installations.length) return []

    const filterLocations = adapterId !== 'all' || scopeType !== 'all'
    const visiblePackageIds = new Set(installations.map((item) => item.packageId))
    const filteredEntry = {
      ...entry,
      sources,
      installations,
      packages: filterLocations
        ? entry.packages.filter((pkg) => visiblePackageIds.has(pkg.id))
        : entry.packages
    }
    if (filterLocations) {
      filteredEntry.visibility = {}
      for (const location of [...installations, ...sources]) mergeVisibility(filteredEntry.visibility, location.visibility)
      filteredEntry.status = catalogStatus(filteredEntry)
    }
    if (!matchesCatalogStatus(filteredEntry, status)) return []
    return [filteredEntry]
  })
}

const CLI_USAGE_LABELS = {
  managed: '已应用',
  inherited: '可用（继承）',
  external: '已发现',
  builtin: 'CLI 内置',
  disabled: '已停用',
  drifted: '外部已修改',
  missing: '投放缺失',
  invalid: '投放无效',
  broken_link: '链接失效',
  unavailable: '未应用'
}

const CLI_INSTALLATION_PRIORITY = {
  ready: 0,
  update_available: 0,
  drifted: 1,
  broken_link: 2,
  missing: 3,
  invalid: 4,
  disabled: 5
}

export function skillPackageApplyTargets(pkg = {}, adapters = []) {
  const directTargets = new Set((pkg.installations || []).map((item) => item.targetAdapterId))
  return adapters.filter((adapter) =>
    !adapter.virtual && !directTargets.has(adapter.id) && pkg.compatibility?.[adapter.id]?.compatible !== false
  )
}

export function buildSkillCliMatrix(entry = {}, adapters = []) {
  const packages = entry.packages || []
  const installations = entry.installations || []
  const sources = entry.sources || []
  const pluginOnly = sources.length > 0 && sources.every((item) => item.origin === 'plugin')
  const pluginCopySource = pluginOnly
    ? sources.find((item) => !['broken_link', 'invalid'].includes(item.health || item.status) && (item.resolvedPath || item.path)) || null
    : null

  return adapters.map((adapter) => {
    if (adapter.virtual && adapter.id === 'deepseek-harness') {
      const visibility = entry.visibility?.[adapter.id] || { visible: false, direct: false, inheritedFrom: [] }
      return {
        adapterId: adapter.id,
        displayName: adapter.displayName || skillCliName(adapter.id),
        state: visibility.visible ? 'inherited' : 'unavailable',
        label: visibility.visible ? '项目 .agents/skills 可见' : CLI_USAGE_LABELS.unavailable,
        visible: Boolean(visibility.visible),
        direct: false,
        inheritedFrom: visibility.inheritedFrom || [],
        installation: null,
        installations: [],
        source: null,
        copySource: null,
        packageId: null,
        packageOptions: [],
        action: null,
        actionLabel: '',
        disabledReason: '由项目 .agents/skills 提供；DSH 用户级 Skill 由原生运行时管理'
      }
    }
    const pluginCopyCompatible = adapter.id !== 'opencode' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name || '')
    const adapterInstallations = installations
      .filter((item) => item.targetAdapterId === adapter.id)
      .sort((left, right) =>
        (CLI_INSTALLATION_PRIORITY[left.status] ?? 5) - (CLI_INSTALLATION_PRIORITY[right.status] ?? 5)
      )
    const installation = adapterInstallations[0] || null
    const adapterSources = sources.filter((item) => item.adapterId === adapter.id)
    const source = adapterSources.find((item) => ['external', 'plugin'].includes(item.origin)) || adapterSources[0] || null
    const sourceUsable = Boolean(source) && !['broken_link', 'invalid'].includes(source.health || source.status)
    const installationUsable = Boolean(installation?.enabled) && ['ready', 'update_available'].includes(installation.status)
    const visibility = entry.visibility?.[adapter.id] || { visible: false, direct: false, inheritedFrom: [] }
    const pkg = packages.length === 1 ? packages[0] : null
    const compatibility = pkg?.compatibility?.[adapter.id]
    const compatible = compatibility?.compatible !== false
    const canApply = Boolean(pkg) && compatible && entry.status !== 'conflict'
    const packageOptions = packages.filter((item) => item.compatibility?.[adapter.id]?.compatible !== false)

    let state = 'unavailable'
    let action = canApply ? 'apply' : null
    let actionLabel = '应用'
    if (installation) {
      if (!installation.enabled || installation.status === 'disabled') {
        state = 'disabled'
        action = adapterInstallations.length === 1 ? 'enable' : null
        actionLabel = '启用'
      } else if (['drifted', 'broken_link', 'missing', 'invalid'].includes(installation.status)) {
        state = installation.status
        action = null
        actionLabel = ''
      } else {
        state = 'managed'
        action = null
        actionLabel = ''
      }
    } else if (source) {
      if (source.health === 'broken_link' || source.status === 'broken_link') {
        state = 'broken_link'
        action = null
        actionLabel = ''
      } else if (source.health === 'invalid' || source.status === 'invalid') {
        state = 'invalid'
        action = null
        actionLabel = ''
      } else {
        state = ['external', 'plugin'].includes(source.origin) ? 'external' : 'builtin'
        action = ['external', 'plugin'].includes(source.origin) && canApply ? 'apply' : null
        actionLabel = '纳入管理'
      }
    } else if (visibility.visible) {
      state = 'inherited'
      actionLabel = '直接应用'
    }

    if (!installation && !source && pluginCopySource && pluginCopyCompatible) {
      action = 'install_copy'
      actionLabel = '安装独立副本'
    }

    let disabledReason = null
    if (!compatible) disabledReason = compatibility?.reason || 'Skill 与此 CLI 不兼容'
    else if (packages.length > 1) disabledReason = '存在多个受管版本，请在下方选择具体版本应用'
    else if (source?.origin === 'plugin') disabledReason = '此 Skill 由 Claude 插件管理'
    else if (pluginOnly && !pluginCopySource) disabledReason = '插件 Skill 的物理目录不可用，无法创建独立副本'
    else if (pluginOnly && !pluginCopyCompatible) disabledReason = 'Skill 名称不符合 OpenCode 规则'
    else if (action === 'install_copy') disabledReason = null
    else if (!packages.length && state !== 'managed' && state !== 'disabled') disabledReason = '请先接管此 Skill'
    else if (entry.status === 'conflict') disabledReason = '请先解决同名内容冲突'
    if (state === 'missing') disabledReason = '投放目录缺失，请在位置管理中停用后重新启用'
    if (state === 'invalid') disabledReason = '投放内容无效，请检查或移除此位置'
    if (state === 'drifted') disabledReason = '投放内容已被外部修改，请先处理差异'
    if (state === 'broken_link') disabledReason = '链接目标不存在，请修复或移除此入口'

    return {
      adapterId: adapter.id,
      displayName: adapter.displayName || skillCliName(adapter.id),
      state,
      label: CLI_USAGE_LABELS[state],
      visible: ['broken_link', 'invalid'].includes(state) ? false : Boolean(visibility.visible),
      direct: Boolean(installationUsable || sourceUsable),
      inheritedFrom: visibility.inheritedFrom || [],
      installation,
      installations: adapterInstallations,
      source,
      copySource: action === 'install_copy' ? pluginCopySource : null,
      packageId: pkg?.id || null,
      packageOptions,
      action,
      actionLabel,
      disabledReason
    }
  })
}

export function buildSourceProjectCliSummary(sourceProject = {}, adapters = []) {
  const entries = sourceProject.entries || []
  return adapters.map((adapter) => {
    const used = entries.reduce((count, entry) => {
      const cell = buildSkillCliMatrix(entry, [adapter])[0]
      return count + (cell?.direct || cell?.visible ? 1 : 0)
    }, 0)
    return {
      adapterId: adapter.id,
      displayName: adapter.displayName || skillCliName(adapter.id),
      used,
      total: entries.length,
      state: used === 0 ? 'none' : used === entries.length ? 'all' : 'partial'
    }
  })
}

export function buildPluginCopyInstallRequest(source = {}, targetAdapterId, projectPath = '') {
  const sourcePath = source.resolvedPath || source.path
  if (source.origin !== 'plugin' || source.health !== 'ready' || !sourcePath || !targetAdapterId) return null
  const scopeType = source.scopeType === 'project' ? 'project' : 'user'
  if (scopeType === 'project' && !projectPath) return null
  return {
    source: { type: 'local', path: sourcePath },
    targetAdapterIds: [targetAdapterId],
    scopeType,
    projectPath: scopeType === 'project' ? projectPath : ''
  }
}

export function buildSkillInstallRequest({ source, targetAdapterIds, scopeType, projectPath = '' }) {
  return {
    source,
    targetAdapterIds: [...targetAdapterIds],
    scopeType,
    projectPath
  }
}

export function normaliseGitHubRepository(sourceLocator) {
  return normaliseGitRepository(sourceLocator, { host: 'github.com', kind: 'github' })
}

export function normaliseGitLabRepository(sourceLocator) {
  return normaliseGitRepository(sourceLocator, {
    host: 'gitlab.com', kind: 'gitlab', nestedGroups: true, allowSelfHosted: true
  })
}

function normaliseGitRepository(sourceLocator, { host, kind, nestedGroups = false, allowSelfHosted = false }) {
  let url
  try { url = new URL(String(sourceLocator || '')) } catch { return null }
  const officialHttps = url.protocol === 'https:' && url.hostname.toLowerCase() === host
  if ((!officialHttps && (!allowSelfHosted || !isAllowedGitLabUrl(url))) || url.username || url.password) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if ((!nestedGroups && parts.length !== 2) || (nestedGroups && parts.length < 2)) return null
  const path = [...parts]
  path[path.length - 1] = path.at(-1).replace(/\.git$/i, '')
  if (path.some((part) => !part || !/^[\w.-]+$/.test(part))) return null
  const origin = officialHttps ? `https://${host}` : `${url.protocol}//${url.host}`
  const identityPrefix = officialHttps ? '' : `${url.host.toLowerCase()}/`
  const labelPrefix = officialHttps ? '' : `${url.host}/`
  return {
    key: `${kind}:${identityPrefix}${path.map((part) => part.toLowerCase()).join('/')}`,
    label: `${labelPrefix}${path.join('/')}`,
    repositoryUrl: `${origin}/${path.join('/')}`
  }
}

function sliceCatalogEntry(entry, packages, installations, sources) {
  const visibility = {}
  for (const location of [...installations, ...sources]) mergeVisibility(visibility, location.visibility)
  if (!installations.length && !sources.length) {
    for (const pkg of packages) mergeVisibility(visibility, pkg.visibility)
  }
  const sliced = { ...entry, packages, installations, sources, visibility }
  return {
    ...sliced,
    status: catalogStatus(sliced),
    builtinOnly: packages.length === 0 && sources.length > 0 && sources.every((source) => BUILT_IN_ORIGINS.has(source.origin))
  }
}

export function groupSkillCatalogBySourceProject(entries = [], { status = 'all' } = {}) {
  const groups = new Map()
  const ensureGroup = (sourceProject) => {
    if (!groups.has(sourceProject.key)) {
      groups.set(sourceProject.key, { ...sourceProject, entries: [] })
    }
    return groups.get(sourceProject.key)
  }

  for (const entry of entries) {
    const gitBuckets = new Map()
    const otherPackages = []
    for (const pkg of entry.packages || []) {
      const repository = pkg.sourceType === 'github'
        ? normaliseGitHubRepository(pkg.sourceLocator)
        : pkg.sourceType === 'gitlab'
          ? normaliseGitLabRepository(pkg.sourceLocator)
          : pkg.sourceProject?.type === 'github'
            ? normaliseGitHubRepository(pkg.sourceProject.locator)
            : pkg.sourceProject?.type === 'gitlab'
              ? normaliseGitLabRepository(pkg.sourceProject.locator)
          : null
      if (!repository) {
        otherPackages.push(pkg)
        continue
      }
      const bucket = gitBuckets.get(repository.key) || { repository, packages: [], sources: [] }
      bucket.packages.push(pkg)
      gitBuckets.set(repository.key, bucket)
    }

    const otherSources = []
    for (const source of entry.sources || []) {
      const repository = source.sourceProject?.type === 'github'
        ? normaliseGitHubRepository(source.sourceProject.locator)
        : source.sourceProject?.type === 'gitlab'
          ? normaliseGitLabRepository(source.sourceProject.locator)
        : null
      if (!repository) {
        otherSources.push(source)
        continue
      }
      const bucket = gitBuckets.get(repository.key) || { repository, packages: [], sources: [] }
      bucket.sources.push(source)
      gitBuckets.set(repository.key, bucket)
    }

    for (const { repository, packages, sources } of gitBuckets.values()) {
      const packageIds = new Set(packages.map((pkg) => pkg.id))
      const installations = (entry.installations || []).filter((item) => packageIds.has(item.packageId))
      const slicedEntry = sliceCatalogEntry(entry, packages, installations, sources)
      if (matchesCatalogStatus(slicedEntry, status)) {
        ensureGroup({ ...repository, kind: repository.key.split(':', 1)[0] }).entries.push(slicedEntry)
      }
    }

    const otherPackageIds = new Set(otherPackages.map((pkg) => pkg.id))
    const otherInstallations = (entry.installations || []).filter((item) => otherPackageIds.has(item.packageId))
    if (otherPackages.length || otherInstallations.length || otherSources.length) {
      const slicedEntry = sliceCatalogEntry(entry, otherPackages, otherInstallations, otherSources)
      if (matchesCatalogStatus(slicedEntry, status)) {
        ensureGroup({ key: 'other', kind: 'other', label: '其他来源', repositoryUrl: null }).entries.push(slicedEntry)
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({ ...group, entries: group.entries.sort((left, right) => left.name.localeCompare(right.name)) }))
    .sort((left, right) => {
      if (left.kind === 'other') return 1
      if (right.kind === 'other') return -1
      return left.label.localeCompare(right.label)
    })
}

export function skillStatusPresentation(status) {
  return STATUSES[status] || { label: '未知状态', color: 'default' }
}

export function skillOriginLabel(origin) {
  return ORIGINS[origin] || '未知来源'
}

export function skillSourceKindLabel(sourceKind) {
  return SOURCE_KINDS[sourceKind] || '其他来源'
}

export function skillCliName(adapterId) {
  return CLI_NAMES[adapterId] || adapterId || '未知 CLI'
}

export function skillVisibilitySummary(visibility = {}) {
  if (visibility.direct) return '直接投放'
  if (visibility.inheritedFrom?.length) {
    return `从 ${visibility.inheritedFrom.map(skillCliName).join('、')} 兼容继承`
  }
  return '不可见'
}

export function skillSourceLabel(pkg = {}) {
  if (pkg.sourceType === 'github') return 'GitHub'
  if (pkg.sourceType === 'gitlab') return 'GitLab'
  if (pkg.sourceType === 'zip') return '本地 ZIP'
  if (pkg.sourceType === 'adopted') return '接管现有 Skill'
  return '本地目录'
}

function normaliseScopePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function resolveSkillInstallPreflight(preview = {}, options = {}) {
  const scopeType = options.scopeType || 'user'
  const projectPath = normaliseScopePath(options.projectPath)
  const matches = (preview.installedMatches || []).filter((match) =>
    (match.installations || []).some((installation) => {
      if (installation.scopeType !== scopeType) return false
      if (scopeType === 'user') return true
      return normaliseScopePath(installation.scopeKey) === projectPath
    })
  )
  const reusable = matches.find((match) =>
    match.matchType === 'same_source_and_content' || match.matchType === 'same_content'
  )
  if (reusable) {
    return {
      kind: 'already_installed',
      match: reusable,
      missingAdapterIds: [...new Set(options.targetAdapterIds || [])]
        .filter((adapterId) => !reusable.visibility?.[adapterId]?.visible)
    }
  }
  const changed = matches.find((match) => match.matchType === 'same_source_changed')
  if (changed) return { kind: 'source_changed', match: changed, missingAdapterIds: [] }
  const targetMatches = preview.targetMatches || []
  if (targetMatches.some((item) => item.matchType === 'conflict' || item.matchType === 'invalid')) {
    return { kind: 'target_conflict', match: null, missingAdapterIds: [], targetMatches }
  }
  if (targetMatches.some((item) => item.matchType === 'same_content')) {
    return { kind: 'existing_target', match: null, missingAdapterIds: [], targetMatches }
  }
  return { kind: 'new_install', match: null, missingAdapterIds: [], targetMatches: [] }
}
