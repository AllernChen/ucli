import { sanitiseProfileError, validateProfileBaseUrl } from './contracts.js'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
const BINDING_PROFILE_ID_MAX_LENGTH = 1024
const ADAPTER_IDS = new Set(['codex', 'claude', 'opencode', 'ucode'])
const PROFILE_STATUSES = new Set(['ready', 'missing_file', 'drifted', 'missing_provider', 'secret_unavailable', 'missing_profile'])
const SERVER_AVAILABILITY_STATUSES = new Set(['ready', 'unreachable', 'disabled', 'expired', 'deleted'])
const SERVER_MODEL_PROTOCOLS = new Set(['openai_responses', 'openai_chat', 'anthropic_messages'])
const PROFILE_FIELDS = [
  'adapterId', 'name', 'kind', 'providerId', 'baseUrl', 'model',
  'reasoningEffort', 'contextWindow', 'secret'
]
const PROFILE_PATCH_FIELDS = [
  'name', 'kind', 'providerId', 'baseUrl', 'model', 'reasoningEffort', 'contextWindow',
  'connectionMode', 'secret'
]

function ipcError(message) {
  return Object.assign(new TypeError(message), { code: 'INVALID_PROFILE_IPC' })
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ipcError(`${field} must be an object`)
  }
  return value
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw ipcError(`${field} is invalid`)
  }
  return value
}

function requireBindingProfileId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > BINDING_PROFILE_ID_MAX_LENGTH || /[\0-\x1F\x7F]/.test(value)) {
    throw ipcError('profileId is invalid')
  }
  return value
}

function requireAdapterId(value) {
  if (!ADAPTER_IDS.has(value)) throw ipcError('adapterId is invalid')
  return value
}

function requireSecret(value) {
  if (typeof value !== 'string' || !value || value.length > 65_536 || value.includes('\0')) {
    throw ipcError('secret is invalid')
  }
  return value
}

function copyFields(value, fields) {
  const source = requireObject(value, 'profile')
  return Object.fromEntries(fields.map((field) => [field, source[field]]))
}

function copyDefinedFields(value, fields) {
  const source = requireObject(value, 'profile')
  const copy = Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]))
  if (copy.secret !== undefined) copy.secret = requireSecret(copy.secret)
  return copy
}

function copyProfileDraft(value) {
  const source = requireObject(value, 'profile')
  const draft = copyFields(source, PROFILE_FIELDS)
  if (draft.adapterId === 'claude') draft.connectionMode = source.connectionMode
  return draft
}

function safeClaudeConfig(config = {}) {
  const modes = new Set(['subscription', 'api_key', 'bearer'])
  const baseUrl = validateProfileBaseUrl(config.baseUrl)
  return {
    connectionMode: modes.has(config.connectionMode) ? config.connectionMode : 'subscription',
    baseUrl: baseUrl.ok ? baseUrl.value : null
  }
}

export function safeProfile(profile = {}) {
  if (profile.sourceKind === 'server') {
    return {
      id: typeof profile.id === 'string' ? profile.id : null,
      source: 'server',
      readOnly: true,
      serverOrigin: typeof profile.serverOrigin === 'string' ? profile.serverOrigin : null,
      organization: {
        id: typeof profile.organization?.id === 'string' ? profile.organization.id : null,
        name: typeof profile.organization?.name === 'string' ? profile.organization.name : ''
      },
      availabilityStatus: SERVER_AVAILABILITY_STATUSES.has(profile.availabilityStatus)
        ? profile.availabilityStatus
        : 'unreachable',
      status: SERVER_AVAILABILITY_STATUSES.has(profile.status) ? profile.status : 'unreachable',
      canStart: profile.canStart === true,
      supportedAdapterIds: Array.isArray(profile.supportedAdapterIds)
        ? profile.supportedAdapterIds.filter((adapterId) => ADAPTER_IDS.has(adapterId))
        : [],
      models: Array.isArray(profile.models)
        ? profile.models.map((model) => ({
            id: typeof model?.id === 'string' ? model.id : null,
            displayName: typeof model?.displayName === 'string' ? model.displayName : '',
            contextSize: Number.isSafeInteger(model?.contextSize) ? model.contextSize : null,
            protocols: Array.isArray(model?.protocols)
              ? model.protocols.filter((protocol) => SERVER_MODEL_PROTOCOLS.has(protocol))
              : [],
            availabilityStatus: SERVER_AVAILABILITY_STATUSES.has(model?.availabilityStatus)
              ? model.availabilityStatus
              : 'unreachable'
          }))
        : []
    }
  }
  const result = {
    id: typeof profile.id === 'string' ? profile.id : null,
    adapterId: typeof profile.adapterId === 'string' ? profile.adapterId : null,
    name: typeof profile.name === 'string' ? profile.name : '',
    kind: profile.kind === 'managed' ? 'managed' : 'reference',
    providerId: typeof profile.providerId === 'string' ? profile.providerId : null,
    baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : null,
    baseUrlDisplay: typeof profile.baseUrlDisplay === 'string' ? profile.baseUrlDisplay : null,
    model: typeof profile.model === 'string' ? profile.model : null,
    reasoningEffort: typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : null,
    contextWindow: Number.isSafeInteger(profile.contextWindow) ? profile.contextWindow : null,
    hasSecret: profile.hasSecret === true,
    secretSuffix: typeof profile.secretSuffix === 'string' ? profile.secretSuffix.slice(-4) : null,
    status: PROFILE_STATUSES.has(profile.status) ? profile.status : 'missing_profile',
    canStart: profile.canStart !== false,
    isAppDefault: profile.isAppDefault === true,
    isProjectDefault: profile.isProjectDefault === true,
    updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : null
  }
  if (result.adapterId === 'claude') {
    result.config = safeClaudeConfig(profile.config)
    result.connectionMode = result.config.connectionMode
  }
  return result
}

