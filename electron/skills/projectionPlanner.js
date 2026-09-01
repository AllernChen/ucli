import { createHash } from 'node:crypto'

const DESIRED_STATES = new Set(['enabled', 'disabled', 'inherit'])
const REQUESTED_DESIRED_STATES = new Set(['enabled', 'disabled'])
const ENFORCEMENT_STATUSES = new Set([
  'satisfied', 'migration_required', 'blocked', 'error', 'recovery_required'
])
const REASON_CODES = new Set([
  'SKILL_CLI_ISOLATION_UNSUPPORTED',
  'SKILL_INCOMPATIBLE',
  'SKILL_DRIFTED',
  'SKILL_PROJECTION_MIGRATION_REQUIRED',
  'SKILL_PROJECTION_RECOVERY_REQUIRED',
  'SKILL_TARGET_CONFLICT',
  'SKILL_TARGET_MISSING'
])
const HEALTHY_INSTALLATION_STATUSES = new Set(['ready', 'update_available'])

function plannerError(code) {
  return Object.assign(new Error('Skill projection state is invalid'), { code })
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function compareText(left, right) {
  return String(left).localeCompare(String(right))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
    !snapshot.package || typeof snapshot.package !== 'object' ||
    typeof snapshot.package.id !== 'string' || !snapshot.package.id ||
    !isSha256(snapshot.package.contentSha256) ||
    !snapshot.scope || typeof snapshot.scope !== 'object' ||
    !['user', 'project'].includes(snapshot.scope.type) ||
    typeof snapshot.scope.key !== 'string' || !snapshot.scope.key ||
    !snapshot.compatibility || typeof snapshot.compatibility !== 'object' || Array.isArray(snapshot.compatibility) ||
    !Array.isArray(snapshot.capabilities) || !Array.isArray(snapshot.installations) || !Array.isArray(snapshot.desiredStates)) {
    throw plannerError('SKILL_PROJECTION_PLAN_INVALID')
  }

  const capabilities = new Map()
  for (const capability of snapshot.capabilities) {
    if (!capability || typeof capability !== 'object' || Array.isArray(capability) ||
      typeof capability.adapterId !== 'string' || !capability.adapterId || capabilities.has(capability.adapterId) ||
      typeof capability.directRoot !== 'string' || !capability.directRoot ||
      !Array.isArray(capability.covers) || capability.covers.length === 0 ||
      new Set(capability.covers).size !== capability.covers.length ||
      capability.covers.some((adapterId) => typeof adapterId !== 'string' || !adapterId) ||
      !capability.covers.includes(capability.adapterId) ||
      typeof capability.canExcludeInherited !== 'boolean' ||
      (!capability.canExcludeInherited && capability.isolationReasonCode !== 'SKILL_CLI_ISOLATION_UNSUPPORTED') ||
      (capability.canExcludeInherited && capability.isolationReasonCode !== null)) {
      throw plannerError('SKILL_PROJECTION_PLAN_INVALID')
    }
    capabilities.set(capability.adapterId, capability)
  }
  if (capabilities.size === 0) throw plannerError('SKILL_PROJECTION_PLAN_INVALID')

  for (const [adapterId, capability] of capabilities) {
    if (!capability.covers.every((coveredId) => capabilities.has(coveredId)) ||
      !snapshot.compatibility[adapterId] || typeof snapshot.compatibility[adapterId].compatible !== 'boolean') {
      throw plannerError('SKILL_PROJECTION_PLAN_INVALID')
    }
  }

  const installations = new Map()
  const directTargets = new Set()
  for (const installation of snapshot.installations) {
    if (!installation || typeof installation !== 'object' || Array.isArray(installation) ||
      typeof installation.id !== 'string' || !installation.id || installations.has(installation.id) ||
      typeof installation.targetAdapterId !== 'string' || !capabilities.has(installation.targetAdapterId) ||
      directTargets.has(installation.targetAdapterId) ||
      typeof installation.enabled !== 'boolean' || typeof installation.status !== 'string' ||
      !isSha256(installation.deployedSha256)) {
      throw plannerError('SKILL_PROJECTION_PLAN_INVALID')
    }
    installations.set(installation.id, installation)
    directTargets.add(installation.targetAdapterId)
  }

  const desiredStates = new Map()
  for (const state of snapshot.desiredStates) {
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
      typeof state.adapterId !== 'string' || !capabilities.has(state.adapterId) || desiredStates.has(state.adapterId) ||
      !DESIRED_STATES.has(state.desiredState) || !ENFORCEMENT_STATUSES.has(state.enforcementStatus) ||
      (state.reasonCode !== null && !REASON_CODES.has(state.reasonCode))) {
      throw plannerError('SKILL_CLI_DESIRED_STATE_INVALID')
    }
    desiredStates.set(state.adapterId, state)
  }

  return { capabilities, installations: [...installations.values()], desiredStates }
}

