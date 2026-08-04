const DEFAULT_PROVIDER = 'openai'

/** Determine whether UCLI should pass `-c model_provider=...` to Codex.
 * Live policy deliberately omits it so CC Switch and Codex config changes take
 * effect without changing the UCLI session. */
export function resolveCodexProviderPolicy({ policy, sourceProvider, explicitProvider, runtime = {} } = {}) {
  const available = new Set(
    (runtime.availableProviders || [DEFAULT_PROVIDER]).filter(isSafeProviderName)
  )
  available.add(DEFAULT_PROVIDER)
  const liveProvider = available.has(runtime.currentProvider)
    ? runtime.currentProvider
    : DEFAULT_PROVIDER

  if (policy === 'source') {
    if (isSafeProviderName(sourceProvider) && available.has(sourceProvider)) {
      return { providerOverride: sourceProvider, effectiveProvider: sourceProvider, warning: null }
    }
    return {
      providerOverride: liveProvider,
      effectiveProvider: liveProvider,
      warning: 'source_provider_unavailable'
    }
  }

  if (policy === 'explicit') {
    if (isSafeProviderName(explicitProvider) && available.has(explicitProvider)) {
      return { providerOverride: explicitProvider, effectiveProvider: explicitProvider, warning: null }
    }
    return {
      providerOverride: null,
      effectiveProvider: null,
      warning: 'explicit_provider_unavailable',
      canStart: false
    }
  }

  return { providerOverride: null, effectiveProvider: liveProvider, warning: null }
}

/** Keep the provider displayed for an active PTY truthful. New runtime config
 * is stored as pending until the user explicitly restarts that session. */
export function reconcileCodexRuntimeProvider({ session = {}, resolved = {}, isActive = false } = {}) {
  const canStart = resolved.canStart !== false
  const runtimeRevision = resolved.runtimeRevision || null
  if (!isActive) {
    return {
      provider: resolved.effectiveProvider || null,
      providerOverride: resolved.providerOverride || null,
      providerWarning: resolved.warning || null,
      runtimeRevision,
      pendingProvider: null,
      pendingProviderOverride: null,
      pendingProviderWarning: null,
      pendingRuntimeRevision: null,
      restartRequired: false,
      canStart
    }
  }

  const restartRequired = session.provider !== (resolved.effectiveProvider || null) ||
    session.providerOverride !== (resolved.providerOverride || null) ||
    session.providerWarning !== (resolved.warning || null) ||
    session.runtimeRevision !== runtimeRevision
  return {
    provider: session.provider || null,
    providerOverride: session.providerOverride || null,
    providerWarning: session.providerWarning || null,
    runtimeRevision: session.runtimeRevision || null,
    pendingProvider: restartRequired ? (resolved.effectiveProvider || null) : null,
    pendingProviderOverride: restartRequired ? (resolved.providerOverride || null) : null,
    pendingProviderWarning: restartRequired ? (resolved.warning || null) : null,
    pendingRuntimeRevision: restartRequired ? runtimeRevision : null,
    restartRequired,
    canStart
  }
}

/** A pending runtime revision means the existing PTY was started against a
 * different Codex home/configuration and cannot safely execute `/resume`. */
export function requiresCodexProcessRestart(session = {}) {
  return session.canStart === false || session.restartRequired === true
}

export function normaliseCodexProviderPolicy(policy, { imported = false } = {}) {
  if (policy === 'source' || policy === 'live' || policy === 'explicit') return policy
  return imported ? 'source' : 'live'
}

function isSafeProviderName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value)
}
