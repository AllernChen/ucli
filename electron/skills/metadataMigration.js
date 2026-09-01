import { buildSkillVisibility } from './adapters.js'

const SHA256 = /^[a-f0-9]{64}$/
const LOCAL_ORIGIN_KINDS = new Set(['github', 'gitlab', 'plugin', 'discovered'])
const SCOPE_TYPES = new Set(['user', 'project'])
const DESIRED_STATES = new Set(['enabled', 'disabled', 'inherit'])
const ENFORCEMENT_STATUSES = new Set([
  'satisfied', 'migration_required', 'blocked', 'error', 'recovery_required'
])

export function backfillSkillManagementMetadata({ db, now = Date.now } = {}) {
  if (!db || typeof db._runImmediateTransaction !== 'function' || typeof now !== 'function') {
    throw new TypeError('Skill metadata backfill requires a database and clock')
  }
  return db._runImmediateTransaction(() => {
    const packages = db.listSkillPackages()
    const mappings = new Map(db.listServerSkillPackages().map((mapping) => [mapping.packageId, mapping]))
    const connections = [db.getServerConnection('current')].filter(Boolean)
    const serviceProfiles = db.listServerServiceProfiles()
    const packageIds = new Set(packages.map((pkg) => pkg.id))

    for (const pkg of packages) {
      if (db.getSkillSourceIdentity(pkg.id)) continue
      const mapping = mappings.get(pkg.id)
      const identity = mapping
        ? organizationIdentityFor({ db, pkg, mapping, connections, serviceProfiles, now })
        : localIdentityFor(pkg, now)
      if (identity) insertSourceIdentityIfAbsent(db, identity)
    }

    const installations = db.listSkillInstallations().filter((installation) =>
      packageIds.has(installation.packageId) && validInstallation(installation)
    )
    const directTargets = new Set(installations.map((installation) => stateKey(installation)))
    for (const installation of installations) {
      const state = {
        packageId: installation.packageId,
        scopeType: installation.scopeType,
        scopeKey: installation.scopeKey,
        adapterId: installation.targetAdapterId,
        desiredState: installation.enabled ? 'enabled' : 'disabled',
        enforcementStatus: 'satisfied',
        reasonCode: null,
        updatedAt: now()
      }
      if (validDesiredState(state)) insertDesiredStateIfAbsent(db, state)
    }
    for (const installation of installations) {
      const visibility = buildSkillVisibility([installation.targetAdapterId], {
        scopeType: installation.scopeType
      })
      for (const [adapterId, state] of Object.entries(visibility)) {
        if (!state.visible || state.direct || directTargets.has(stateKey({ ...installation, targetAdapterId: adapterId }))) continue
        const desiredState = {
          packageId: installation.packageId,
          scopeType: installation.scopeType,
          scopeKey: installation.scopeKey,
          adapterId,
          desiredState: 'inherit',
          enforcementStatus: 'satisfied',
          reasonCode: null,
          updatedAt: now()
        }
        if (validDesiredState(desiredState)) insertDesiredStateIfAbsent(db, desiredState)
      }
    }
  })
}