function semanticState(snapshot) {
  const { capabilities, installations, desiredStates } = validateSnapshot(snapshot)
  return {
    package: { id: snapshot.package.id, contentSha256: snapshot.package.contentSha256 },
    scope: { type: snapshot.scope.type, key: snapshot.scope.key },
    compatibility: [...capabilities.keys()].sort(compareText).map((adapterId) => ({
      adapterId,
      compatible: snapshot.compatibility[adapterId].compatible
    })),
    capabilities: [...capabilities.values()].map((capability) => ({
      adapterId: capability.adapterId,
      covers: [...capability.covers].sort(compareText),
      canExcludeInherited: capability.canExcludeInherited,
      isolationReasonCode: capability.isolationReasonCode
    })).sort((left, right) => compareText(left.adapterId, right.adapterId)),
    installations: installations.map((installation) => ({
      id: installation.id,
      adapterId: installation.targetAdapterId,
      enabled: installation.enabled,
      status: installation.status,
      deployedSha256: installation.deployedSha256
    })).sort((left, right) => compareText(left.id, right.id)),
    desiredStates: [...desiredStates.values()].map((state) => ({
      adapterId: state.adapterId,
      desiredState: state.desiredState,
      enforcementStatus: state.enforcementStatus,
      reasonCode: state.reasonCode
    })).sort((left, right) => compareText(left.adapterId, right.adapterId))
  }
}

export function projectionStateRevision(snapshot) {
  return createHash('sha256').update(canonicalJson(semanticState(snapshot))).digest('hex')
}

function blocked(revision, reasonCode) {
  return { revision, classification: 'blocked', steps: [], impacts: [], reasonCode }
}

function activeDirectInstallations(installations, packageSha256) {
  return installations.filter((installation) => installation.enabled &&
    HEALTHY_INSTALLATION_STATUSES.has(installation.status) && installation.deployedSha256 === packageSha256)
}

function providerIdsFor(adapterId, activeInstallations, capabilities) {
  return activeInstallations
    .filter((installation) => installation.targetAdapterId !== adapterId &&
      capabilities.get(installation.targetAdapterId).covers.includes(adapterId))
    .map((installation) => installation.targetAdapterId)
}

function validateRequestedChanges(requestedChanges, capabilities) {
  if (!Array.isArray(requestedChanges) || requestedChanges.length === 0) {
    throw plannerError('SKILL_CLI_DESIRED_STATE_INVALID')
  }
  const changes = new Map()
  for (const change of requestedChanges) {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
      typeof change.adapterId !== 'string' || !capabilities.has(change.adapterId) ||
      !REQUESTED_DESIRED_STATES.has(change.desiredState) || changes.has(change.adapterId)) {
      throw plannerError('SKILL_CLI_DESIRED_STATE_INVALID')
    }
    changes.set(change.adapterId, change.desiredState)
  }
  return changes
}

