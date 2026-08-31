import {
  buildServiceProfileCatalog,
  requireServiceModel,
  SERVICE_ADAPTER_PROTOCOL,
  serviceModelArtifactId
} from './serviceProfileCatalog.js'

const SERVER_STATUSES = new Set(['ready', 'unreachable', 'disabled', 'expired', 'deleted'])

function projectionError(code, message) {
  return Object.assign(new Error(message), { code })
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.connectionId === right.connectionId &&
    left.connectionRevision === right.connectionRevision)
}

function serviceProfileDto(profile, models, online) {
  const durableStatus = SERVER_STATUSES.has(profile.availabilityStatus) ? profile.availabilityStatus : 'unreachable'
  const status = durableStatus === 'ready' && !online ? 'unreachable' : durableStatus
  const catalog = buildServiceProfileCatalog({
    serverOrigin: profile.serverOrigin,
    organization: { id: profile.organizationId, name: profile.organizationName },
    models: models.map((model) => ({
      id: model.modelId,
      displayName: model.displayName,
      contextSize: model.contextSize,
      protocols: model.protocols
    })),
    connectionRevision: profile.connectionRevision
  })
  return {
    id: catalog.profile.id,
    name: profile.organizationName,
    kind: 'managed',
    sourceKind: 'server',
    readOnly: true,
    organizationName: profile.organizationName,
    connectionRevision: profile.connectionRevision,
    supportedAdapterIds: [...catalog.profile.supportedAdapterIds],
    models: catalog.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      contextSize: model.contextSize,
      protocols: [...model.protocols],
      artifactId: model.artifactId
    })),
    serverStatus: status,
    status,
    canStart: status === 'ready'
  }
}