function organizationIdentityFor({ db, pkg, mapping, connections, serviceProfiles, now }) {
  const serverOrigin = normalizedHttpOrigin(mapping.serverOrigin)
  if (!serverOrigin || !nonEmptyString(mapping.organizationId) || !nonEmptyString(mapping.versionId)) return null
  const artifactSha256 = artifactShaFor({ db, pkg, mapping, serverOrigin })
  if (!artifactSha256) return null
  const organizationName = organizationNameFor({
    serverOrigin,
    organizationId: mapping.organizationId,
    connections,
    serviceProfiles
  })
  const timestamp = now()
  return {
    packageId: pkg.id,
    originKind: 'organization',
    serverOrigin,
    organizationId: mapping.organizationId,
    organizationName: organizationName || mapping.organizationId,
    identityStatus: organizationName ? 'resolved' : 'name_pending',
    catalogVersionId: mapping.versionId,
    artifactSha256,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function artifactShaFor({ db, pkg, mapping, serverOrigin }) {
  const version = db.getServerSkillVersion(mapping.versionId)
  if (version && normalizedOrigin(version.serverOrigin) === serverOrigin &&
    version.organizationId === mapping.organizationId && SHA256.test(version.sha256 || '')) {
    return version.sha256
  }
  return SHA256.test(pkg.resolvedRevision || '') ? pkg.resolvedRevision : null
}

function organizationNameFor({ serverOrigin, organizationId, connections, serviceProfiles }) {
  for (const connection of connections) {
    if (normalizedOrigin(connection.serverOrigin) === serverOrigin && connection.organizationId === organizationId &&
      typeof connection.organizationName === 'string' && connection.organizationName.trim()) {
      return connection.organizationName
    }
  }
  for (const profile of serviceProfiles) {
    if (normalizedOrigin(profile.serverOrigin) === serverOrigin && profile.organizationId === organizationId &&
      typeof profile.organizationName === 'string' && profile.organizationName.trim()) {
      return profile.organizationName
    }
  }
  return null
}

function localIdentityFor(pkg, now) {
  const timestamp = now()
  return {
    packageId: pkg.id,
    originKind: LOCAL_ORIGIN_KINDS.has(pkg.sourceType) ? pkg.sourceType : 'local',
    serverOrigin: null,
    organizationId: null,
    organizationName: null,
    identityStatus: 'resolved',
    catalogVersionId: null,
    artifactSha256: null,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function insertSourceIdentityIfAbsent(db, identity) {
  if (!validSourceIdentity(identity)) return false
  db.sql.run(
    `INSERT INTO skill_source_identities (
       package_id, origin_kind, server_origin, organization_id, organization_name,
       identity_status, catalog_version_id, artifact_sha256, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(package_id) DO NOTHING`,
    [
      identity.packageId, identity.originKind, identity.serverOrigin, identity.organizationId,
      identity.organizationName, identity.identityStatus, identity.catalogVersionId,
      identity.artifactSha256, identity.createdAt, identity.updatedAt
    ]
  )
  return true
}

function insertDesiredStateIfAbsent(db, state) {
  db.sql.run(
    `INSERT INTO skill_cli_desired_states (
       package_id, scope_type, scope_key, adapter_id, desired_state,
       enforcement_status, reason_code, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(package_id, scope_type, scope_key, adapter_id) DO NOTHING`,
    [
      state.packageId, state.scopeType, state.scopeKey, state.adapterId, state.desiredState,
      state.enforcementStatus, state.reasonCode, state.updatedAt
    ]
  )
}

function stateKey({ packageId, scopeType, scopeKey, targetAdapterId }) {
  return `${packageId}\u0000${scopeType}\u0000${scopeKey}\u0000${targetAdapterId}`
}

function normalizedOrigin(value) {
  try { return new URL(value).origin } catch { return null }
}

function normalizedHttpOrigin(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') return null
    return url.origin
  } catch {
    return null
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function validInstallation(installation) {
  return nonEmptyString(installation.scopeKey) && nonEmptyString(installation.targetAdapterId) &&
    SCOPE_TYPES.has(installation.scopeType) && typeof installation.enabled === 'boolean'
}

function validDesiredState(state) {
  return nonEmptyString(state.packageId) && nonEmptyString(state.scopeKey) && nonEmptyString(state.adapterId) &&
    SCOPE_TYPES.has(state.scopeType) && DESIRED_STATES.has(state.desiredState) &&
    ENFORCEMENT_STATUSES.has(state.enforcementStatus) && (state.reasonCode == null || nonEmptyString(state.reasonCode)) &&
    Number.isInteger(state.updatedAt) && state.updatedAt >= 0
}

function validSourceIdentity(identity) {
  if (!identity || !nonEmptyString(identity.packageId) ||
    !Number.isInteger(identity.createdAt) || identity.createdAt < 0 ||
    !Number.isInteger(identity.updatedAt) || identity.updatedAt < 0) return false
  if (identity.originKind !== 'organization') {
    if (!LOCAL_ORIGIN_KINDS.has(identity.originKind) && identity.originKind !== 'local') return false
    return identity.serverOrigin == null && identity.organizationId == null && identity.organizationName == null &&
      identity.identityStatus === 'resolved' && identity.catalogVersionId == null && identity.artifactSha256 == null
  }
  return normalizedHttpOrigin(identity.serverOrigin) === identity.serverOrigin && nonEmptyString(identity.organizationId) &&
    nonEmptyString(identity.organizationName) && ['resolved', 'name_pending'].includes(identity.identityStatus) &&
    nonEmptyString(identity.catalogVersionId) && SHA256.test(identity.artifactSha256 || '')
}