export function planSkillCliStateChange(snapshot, requestedChanges) {
  const state = validateSnapshot(snapshot)
  const revision = projectionStateRevision(snapshot)
  const requested = validateRequestedChanges(requestedChanges, state.capabilities)

  if ([...state.desiredStates.values()].some((item) => item.enforcementStatus === 'recovery_required')) {
    return blocked(revision, 'SKILL_PROJECTION_RECOVERY_REQUIRED')
  }
  if (state.installations.some((item) => item.enabled &&
    (!HEALTHY_INSTALLATION_STATUSES.has(item.status) || item.deployedSha256 !== snapshot.package.contentSha256))) {
    return blocked(revision, 'SKILL_DRIFTED')
  }
  if ([...requested.keys()].some((adapterId) => !snapshot.compatibility[adapterId].compatible)) {
    return blocked(revision, 'SKILL_INCOMPATIBLE')
  }

  const finalDesired = new Map([...state.desiredStates.entries()].map(([adapterId, item]) => [adapterId, item.desiredState]))
  for (const [adapterId, desiredState] of requested) finalDesired.set(adapterId, desiredState)
  const activeInstallations = activeDirectInstallations(state.installations, snapshot.package.contentSha256)
  const activeDirect = new Set(activeInstallations.map((item) => item.targetAdapterId))
  const ensureDirect = new Set()
  const disableDirect = new Set()

  for (const [adapterId, desiredState] of requested) {
    if (desiredState === 'enabled' && !activeDirect.has(adapterId)) {
      ensureDirect.add(adapterId)
    }
    if (desiredState === 'disabled' && activeDirect.has(adapterId)) disableDirect.add(adapterId)
  }

  for (const [adapterId, desiredState] of requested) {
    if (desiredState !== 'disabled') continue
    const remainingProviders = providerIdsFor(adapterId, activeInstallations, state.capabilities)
      .filter((providerId) => !disableDirect.has(providerId))
    if (remainingProviders.length === 0) continue
    const capability = state.capabilities.get(adapterId)
    if (!capability.canExcludeInherited) {
      return blocked(revision, capability.isolationReasonCode || 'SKILL_CLI_ISOLATION_UNSUPPORTED')
    }
  }

  for (const providerId of disableDirect) {
    const provider = state.capabilities.get(providerId)
    for (const consumerId of provider.covers) {
      if (consumerId === providerId || finalDesired.get(consumerId) !== 'enabled' || activeDirect.has(consumerId)) continue
      const remainingProviders = providerIdsFor(consumerId, activeInstallations, state.capabilities)
        .filter((candidateId) => candidateId !== providerId && !disableDirect.has(candidateId))
      if (remainingProviders.length === 0) ensureDirect.add(consumerId)
    }
  }

  const setDesired = [...requested]
    .filter(([adapterId, desiredState]) => state.desiredStates.get(adapterId)?.desiredState !== desiredState)
    .sort(([left], [right]) => compareText(left, right))
  const steps = [
    ...[...ensureDirect].sort(compareText).map((adapterId) => ({ type: 'ensure_direct', adapterId })),
    ...[...disableDirect].sort(compareText).map((adapterId) => ({ type: 'disable_direct', adapterId })),
    ...setDesired.map(([adapterId, desiredState]) => ({ type: 'set_desired', adapterId, desiredState }))
  ]
  const impacts = [
    ...[...ensureDirect].sort(compareText).map((adapterId) => ({ adapterId, action: 'ensure_direct' })),
    ...[...disableDirect].sort(compareText).map((adapterId) => ({ adapterId, action: 'disable_direct' }))
  ]
  const migrated = [...ensureDirect].some((adapterId) =>
    [...disableDirect].some((providerId) => state.capabilities.get(providerId).covers.includes(adapterId)))
  return {
    revision,
    classification: steps.length === 0 ? 'noop' : migrated ? 'migration_required' : 'direct',
    steps,
    impacts,
    reasonCode: null
  }
}