export function createServerModelProjection({
  db,
  proxy,
  codexProfileFiles = {},
  resolveCodexHome = null,
  getRuntimeConnectionIdentity = () => proxy?.getRuntimeConnectionIdentity?.() || null,
  flush = () => db.flush?.() ?? true
} = {}) {
  if (!db || typeof db.listServerServiceProfiles !== 'function' ||
    typeof db.listServerServiceModels !== 'function' ||
    typeof db.updateServerServiceModelArtifact !== 'function') {
    throw new TypeError('A server service catalog database is required')
  }

  const sessions = new Map()
  let onlineIdentity = null

  function storedProfiles() {
    return db.listServerServiceProfiles().map((profile) => ({ ...profile }))
  }

  function storedProfile(serviceProfileId) {
    return storedProfiles().find((profile) => profile.profileId === serviceProfileId) || null
  }

  function storedModels(serviceProfileId) {
    return db.listServerServiceModels(serviceProfileId).map((model) => ({
      ...model,
      protocols: Array.isArray(model.protocols) ? [...model.protocols] : []
    }))
  }

  function currentIdentity(profile) {
    const identity = getRuntimeConnectionIdentity()
    if (!identity || identity.connectionRevision !== profile.connectionRevision ||
      typeof identity.connectionId !== 'string' || !identity.connectionId) return null
    return identity
  }

  function isOnline(profile) {
    return profile.availabilityStatus === 'ready' && sameIdentity(onlineIdentity, currentIdentity(profile))
  }

  async function persistOrThrow() {
    try {
      if (await flush() === false) throw new Error('flush failed')
    } catch {
      throw projectionError('PROFILE_PERSISTENCE_PENDING', 'Server profile changes are pending persistence')
    }
  }

  function persistDigestOrThrow() {
    try {
      const result = flush()
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new Error('asynchronous flush is not permitted for runtime issuance')
      }
      if (result !== true) throw new Error('flush failed')
    } catch {
      invalidateOnlineState()
      throw projectionError('PROFILE_PERSISTENCE_PENDING', 'Server profile changes are pending persistence')
    }
  }

  function revoke(sessionId) {
    if (!sessions.has(sessionId)) return false
    sessions.delete(sessionId)
    const revokeSession = proxy?.revokeSession || proxy?.revokeServerGatewaySession
    revokeSession?.(sessionId)
    return true
  }

  function invalidateOnlineState() {
    onlineIdentity = null
    for (const sessionId of [...sessions.keys()]) revoke(sessionId)
  }

  function runtimeCatalog(profile, models) {
    return buildServiceProfileCatalog({
      serverOrigin: profile.serverOrigin,
      organization: { id: profile.organizationId, name: profile.organizationName },
      models: models.map((model) => ({
        id: model.id ?? model.modelId,
        displayName: model.displayName,
        contextSize: model.contextSize,
        protocols: model.protocols
      })),
      connectionRevision: profile.connectionRevision
    })
  }

  function cleanStaleCodexFiles(catalog) {
    if (!resolveCodexHome || typeof codexProfileFiles.cleanStaleServerCodexProfileFiles !== 'function') return
    const validArtifactIds = new Set(catalog.models
      .filter((model) => model.protocols.includes(SERVICE_ADAPTER_PROTOCOL.codex))
      .map((model) => model.artifactId))
    codexProfileFiles.cleanStaleServerCodexProfileFiles({
      codexHome: resolveCodexHome(),
      validArtifactIds
    })
  }

  function ensureCurrentAuthority(sessionId, runtime, catalog, identity) {
    if (runtime.serviceProfileId !== catalog.profile.id) {
      revoke(sessionId)
      return
    }
    const profile = storedProfile(runtime.serviceProfileId)
    if (!profile || profile.connectionRevision !== runtime.connectionRevision ||
      profile.availabilityStatus !== 'ready' || !sameIdentity(identity, currentIdentity(profile))) {
      revoke(sessionId)
      return
    }
    try {
      requireServiceModel(catalog, { adapterId: runtime.adapterId, modelId: runtime.modelId })
    } catch {
      revoke(sessionId)
    }
  }

  return {
    listProfiles() {
      return storedProfiles().map((profile) => serviceProfileDto(profile, storedModels(profile.profileId), isOnline(profile)))
    },

    async reconcileRuntimeAuthorities({ serviceProfileId, connectionRevision, models } = {}) {
      const profile = storedProfile(serviceProfileId)
      if (!profile || profile.connectionRevision !== connectionRevision || !Array.isArray(models)) {
        invalidateOnlineState()
        return this.listProfiles()
      }
      const catalog = runtimeCatalog(profile, models)
      if (catalog.profile.id !== serviceProfileId) {
        invalidateOnlineState()
        return this.listProfiles()
      }
      const identity = currentIdentity(profile)
      const previousOnlineIdentity = onlineIdentity
      onlineIdentity = null
      if (!identity) {
        invalidateOnlineState()
        return this.listProfiles()
      }
      if (!previousOnlineIdentity || previousOnlineIdentity.connectionRevision !== identity.connectionRevision) {
        for (const sessionId of [...sessions.keys()]) revoke(sessionId)
      } else {
        for (const [sessionId, runtime] of sessions) ensureCurrentAuthority(sessionId, runtime, catalog, identity)
      }
      try {
        await persistOrThrow()
      } catch (error) {
        invalidateOnlineState()
        throw error
      }
      cleanStaleCodexFiles(catalog)
      if (!sameIdentity(identity, currentIdentity(profile))) {
        invalidateOnlineState()
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      onlineIdentity = Object.freeze({ ...identity })
      return this.listProfiles()
    },

    prepareRuntime({ serviceProfileId, modelId, adapterId, sessionId } = {}) {
      const profile = storedProfile(serviceProfileId)
      if (!profile || !isOnline(profile)) {
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      if (typeof sessionId !== 'string' || !sessionId) {
        throw projectionError('PROFILE_NOT_READY', 'Server profile session is invalid')
      }
      const models = storedModels(serviceProfileId)
      const catalog = runtimeCatalog(profile, models)
      const model = requireServiceModel(catalog, { adapterId, modelId })
      const identity = currentIdentity(profile)
      const createSession = proxy?.createSession || proxy?.createServerGatewaySession
      if (!identity || typeof createSession !== 'function') {
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      revoke(sessionId)
      const issued = createSession({ sessionId, ...identity })
      if (!issued || typeof issued.baseUrl !== 'string' || typeof issued.bearer !== 'string' || !issued.bearer) {
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      const artifactId = serviceModelArtifactId({ serviceProfileId, modelId: model.id })
      try {
        if (adapterId === 'codex') {
          if (!resolveCodexHome || typeof codexProfileFiles.writeServerCodexProfileFileAtomic !== 'function') {
            throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
          }
          const envName = codexProfileFiles.serverCodexProfileSecretEnvName?.(artifactId) || 'UCLI_SERVER_BEARER'
          const written = codexProfileFiles.writeServerCodexProfileFileAtomic({
            codexHome: resolveCodexHome(),
            profile: { id: artifactId, name: model.displayName, model: model.id, contextWindow: model.contextSize },
            baseUrl: issued.baseUrl,
            envKey: envName
          })
          db.updateServerServiceModelArtifact({
            serviceProfileId,
            modelId: model.id,
            codexFileSha256: written.sha256
          })
          persistDigestOrThrow()
          if (!sameIdentity(identity, currentIdentity(profile))) {
            throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
          }
          sessions.set(sessionId, Object.freeze({
            serviceProfileId,
            modelId: model.id,
            adapterId,
            connectionRevision: profile.connectionRevision
          }))
          const nativeProfileName = codexProfileFiles.serverCodexNativeProfileName?.(artifactId) || `ucli-server-${artifactId}`
          return {
            args: ['--profile', nativeProfileName, '--model', model.id],
            env: { [envName]: issued.bearer },
            artifact: { nativeProfileName, model: model.id, providerId: `ucli_server_${artifactId.slice(0, 12)}` },
            artifactId,
            configPath: written.path,
            modelId: model.id,
            status: 'ready',
            runtimeRevision: `${profile.connectionRevision}:${serviceProfileId}:${model.id}:${adapterId}`
          }
        }
        if (adapterId !== 'claude' || SERVICE_ADAPTER_PROTOCOL[adapterId] !== 'anthropic_messages' ||
          !sameIdentity(identity, currentIdentity(profile))) {
          throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
        }
        sessions.set(sessionId, Object.freeze({
          serviceProfileId,
          modelId: model.id,
          adapterId,
          connectionRevision: profile.connectionRevision
        }))
        return {
          args: ['--model', model.id],
          env: {
            ANTHROPIC_AUTH_TOKEN: issued.bearer,
            ANTHROPIC_BASE_URL: `${issued.baseUrl.replace(/\/$/, '')}/anthropic`,
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
          },
          settingSources: ['project', 'local'],
          artifact: { model: model.id, connectionMode: 'bearer' },
          modelId: model.id,
          status: 'ready',
          runtimeRevision: `${profile.connectionRevision}:${serviceProfileId}:${model.id}:${adapterId}`
        }
      } catch (error) {
        const revokeSession = proxy?.revokeSession || proxy?.revokeServerGatewaySession
        revokeSession?.(sessionId)
        throw error
      }
    },

    releaseRuntime(sessionId) {
      return revoke(sessionId)
    },

    async clearOnlineState() {
      invalidateOnlineState()
      return this.listProfiles()
    }
  }
}
