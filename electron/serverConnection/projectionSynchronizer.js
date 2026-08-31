function connectionGeneration(manager) {
  const state = manager?.getState?.() || {}
  const runtime = manager?.getRuntimeConnectionIdentity?.()
  const connection = state.connection || {}
  const organization = state.organization || connection.organization || null
  return Object.freeze({
    status: state.status || 'disconnected',
    reason: state.reason || null,
    connectionId: runtime?.connectionId || connection.id || null,
    connectionRevision: runtime?.connectionRevision ?? connection.connectionRevision ?? null,
    serverOrigin: state.serverOrigin || connection.serverOrigin || null,
    organizationId: organization?.id || null,
    organizationName: organization?.name || null,
    online: Boolean(runtime && ['connected', 'expiring'].includes(state.status))
  })
}

function sameGeneration(left, right) {
  return Boolean(left && right &&
    left.status === right.status &&
    left.reason === right.reason &&
    left.connectionId === right.connectionId &&
    left.connectionRevision === right.connectionRevision &&
    left.serverOrigin === right.serverOrigin &&
    left.organizationId === right.organizationId &&
    left.organizationName === right.organizationName &&
    left.online === right.online)
}

function unavailableStatus(generation) {
  if (generation.status === 'disabled') return 'disabled'
  if (generation.status === 'expired') return 'expired'
  if (generation.reason === 'grant_deleted') return 'deleted'
  return 'unreachable'
}

/** Serializes catalog projections and makes every side effect conditional on the
 * exact connection generation that requested it.  Callers receive the task's
 * own result; the internal tail always recovers so a failure cannot deadlock a
 * later generation. */
export function createServerModelProjectionSynchronizer({
  manager,
  projection,
  db,
  buildCatalog,
  refreshSessionRuntimes = () => {}
} = {}) {
  if (!manager || !projection || !db || typeof buildCatalog !== 'function') {
    throw new TypeError('Projection synchronizer dependencies are required')
  }

  let tail = Promise.resolve()
  const isCurrent = generation => sameGeneration(generation, connectionGeneration(manager))

  async function clearIfCurrent(generation, status = undefined) {
    if (!isCurrent(generation)) return false
    await projection.clearOnlineState(generation.connectionRevision, status)
    return isCurrent(generation)
  }

  function publishIfCurrent(generation) {
    if (!isCurrent(generation)) return false
    refreshSessionRuntimes()
    return isCurrent(generation)
  }

  function sync() {
    const task = tail.then(async () => {
      // State and runtime identity are intentionally acquired only after this
      // task reaches the serialized queue; never combine a caller's old state
      // with a newer runtime identity.
      const generation = connectionGeneration(manager)
      if (!generation.online) {
        if (await clearIfCurrent(generation, unavailableStatus(generation))) publishIfCurrent(generation)
        return []
      }

      try {
        const bootstrap = await manager.getBootstrap()
        if (!isCurrent(generation)) return []
        const catalog = buildCatalog({
          serverOrigin: generation.serverOrigin,
          organization: bootstrap.organization,
          models: bootstrap.models,
          connectionRevision: generation.connectionRevision
        })
        if (!isCurrent(generation)) return []
        db.replaceServerServiceCatalog({
          profile: { ...catalog.profile, availabilityStatus: 'ready' },
          models: catalog.models.map((model) => ({ ...model, availabilityStatus: 'ready' }))
        })
        if (!isCurrent(generation)) return []
        const profiles = await projection.reconcileRuntimeAuthorities({
          serviceProfileId: catalog.profile.id,
          connectionRevision: generation.connectionRevision,
          models: bootstrap.models
        })
        if (!isCurrent(generation)) return []
        publishIfCurrent(generation)
        return profiles
      } catch (error) {
        // A stale failure must never clear or publish over a replacement.
        if (!isCurrent(generation)) return []
        await clearIfCurrent(generation)
        if (!isCurrent(generation)) return []
        publishIfCurrent(generation)
        throw error
      }
    })
    tail = task.catch(() => {})
    return task
  }

  return Object.freeze({ sync })
}
