import { createHash } from 'node:crypto'

import { PUBLIC_MODEL_PROTOCOLS } from './contracts.js'

const SERVER_STATUSES = new Set(['ready', 'unreachable', 'disabled', 'expired', 'deleted'])
const PUBLIC_MODEL_PROTOCOL_SET = new Set(PUBLIC_MODEL_PROTOCOLS)
const ADAPTER_PROTOCOLS = Object.freeze({
  codex: 'openai_responses',
  claude: 'anthropic_messages'
})

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
  const fields = [serverOrigin, organizationId, modelId, adapterId]
  if (fields.some(value => /[\u0000-\u001f\u007f]/.test(value))) {
    throw projectionError('INVALID_SERVER_MODEL', 'Server model identifier is invalid')
  }
  return createHash('sha256')
    .update(fields.map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|'))
    .digest('hex')
    .slice(0, 32)
}

function safeModel(model = {}) {
  const id = String(model.id || '').trim()
  const displayName = String(model.displayName || '').trim()
  const contextSize = Number(model.contextSize)
  const protocols = Array.isArray(model.protocols) ? [...model.protocols] : []
  if (!id || !displayName || !Number.isSafeInteger(contextSize) || contextSize <= 0 ||
    protocols.length === 0 || protocols.some(protocol => !PUBLIC_MODEL_PROTOCOL_SET.has(protocol))) {
    throw projectionError('INVALID_SERVER_MODEL', 'Server model is invalid')
  }
  return { id, displayName, contextSize, protocols }
}

function safeOrganization(organization = {}) {
  const id = String(organization.id || '').trim()
  const name = String(organization.name || '').trim()
  if (!id || !name) throw projectionError('INVALID_SERVER_MODEL', 'Server organization is invalid')
  return { id, name }
}

function asDto(profile, online = false) {
  const durableStatus = SERVER_STATUSES.has(profile.availabilityStatus) ? profile.availabilityStatus : 'unreachable'
  const status = durableStatus === 'ready' && !online ? 'unreachable' : durableStatus
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
    serverStatus: status,
    connectionRevision: profile.connectionRevision,
    hasSecret: false,
    secretSuffix: null,
    status,
    canStart: status === 'ready',
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
    for (const [adapterId, protocol] of Object.entries(ADAPTER_PROTOCOLS)) {
      if (!safe.protocols.includes(protocol)) continue
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
  getRuntimeConnectionIdentity = () => proxy?.getRuntimeConnectionIdentity?.() || null,
  flush = () => db.flush?.() ?? true
} = {}) {
  if (!db || typeof db.listServerModelProfiles !== 'function' ||
    typeof db.replaceServerModelProfiles !== 'function') {
    throw new TypeError('A server model profile database is required')
  }
  const sessions = new Map()
  let onlineIdentity = null

  function stored() { return db.listServerModelProfiles().map(profile => ({ ...profile })) }
  function find(profileId) { return stored().find(profile => profile.profileId === profileId) || null }
  function currentIdentity(profile) {
    const identity = getRuntimeConnectionIdentity()
    if (!identity || identity.connectionRevision !== profile.connectionRevision ||
      typeof identity.connectionId !== 'string' || !identity.connectionId) return null
    return identity
  }
  function sameIdentity(left, right) {
    return Boolean(left && right && left.connectionId === right.connectionId &&
      left.connectionRevision === right.connectionRevision)
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
  function invalidateOnlineState() {
    onlineIdentity = null
    for (const sessionId of [...sessions.keys()]) revoke(sessionId)
  }
  function revoke(sessionId) {
    if (!sessions.has(sessionId)) return false
    sessions.delete(sessionId)
    const revokeSession = proxy?.revokeSession || proxy?.revokeServerGatewaySession
    revokeSession?.(sessionId)
    return true
  }

  return {
    async reconcile(input) {
      const profiles = profileRows(input)
      const identity = getRuntimeConnectionIdentity()
      const previousOnlineIdentity = onlineIdentity
      onlineIdentity = null
      if (!identity || identity.connectionRevision !== input.connectionRevision) {
        invalidateOnlineState()
        db.replaceServerModelProfiles({ connectionRevision: input.connectionRevision, profiles: profiles.map(profile => ({
          ...profile, availabilityStatus: 'unreachable'
        })) })
        await persistOrThrow()
        return this.listProfiles()
      }
      if (!sameIdentity(previousOnlineIdentity, identity)) {
        for (const sessionId of [...sessions.keys()]) revoke(sessionId)
      } else {
        const nextProfileIds = new Set(profiles.map(profile => profile.profileId))
        for (const [sessionId, runtime] of sessions) {
          if (!nextProfileIds.has(runtime.profileId)) revoke(sessionId)
        }
      }
      db.replaceServerModelProfiles({ connectionRevision: input.connectionRevision, profiles })
      try {
        await persistOrThrow()
      } catch (error) {
        invalidateOnlineState()
        throw error
      }
      if (!sameIdentity(identity, getRuntimeConnectionIdentity())) {
        invalidateOnlineState()
        throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
      }
      onlineIdentity = Object.freeze({ ...identity })
      return this.listProfiles()
    },

    listProfiles() {
      return stored().map(profile => asDto(profile, isOnline(profile)))
    },

    prepareRuntime({ profileId, sessionId } = {}) {
      const profile = find(profileId)
      if (!profile || !isOnline(profile)) {
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
            const written = codexProfileFiles.writeServerCodexProfileFileAtomic({
              codexHome: resolveCodexHome(), profile: dto, baseUrl: issued.baseUrl, envKey: envName
            })
            const next = stored().map(candidate => candidate.profileId === profile.profileId
              ? { ...candidate, codexFileSha256: written.sha256 }
              : candidate)
            db.replaceServerModelProfiles({ connectionRevision: profile.connectionRevision, profiles: next })
            persistDigestOrThrow()
          }
          if (!currentIdentity(profile) || currentIdentity(profile).connectionId !== identity.connectionId) {
            throw projectionError('PROFILE_NOT_READY', 'Server profile is not ready')
          }
          sessions.set(sessionId, { profileId, identity: Object.freeze({ ...identity }) })
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
        sessions.set(sessionId, { profileId, identity: Object.freeze({ ...identity }) })
        return {
          args: dto.model ? ['--model', dto.model] : [],
          env: {
            [envName]: issued.bearer,
            ANTHROPIC_BASE_URL: `${issued.baseUrl.replace(/\/$/, '')}/anthropic`,
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

    async clearOnlineState(connectionRevision, status = 'unreachable') {
      onlineIdentity = null
      const profiles = stored()
      for (const sessionId of [...sessions.keys()]) revoke(sessionId)
      if (!profiles.length) return []
      const next = profiles.map(profile => ({
        ...profile,
        connectionRevision: Number.isSafeInteger(connectionRevision) ? connectionRevision : profile.connectionRevision,
        availabilityStatus: SERVER_STATUSES.has(status) && status !== 'ready' ? status : 'unreachable'
      }))
      db.replaceServerModelProfiles({ connectionRevision, profiles: next })
      await persistOrThrow()
      return this.listProfiles()
    }
  }
}
