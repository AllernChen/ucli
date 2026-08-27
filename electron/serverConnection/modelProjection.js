import { createHash } from 'node:crypto'

const SERVER_STATUSES = new Set(['ready', 'unreachable', 'disabled', 'expired', 'deleted'])

function projectionError(code, message) {
  return Object.assign(new Error(message), { code })
}

function canonicalOrigin(value) {
  let parsed
  try { parsed = new URL(String(value || '')) } catch {
    throw projectionError('INVALID_SERVER_ORIGIN', 'Server origin is invalid')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw projectionError('INVALID_SERVER_ORIGIN', 'Server origin is invalid')
  }
  return parsed.origin
}

function stableProfileId({ serverOrigin, organizationId, modelId, adapterId }) {
  return createHash('sha256')
    .update(`ucli-server-model-profile\u0000${serverOrigin}\u0000${organizationId}\u0000${modelId}\u0000${adapterId}`)
    .digest('hex')
    .slice(0, 32)
}

function safeModel(model = {}) {
  const id = String(model.id || '').trim()
  const displayName = String(model.displayName || '').trim()
  const contextSize = Number(model.contextSize)
  if (!id || !displayName || !Number.isSafeInteger(contextSize) || contextSize <= 0) {
    throw projectionError('INVALID_SERVER_MODEL', 'Server model is invalid')
  }
  return { id, displayName, contextSize }
}

function safeOrganization(organization = {}) {
  const id = String(organization.id || '').trim()
  const name = String(organization.name || '').trim()
  if (!id || !name) throw projectionError('INVALID_SERVER_MODEL', 'Server organization is invalid')
  return { id, name }
}

function asDto(profile) {
  return {
    id: profile.profileId,
    adapterId: profile.adapterId,
    name: profile.displayName,
    kind: 'managed',
    nativeProfileName: profile.adapterId === 'codex' ? `ucli-server-${profile.profileId}` : null,
    providerId: profile.adapterId === 'codex' ? `ucli_server_${profile.profileId.slice(0, 12)}` : 'anthropic-bearer',
    baseUrl: null,
    model: profile.modelId,
    reasoningEffort: null,
    contextWindow: profile.contextSize,
    config: profile.adapterId === 'codex'
      ? { wireApi: 'responses' }
      : { connectionMode: 'bearer', baseUrl: null },
    sourceKind: 'server',
    readOnly: true,
    organizationName: profile.organizationName,
    serverStatus: SERVER_STATUSES.has(profile.availabilityStatus) ? profile.availabilityStatus : 'unreachable',
    connectionRevision: profile.connectionRevision,
    hasSecret: false,
    secretSuffix: null,
    status: SERVER_STATUSES.has(profile.availabilityStatus) ? profile.availabilityStatus : 'unreachable',
    canStart: profile.availabilityStatus === 'ready',
    isAppDefault: false,
    isProjectDefault: false,
    updatedAt: null
  }
}

function profileRows({ serverOrigin, organization, models, connectionRevision }) {
  const origin = canonicalOrigin(serverOrigin)
  const org = safeOrganization(organization)
  if (!Number.isSafeInteger(connectionRevision) || connectionRevision < 0) {
    throw projectionError('INVALID_SERVER_MODEL', 'Connection revision is invalid')
  }
  const rows = []
  for (const model of models || []) {
    const safe = safeModel(model)
    for (const adapterId of ['codex', 'claude']) {
      rows.push({
        profileId: stableProfileId({ serverOrigin: origin, organizationId: org.id, modelId: safe.id, adapterId }),
        serverOrigin: origin,
        organizationId: org.id,
        organizationName: org.name,
        modelId: safe.id,
        adapterId,
        displayName: safe.displayName,
        contextSize: safe.contextSize,
        connectionRevision,
        availabilityStatus: 'ready',
        codexFileSha256: null
      })
    }
  }
  return rows
}

