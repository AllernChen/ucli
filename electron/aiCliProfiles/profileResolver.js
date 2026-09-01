import { resolve } from 'node:path'

import { SERVICE_ADAPTER_PROTOCOL } from '../serverConnection/serviceProfileCatalog.js'

function normaliseProjectScope(value) {
  const path = resolve(String(value || '.'))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function serviceModelSelection({ adapterId, model, profile }) {
  if (typeof model !== 'string' || !model) {
    return { status: 'model-required', canStart: false }
  }
  if (!profile.supportedAdapterIds?.includes(adapterId)) {
    return { status: 'protocol-unavailable', canStart: false }
  }
  const selectedModel = profile.models?.find((candidate) => candidate.id === model)
  if (!selectedModel || selectedModel.availabilityStatus && selectedModel.availabilityStatus !== 'ready') {
    return { status: 'model-unavailable', canStart: false }
  }
  if (!selectedModel.protocols?.includes(SERVICE_ADAPTER_PROTOCOL[adapterId])) {
    return { status: 'protocol-unavailable', canStart: false }
  }
  if (profile.canStart === false || ['unreachable', 'disabled', 'expired', 'deleted'].includes(profile.status || profile.serverStatus || profile.availabilityStatus)) {
    return { status: 'model-unavailable', canStart: false }
  }
  return { status: 'ready', canStart: true }
}

function selectedProfile({ adapterId, profileId, model = null, selectionSource, profiles }) {
  if (!profileId) {
    return {
      profileId: null,
      model: null,
      profile: null,
      selectionSource,
      status: 'ready',
      canStart: true
    }
  }
  const profile = profiles.find((candidate) => candidate.id === profileId && (
    candidate.sourceKind === 'server' || candidate.adapterId === adapterId
  )) || null
  if (profile?.sourceKind === 'server') {
    const resolution = serviceModelSelection({ adapterId, model, profile })
    return {
      profileId,
      model: typeof model === 'string' && model ? model : null,
      profile,
      selectionSource,
      ...resolution
    }
  }
  return {
    profileId,
    model: null,
    profile,
    selectionSource,
    status: profile ? (profile.status || profile.serverStatus || null) : 'missing_profile',
    canStart: Boolean(profile) && profile.canStart !== false
  }
}

export function resolveSessionProfile({
  adapterId,
  cwd,
  imported = false,
  explicitProfileId,
  explicitModel = null,
  profiles = [],
  bindings = []
} = {}) {
  if (explicitProfileId) {
    return selectedProfile({
      adapterId,
      profileId: explicitProfileId,
      model: explicitModel,
      selectionSource: 'explicit',
      profiles
    })
  }
  if (imported) {
    return {
      profileId: null,
      model: null,
      profile: null,
      selectionSource: 'history',
      status: null,
      canStart: true
    }
  }

  const adapterBindings = bindings.filter((binding) => binding.adapterId === adapterId)
  const projectKey = normaliseProjectScope(cwd)
  const projectBinding = adapterBindings.find((binding) => (
    binding.scopeType === 'project' && normaliseProjectScope(binding.scopeKey) === projectKey
  ))
  if (projectBinding) {
    return selectedProfile({
      adapterId,
      profileId: projectBinding.profileId,
      model: projectBinding.modelId || null,
      selectionSource: 'project',
      profiles
    })
  }

  const appBinding = adapterBindings.find((binding) => (
    binding.scopeType === 'app' && binding.scopeKey === '*'
  ))
  if (appBinding) {
    return selectedProfile({
      adapterId,
      profileId: appBinding.profileId,
      model: appBinding.modelId || null,
      selectionSource: 'app',
      profiles
    })
  }

  return selectedProfile({
    adapterId,
    profileId: null,
    selectionSource: 'none',
    profiles
  })
}

function runtimeResult(profile, status, canStart) {
  return {
    profileId: profile?.id || null,
    nativeProfileName: profile?.nativeProfileName || null,
    providerId: profile?.providerId || null,
    status,
    canStart,
    runtimeRevision: canStart ? (profile?.fileSha256 || profile?.connectionRevision || null) : null
  }
}

export function resolveCodexProfileRuntime({
  profile,
  runtime = {},
  fileState = {},
  secretState = {}
} = {}) {
  if (!profile) return runtimeResult(null, 'missing_profile', false)
  if (fileState.exists !== true) return runtimeResult(profile, 'missing_file', false)
  if (fileState.owned !== true || !profile.fileSha256 || fileState.sha256 !== profile.fileSha256) {
    return runtimeResult(profile, 'drifted', false)
  }

  if (profile.kind === 'reference') {
    const available = new Set(runtime.availableProviders || [])
    if (!available.has(profile.providerId)) {
      return runtimeResult(profile, 'missing_provider', false)
    }
    return runtimeResult(profile, 'ready', true)
  }

  if (profile.kind === 'managed') {
    if (secretState.hasSecret !== true || secretState.encryptionAvailable !== true || secretState.decryptionFailed) {
      return runtimeResult(profile, 'secret_unavailable', false)
    }
    return runtimeResult(profile, 'ready', true)
  }

  return runtimeResult(profile, 'missing_profile', false)
}

export function reconcileActiveProfile({ session = {}, resolved = {}, isActive = false } = {}) {
  const desiredProfileId = resolved.profileId || null
  const desiredRevision = resolved.runtimeRevision || null
  const canStart = resolved.canStart !== false
  if (!isActive) {
    return {
      profileId: desiredProfileId,
      activeProfileId: null,
      pendingProfileId: null,
      profileStatus: resolved.status || null,
      profileRuntimeRevision: desiredRevision,
      pendingProfileRuntimeRevision: null,
      restartRequired: false,
      canStart
    }
  }

  const activeProfileId = session.activeProfileId ?? session.profileId ?? null
  const activeRevision = session.profileRuntimeRevision || null
  const restartRequired = activeProfileId !== desiredProfileId || activeRevision !== desiredRevision
  return {
    profileId: desiredProfileId,
    activeProfileId,
    pendingProfileId: restartRequired ? desiredProfileId : null,
    profileStatus: resolved.status || null,
    profileRuntimeRevision: activeRevision,
    pendingProfileRuntimeRevision: restartRequired ? desiredRevision : null,
    restartRequired,
    canStart
  }
}