function safeRevision(revision = {}) {
  const config = revision.config && typeof revision.config === 'object' ? revision.config : {}
  return {
    id: typeof revision.id === 'string' ? revision.id : null,
    profileId: typeof revision.profileId === 'string' ? revision.profileId : null,
    reason: typeof revision.reason === 'string' ? revision.reason : 'update',
    createdAt: Number.isFinite(revision.createdAt) ? revision.createdAt : null,
    fileSha256: typeof revision.fileSha256 === 'string' ? revision.fileSha256 : null,
    config: Object.fromEntries([
      'adapterId', 'name', 'kind', 'nativeProfileName', 'providerId', 'baseUrl',
      'model', 'reasoningEffort', 'contextWindow'
    ].filter((field) => config[field] !== undefined).map((field) => [field, config[field]]))
  }
}

function safeInventory(tool = {}) {
  return {
    id: typeof tool.id === 'string' ? tool.id : '',
    displayName: typeof tool.displayName === 'string' ? tool.displayName : '',
    installed: tool.installed === true,
    version: typeof tool.version === 'string' ? tool.version : '',
    path: typeof tool.path === 'string' ? tool.path : ''
  }
}

function safeCliConfiguration(configuration = {}) {
  return {
    adapterId: ADAPTER_IDS.has(configuration.adapterId) ? configuration.adapterId : '',
    mode: configuration.mode === 'profiles' ? 'profiles' : 'system',
    profileCount: Number.isSafeInteger(configuration.profileCount) ? configuration.profileCount : 0,
    projectBinding: typeof configuration.projectBinding === 'string' ? configuration.projectBinding : null
  }
}

function safeRuntime(runtime = {}) {
  return {
    currentProvider: typeof runtime.currentProvider === 'string' ? runtime.currentProvider : 'openai',
    providerCatalog: Array.isArray(runtime.providerCatalog)
      ? runtime.providerCatalog
          .filter((provider) => provider && typeof provider.id === 'string')
          .map((provider) => ({
            id: provider.id,
            displayName: typeof provider.displayName === 'string' ? provider.displayName : provider.id
          }))
      : [],
    configPath: typeof runtime.configPath === 'string' ? runtime.configPath : '',
    revision: Number.isSafeInteger(runtime.revision) ? runtime.revision : 0
  }
}

function safeClaudeRuntime(runtime = {}) {
  const authModes = new Set(['api_key', 'bearer', 'cloud_provider', 'login_or_unknown'])
  return {
    configDir: typeof runtime.configDir === 'string' ? runtime.configDir : '',
    settingsMtimeMs: Number.isFinite(runtime.settingsMtimeMs) ? runtime.settingsMtimeMs : 0,
    inheritedAuthMode: authModes.has(runtime.inheritedAuthMode)
      ? runtime.inheritedAuthMode
      : 'login_or_unknown'
  }
}

async function safeCall(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error?.code === 'INVALID_PROFILE_IPC') throw error
    const safe = sanitiseProfileError(error)
    throw Object.assign(new Error(safe.message), { code: safe.code })
  }
}