export function createServerModelProjection({
  db,
  proxy,
  codexProfileFiles = {},
  resolveCodexHome = null,
  getRuntimeConnectionIdentity = () => proxy?.getRuntimeConnectionIdentity?.() || null
} = {}) {
  if (!db || typeof db.listServerModelProfiles !== 'function' ||
    typeof db.replaceServerModelProfiles !== 'function') {
    throw new TypeError('A server model profile database is required')
  }
  const sessions = new Map()
  let onlineRevision = null

  function stored() { return db.listServerModelProfiles().map(profile => ({ ...profile })) }
  function find(profileId) { return stored().find(profile => profile.profileId === profileId) || null }
  function currentIdentity(profile) {
    const identity = getRuntimeConnectionIdentity()
    if (!identity || identity.connectionRevision !== profile.connectionRevision ||
      typeof identity.connectionId !== 'string' || !identity.connectionId) return null
    return identity
  }
  function revoke(sessionId) {
    if (!sessions.has(sessionId)) return false
    sessions.delete(sessionId)
    const revokeSession = proxy?.revokeSession || proxy?.revokeServerGatewaySession
    revokeSession?.(sessionId)
    return true
  }

  return {
    reconcile(input) {
      const profiles = profileRows(input)
      onlineRevision = input.connectionRevision
      db.replaceServerModelProfiles({ connectionRevision: input.connectionRevision, profiles })
      return profiles.map(asDto)
    },

    listProfiles() {
      return stored().map(asDto)
    },

    prepareRuntime({ profileId, sessionId } = {}) {
      const profile = find(profileId)
      if (!profile || profile.availabilityStatus !== 'ready' || onlineRevision !== profile.connectionRevision) {
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      if (typeof sessionId !== 'string' || !sessionId) {
        throw projectionError('PROFILE_NOT_READY', 'Server profile session is invalid')
      }
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
      try {
        const dto = asDto(profile)
        const envName = profile.adapterId === 'codex'
          ? (codexProfileFiles.serverCodexProfileSecretEnvName?.(profile.profileId) || 'UCLI_SERVER_BEARER')
          : 'ANTHROPIC_AUTH_TOKEN'
        if (profile.adapterId === 'codex') {
          if (typeof codexProfileFiles.writeServerCodexProfileFileAtomic === 'function' && resolveCodexHome) {
            codexProfileFiles.writeServerCodexProfileFileAtomic({
              codexHome: resolveCodexHome(), profile: dto, baseUrl: issued.baseUrl, envKey: envName
            })
          }
          if (!currentIdentity(profile) || currentIdentity(profile).connectionId !== identity.connectionId) {
            throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
          }
          sessions.set(sessionId, { profileId, connectionRevision: identity.connectionRevision })
          return {
            args: ['--profile', dto.nativeProfileName],
            env: { [envName]: issued.bearer },
            artifact: { nativeProfileName: dto.nativeProfileName, model: dto.model, providerId: dto.providerId },
            status: 'ready',
            runtimeRevision: `${profile.connectionRevision}:${profile.profileId}`
          }
        }
        if (!currentIdentity(profile) || currentIdentity(profile).connectionId !== identity.connectionId) {
          throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
        }
        sessions.set(sessionId, { profileId, connectionRevision: identity.connectionRevision })
        return {
          args: dto.model ? ['--model', dto.model] : [],
          env: {
            [envName]: issued.bearer,
            ANTHROPIC_BASE_URL: issued.baseUrl,
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
          },
          settingSources: ['project', 'local'],
          artifact: { model: dto.model, connectionMode: 'bearer' },
          status: 'ready',
          runtimeRevision: `${profile.connectionRevision}:${profile.profileId}`
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

    clearOnlineState(connectionRevision, status = 'unreachable') {
      onlineRevision = null
      const profiles = stored()
      for (const sessionId of [...sessions.keys()]) revoke(sessionId)
      if (!profiles.length) return []
      const next = profiles.map(profile => ({
        ...profile,
        connectionRevision: Number.isSafeInteger(connectionRevision) ? connectionRevision : profile.connectionRevision,
        availabilityStatus: SERVER_STATUSES.has(status) && status !== 'ready' ? status : 'unreachable'
      }))
      db.replaceServerModelProfiles({ connectionRevision, profiles: next })
      return next.map(asDto)
    }
  }
}
