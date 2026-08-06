import { sanitiseProfileError } from './contracts.js'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
const ADAPTER_IDS = new Set(['codex', 'claude', 'opencode', 'ucode'])
const PROFILE_STATUSES = new Set(['ready', 'missing_file', 'drifted', 'missing_provider', 'secret_unavailable', 'missing_profile'])
const PROFILE_FIELDS = [
  'adapterId', 'name', 'kind', 'providerId', 'baseUrl', 'model',
  'reasoningEffort', 'contextWindow', 'secret'
]
const PROFILE_PATCH_FIELDS = [
  'name', 'kind', 'providerId', 'baseUrl', 'model', 'reasoningEffort', 'contextWindow'
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
  return Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]))
}

function safeProfile(profile = {}) {
  return {
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

async function safeCall(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error?.code === 'INVALID_PROFILE_IPC') throw error
    const safe = sanitiseProfileError(error)
    throw Object.assign(new Error(safe.message), { code: safe.code })
  }
}

export function registerAiCliProfileIpc({ ipcMain, service, inspectCliTools, getCodexRuntime }) {
  ipcMain.handle('ai-cli-profiles:get-state', (_event, options = {}) => safeCall(async () => {
    if (options !== undefined) requireObject(options, 'options')
    const cwd = typeof options.cwd === 'string' && options.cwd.length <= 4096 && !options.cwd.includes('\0')
      ? options.cwd
      : undefined
    const [cliInventory] = await Promise.all([inspectCliTools()])
    return {
      cliConfiguration: service.listCliConfigurationState({ cwd }),
      cliInventory: cliInventory.map(safeInventory),
      profiles: service.listProfiles({ adapterId: 'codex' }).map(safeProfile),
      codexRuntime: safeRuntime(getCodexRuntime())
    }
  }))
  ipcMain.handle('ai-cli-profiles:create', (_event, draft) => safeCall(async () =>
    safeProfile(await service.createProfile(copyFields(draft, PROFILE_FIELDS)))
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
    if (!['app', 'project'].includes(value.scopeType)) throw ipcError('scopeType is invalid')
    if (value.scopeType === 'project' && (typeof value.scopeKey !== 'string' || !value.scopeKey || value.scopeKey.length > 4096 || value.scopeKey.includes('\0'))) {
      throw ipcError('scopeKey is invalid')
    }
    return service.setBinding({
      scopeType: value.scopeType,
      scopeKey: value.scopeType === 'app' ? '*' : value.scopeKey,
      adapterId: requireAdapterId(value.adapterId),
      profileId: value.profileId === null ? null : requireId(value.profileId, 'profileId')
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
