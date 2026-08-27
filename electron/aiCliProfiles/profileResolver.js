import { resolve } from 'node:path'

function normaliseProjectScope(value) {
  const path = resolve(String(value || '.'))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function selectedProfile({ adapterId, profileId, selectionSource, profiles }) {
  if (!profileId) {
    return {
      profileId: null,
      profile: null,
      selectionSource,
      status: null,
      canStart: true
    }
  }
  const profile = profiles.find((candidate) => (
    candidate.id === profileId && candidate.adapterId === adapterId
  )) || null
  return {
    profileId,
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
  profiles = [],
  bindings = []
} = {}) {
  if (explicitProfileId) {
    return selectedProfile({
      adapterId,
      profileId: explicitProfileId,
      selectionSource: 'explicit',
      profiles
    })
  }
  if (imported) {
    return {
      profileId: null,
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
      selectionSource: 'app',
      profiles
    })
  }

  return selectedProfile({
    adapterId,
    profileId: null,
    selectionSource: 'system',
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
