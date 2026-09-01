const DEFAULT_TTL_MS = 5 * 60_000

function identityFor(state) {
  const connectionId = state?.connection?.id
  const connectionRevision = state?.connection?.connectionRevision
  const serverOrigin = state?.serverOrigin
  const organizationId = state?.organization?.id
  if (typeof connectionId !== 'string' || !connectionId || !Number.isSafeInteger(connectionRevision) ||
    typeof serverOrigin !== 'string' || !serverOrigin || typeof organizationId !== 'string' || !organizationId) return null
  return { connectionId, connectionRevision, serverOrigin, organizationId }
}

function identityKey(identity) {
  return `${identity.serverOrigin}\u0000${identity.organizationId}\u0000${identity.connectionId}\u0000${identity.connectionRevision}`
}

function sameIdentity(left, right) {
  return Boolean(left && right && identityKey(left) === identityKey(right))
}

function publicState(state) {
  return {
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    catalogRevision: state.catalogRevision,
    error: state.error ? { ...state.error } : null
  }
}

function safeError() {
  return {
    code: 'SERVER_SKILL_SYNC_FAILED',
    message: 'Organization Skills catalog could not be synchronized',
    retryable: true
  }
}

export function createOrganizationSkillsSyncCoordinator({
  connectionManager,
  catalog,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  onChanged = () => {}
} = {}) {
  if (!connectionManager?.getState || typeof catalog?.sync !== 'function' || typeof now !== 'function' ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 0 || typeof onChanged !== 'function') {
    throw new TypeError('Organization Skills sync coordinator dependencies are required')
  }

  let activeIdentity = null
  let activeStatus = 'disconnected'
  let generation = 0
  let closing = false
  const flights = new Map()
  const state = { status: 'idle', lastSyncedAt: null, catalogRevision: 0, error: null }

  const currentIdentity = () => identityFor(connectionManager.getState())
  const canSync = () => ['connected', 'expiring'].includes(activeStatus)
  const isCurrent = (identity, expectedGeneration) => !closing && expectedGeneration === generation &&
    sameIdentity(activeIdentity, identity) && sameIdentity(currentIdentity(), identity)

  function updateConnectionState(nextState) {
    const nextIdentity = identityFor(nextState)
    activeStatus = typeof nextState?.status === 'string' ? nextState.status : 'disconnected'
    if (activeStatus === 'disconnected' || !nextIdentity) {
      if (activeIdentity || state.status !== 'idle') generation += 1
      activeIdentity = null
      state.status = 'idle'
      state.lastSyncedAt = null
      state.catalogRevision = 0
      state.error = null
      return false
    }
    if (!sameIdentity(activeIdentity, nextIdentity)) {
      generation += 1
      activeIdentity = nextIdentity
      state.status = 'loading_cache'
      state.lastSyncedAt = null
      state.catalogRevision = 0
      state.error = null
      return true
    }
    if (activeStatus === 'unreachable' && state.status !== 'idle') state.status = 'stale'
    return false
  }

  function getState() {
    return publicState(state)
  }

  async function ensureFresh({ force = false } = {}) {
    updateConnectionState(connectionManager.getState())
    if (!activeIdentity || !canSync() || closing) return getState()
    const identity = activeIdentity
    const key = identityKey(identity)
    const age = state.lastSyncedAt === null ? Infinity : now() - state.lastSyncedAt
    if (!force && state.status === 'ready' && age <= ttlMs) return getState()
    if (flights.has(key)) return flights.get(key)

    const expectedGeneration = generation
    state.status = 'syncing'
    state.error = null
    let retryCurrentIdentity = false
    const work = (async () => {
      try {
        await catalog.sync()
        if (!isCurrent(identity, expectedGeneration)) return getState()
        state.status = 'ready'
        state.lastSyncedAt = now()
        state.catalogRevision += 1
        state.error = null
        onChanged({
          connectionId: identity.connectionId,
          connectionRevision: identity.connectionRevision,
          catalogRevision: state.catalogRevision,
          lastSyncedAt: state.lastSyncedAt,
          status: 'ready'
        })
      } catch (error) {
        if (isCurrent(identity, expectedGeneration)) {
          if (error?.code === 'SERVER_SKILL_STALE') {
            state.status = 'stale'
            retryCurrentIdentity = true
          } else {
            state.status = 'error'
            state.error = safeError()
          }
        }
      }
      return getState()
    })()
    const flight = work.finally(() => {
      if (flights.get(key) === flight) flights.delete(key)
      if (retryCurrentIdentity && isCurrent(identity, expectedGeneration)) {
        void ensureFresh({ force: true }).catch(() => {})
      }
    })
    flights.set(key, flight)
    return flight
  }

  function handleConnectionState(nextState) {
    updateConnectionState(nextState)
    if (canSync() && activeIdentity && !closing) void ensureFresh().catch(() => {})
    return getState()
  }

  async function shutdown() {
    if (closing) return
    closing = true
    generation += 1
    activeIdentity = null
    state.status = 'idle'
    state.error = null
    await catalog.shutdown?.()
    await Promise.allSettled([...flights.values()])
  }

  return { getState, ensureFresh, handleConnectionState, shutdown }
}