export function registerAiCliProfileIpc({
  ipcMain,
  service,
  inspectCliTools,
  getCodexRuntime,
  getClaudeRuntime = () => ({})
}) {
  ipcMain.handle('ai-cli-profiles:get-state', (_event, options = {}) => safeCall(async () => {
    if (options !== undefined) requireObject(options, 'options')
    const cwd = typeof options.cwd === 'string' && options.cwd.length <= 4096 && !options.cwd.includes('\0')
      ? options.cwd
      : undefined
    const cliInventory = await inspectCliTools().catch(() => [])
    const cliConfiguration = service.listCliConfigurationState({ cwd }).map(safeCliConfiguration)
    const profileAdapters = cliConfiguration
      .filter((item) => item.mode === 'profiles')
      .map((item) => item.adapterId)
    const projectBindings = new Map(cliConfiguration.map((item) => [item.adapterId, item.projectBinding]))
    const profilesById = new Map()
    for (const adapterId of profileAdapters) {
      for (const profile of service.listProfiles({ adapterId })) {
        if (!profilesById.has(profile.id)) profilesById.set(profile.id, profile)
      }
    }
    for (const profile of service.listServiceProfiles()) {
      if (!profilesById.has(profile.id)) profilesById.set(profile.id, profile)
    }
    return {
      cliConfiguration,
      cliInventory: cliInventory.map(safeInventory),
      profiles: [...profilesById.values()].map(safeProfile).map((profile) => profile.source === 'server'
        ? profile
        : { ...profile, isProjectDefault: profile.id === projectBindings.get(profile.adapterId) }),
      codexRuntime: safeRuntime(getCodexRuntime()),
      claudeRuntime: safeClaudeRuntime(getClaudeRuntime())
    }
  }))
  ipcMain.handle('ai-cli-profiles:create', (_event, draft) => safeCall(async () =>
    safeProfile(await service.createProfile(copyProfileDraft(draft)))
  ))
  ipcMain.handle('ai-cli-profiles:update', (_event, profileId, patch) => safeCall(async () =>
    safeProfile(await service.updateProfile(requireId(profileId, 'profileId'), copyDefinedFields(patch, PROFILE_PATCH_FIELDS)))
  ))
  ipcMain.handle('ai-cli-profiles:set-secret', (_event, profileId, secret) => safeCall(async () =>
    safeProfile(await service.replaceProfileSecret(requireId(profileId, 'profileId'), requireSecret(secret)))
  ))
  ipcMain.handle('ai-cli-profiles:delete-secret', (_event, profileId) => safeCall(async () =>
    safeProfile(await service.deleteProfileSecret(requireId(profileId, 'profileId')))
  ))
  ipcMain.handle('ai-cli-profiles:delete', (_event, profileId) => safeCall(() =>
    service.deleteProfile(requireId(profileId, 'profileId'))
  ))
  ipcMain.handle('ai-cli-profiles:set-binding', (_event, binding) => safeCall(() => {
    const value = requireObject(binding, 'binding')
    const allowed = new Set(['scopeType', 'scopeKey', 'adapterId', 'profileId', 'model'])
    if (Object.keys(value).some((key) => !allowed.has(key))) throw ipcError('binding contains an unknown field')
    if (!['app', 'project'].includes(value.scopeType)) throw ipcError('scopeType is invalid')
    if (value.scopeType === 'project' && (typeof value.scopeKey !== 'string' || !value.scopeKey || value.scopeKey.length > 4096 || value.scopeKey.includes('\0'))) {
      throw ipcError('scopeKey is invalid')
    }
    return service.setBinding({
      scopeType: value.scopeType,
      scopeKey: value.scopeType === 'app' ? '*' : value.scopeKey,
      adapterId: requireAdapterId(value.adapterId),
      profileId: value.profileId === null ? null : requireBindingProfileId(value.profileId),
      model: value.model === undefined || value.model === null
        ? null
        : typeof value.model === 'string' && value.model.trim()
          ? value.model
          : (() => { throw ipcError('model is invalid') })()
    })
  }))
  ipcMain.handle('ai-cli-profiles:list-revisions', (_event, profileId) => safeCall(() =>
    service.listRevisions(requireId(profileId, 'profileId')).map(safeRevision)
  ))
  ipcMain.handle('ai-cli-profiles:rollback', (_event, profileId, revisionId) => safeCall(async () =>
    safeProfile(await service.rollbackProfile(requireId(profileId, 'profileId'), requireId(revisionId, 'revisionId')))
  ))
  ipcMain.handle('ai-cli-profiles:repair', (_event, profileId) => safeCall(async () =>
    safeProfile(await service.repairProfile(requireId(profileId, 'profileId')))
  ))
  ipcMain.handle('ai-cli-profiles:reconcile', () => safeCall(async () => {
    const result = await service.reconcileCodexProfiles()
    return {
      recovered: Array.isArray(result?.recovered) ? result.recovered.filter((id) => typeof id === 'string') : [],
      warnings: Array.isArray(result?.warnings)
        ? result.warnings.map((warning) => ({ code: typeof warning?.code === 'string' ? warning.code : 'PROFILE_RECONCILE_WARNING' }))
        : []
    }
  }))
}
