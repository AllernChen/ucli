import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { MAX_SKILLS_BATCH_ITEMS } from '../../shared/skillsBatchContracts.js'

const ACTIONS = new Map([
  ['install_organization', 'organization_version'],
  ['update_organization', 'organization_version'],
  ['update_packages', 'package'],
  ['set_cli_state', 'package'],
  ['remove_projections', 'package'],
  ['remove_packages', 'package']
])
const STOP_CODES = new Set([
  'SKILL_PERSISTENCE_PENDING',
  'SKILL_PROJECTION_RECOVERY_REQUIRED'
])
const NON_RETRYABLE_CODES = new Set([
  'SKILL_DRIFTED',
  'SKILL_PACKAGE_NOT_FOUND',
  'SKILL_PERSISTENCE_PENDING',
  'SKILL_PROJECTION_RECOVERY_REQUIRED',
  'SKILL_PROJECTION_PLAN_STALE',
  'SKILL_CLI_ISOLATION_UNSUPPORTED',
  'SKILL_SCOPE_INVALID',
  'SKILL_TARGET_MISSING',
  'SKILL_UPDATE_UNAVAILABLE',
  'SKILL_UPDATE_STALE'
])

function batchError(code) {
  return Object.assign(new Error('Skill batch request is invalid'), { code })
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function revision(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function itemKey(item) {
  return `${item.kind}:${item.id}`
}

function stableItems(items) {
  return [...items].sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind))
}

function identityOf(value) {
  const source = value?.sourceIdentity
  if (source?.originKind !== 'organization') return null
  if (typeof source.serverOrigin !== 'string' || typeof source.organizationId !== 'string') return null
  return `${source.serverOrigin.toLowerCase()}:${source.organizationId}`
}

function packageForOrganizationVersion(packages, version) {
  return [...packages].find((pkg) => {
    const identity = pkg?.sourceIdentity
    return identity?.originKind === 'organization' &&
      identity.serverOrigin?.toLowerCase() === version.serverOrigin?.toLowerCase() &&
      identity.organizationId === version.organizationId &&
      identity.catalogVersionId === version.versionId
  }) || null
}

function safeSessionIds(sessions) {
  return [...new Set((sessions || [])
    .map((session) => session?.id)
    .filter((id) => typeof id === 'string' && id && id.length <= 128 && !id.includes('\0')))]
    .sort()
}

function targetScope(targets) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
  if (targets.scopeType === 'user' && targets.scopeKey === '*') return { scopeType: 'user', scopeKey: '*' }
  if (targets.scopeType === 'project' && typeof targets.scopeKey === 'string' && isAbsolute(targets.scopeKey)) {
    return { scopeType: 'project', scopeKey: targets.scopeKey }
  }
  throw batchError('SKILL_BATCH_CONTEXT_INVALID')
}

function validateRequest(request, { apply = false } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !ACTIONS.has(request.action) ||
    !Array.isArray(request.items) || request.items.length < 1 || request.items.length > MAX_SKILLS_BATCH_ITEMS) {
    throw batchError('SKILL_BATCH_CONTEXT_INVALID')
  }
  const expectedKind = ACTIONS.get(request.action)
  const seen = new Set()
  const items = request.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.kind !== expectedKind ||
      typeof item.id !== 'string' || !/^[\w-]+$/.test(item.id) || seen.has(itemKey(item))) {
      throw batchError('SKILL_BATCH_CONTEXT_INVALID')
    }
    seen.add(itemKey(item))
    return { kind: item.kind, id: item.id }
  })
  const scope = targetScope(request.targets)
  const targets = { ...scope }
  if (request.action === 'set_cli_state') {
    if (typeof request.targets.adapterId !== 'string' || !request.targets.adapterId ||
      !['enabled', 'disabled'].includes(request.targets.desiredState)) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
    targets.adapterId = request.targets.adapterId
    targets.desiredState = request.targets.desiredState
  }
  if (request.action === 'remove_projections') {
    if (typeof request.targets.adapterId !== 'string' || !request.targets.adapterId) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
    targets.adapterId = request.targets.adapterId
  }
  if (request.action === 'install_organization' || request.action === 'update_organization') {
    if (!Array.isArray(request.targets.targetAdapterIds) || !request.targets.targetAdapterIds.length ||
      request.targets.targetAdapterIds.some(id => typeof id !== 'string' || !id)) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
    targets.targetAdapterIds = [...new Set(request.targets.targetAdapterIds)]
  }
  if (apply && (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(request.expectedRevision))) {
    throw batchError('SKILL_BATCH_CONTEXT_INVALID')
  }
  return { action: request.action, items: stableItems(items), targets, expectedRevision: request.expectedRevision || null }
}

function safeFailure(item, error) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'SKILL_OPERATION_FAILED'
  return { item, code, retryable: !NON_RETRYABLE_CODES.has(code) }
}

function packageSnapshot(pkg) {
  return {
    id: pkg.id,
    resolvedRevision: pkg.resolvedRevision || null,
    contentSha256: pkg.contentSha256 || null,
    sourceIdentity: pkg.sourceIdentity ? {
      originKind: pkg.sourceIdentity.originKind,
      serverOrigin: pkg.sourceIdentity.serverOrigin || null,
      organizationId: pkg.sourceIdentity.organizationId || null,
      catalogVersionId: pkg.sourceIdentity.catalogVersionId || null,
      artifactSha256: pkg.sourceIdentity.artifactSha256 || null
    } : null,
    installations: (pkg.installations || []).map(item => ({
      id: item.id, targetAdapterId: item.targetAdapterId, scopeType: item.scopeType,
      scopeKey: item.scopeKey, enabled: item.enabled, status: item.status, deployedSha256: item.deployedSha256 || null
    })).sort((left, right) => left.id.localeCompare(right.id)),
    cliDesiredStates: (pkg.cliDesiredStates || []).map(item => ({
      adapterId: item.adapterId, scopeType: item.scopeType, scopeKey: item.scopeKey,
      desiredState: item.desiredState, enforcementStatus: item.enforcementStatus, reasonCode: item.reasonCode || null
    })).sort((left, right) => left.adapterId.localeCompare(right.adapterId))
  }
}

function catalogSnapshot(version) {
  return {
    versionId: version.versionId,
    serverOrigin: version.serverOrigin,
    organizationId: version.organizationId,
    slug: version.slug,
    version: version.version,
    sha256: version.sha256,
    lifecycleStatus: version.lifecycleStatus
  }
}

function entryDigest(entry) {
  return revision({
    item: entry.item,
    snapshot: entry.item.kind === 'package' ? packageSnapshot(entry.value) : catalogSnapshot(entry.value)
  })
}

function installationFor(pkg, targets) {
  return (pkg.installations || []).find(item => item.targetAdapterId === targets.adapterId &&
    item.scopeType === targets.scopeType && item.scopeKey === targets.scopeKey) || null
}

function targetRequest(targets) {
  return {
    targetAdapterIds: targets.targetAdapterIds,
    scopeType: targets.scopeType,
    projectPath: targets.scopeType === 'project' ? targets.scopeKey : ''
  }
}

function categoryFor(plan) {
  if (plan.classification === 'migration_required') return 'migration_required'
  if (plan.classification === 'noop') return 'noop'
  if (plan.reasonCode === 'SKILL_TARGET_CONFLICT') return 'conflict'
  if (plan.classification === 'blocked') return 'blocked'
  return 'direct'
}

export function createSkillsBatchCoordinator({ skillsService, organizationCatalog }) {
  if (!skillsService || typeof skillsService.getState !== 'function' || !organizationCatalog || typeof organizationCatalog.list !== 'function') {
    throw new TypeError('Skill batch coordinator dependencies are invalid')
  }
  let closed = false

  async function resolved(request) {
    const state = await skillsService.getState()
    const packages = new Map((state?.packages || []).filter(pkg => pkg && typeof pkg.id === 'string').map(pkg => [pkg.id, pkg]))
    const versions = new Map((organizationCatalog.list() || []).filter(version => version && typeof version.versionId === 'string')
      .map(version => [version.versionId, version]))
    const entries = request.items.map((item) => {
      const value = item.kind === 'package' ? packages.get(item.id) : versions.get(item.id)
      if (!value) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
      const associatedPackage = item.kind === 'organization_version' ? packageForOrganizationVersion(packages.values(), value) : value
      const entry = {
        item, value, associatedPackage,
        context: item.kind === 'package' ? identityOf(value) : `${value.serverOrigin?.toLowerCase()}:${value.organizationId}`
      }
      return { ...entry, digest: entryDigest(entry) }
    })
    const contexts = new Set(entries.map(entry => entry.context || 'local'))
    if (contexts.size > 1) throw batchError('SKILL_BATCH_CONTEXT_INVALID')
    return { entries, revision: revision({ action: request.action, targets: request.targets, entries: entries.map(entry => ({
      item: entry.item,
      digest: entry.digest
    })) }) }
  }

  async function planEntry(request, entry) {
    if (request.action === 'set_cli_state') {
      const plan = await skillsService.previewCliStateChange({
        packageId: entry.value.id, scopeType: request.targets.scopeType, scopeKey: request.targets.scopeKey,
        changes: [{ adapterId: request.targets.adapterId, desiredState: request.targets.desiredState }]
      })
      return { classification: plan.classification, reasonCode: plan.reasonCode || null, plan }
    }
    if (request.action === 'remove_projections') {
      return installationFor(entry.value, request.targets)
        ? { classification: 'direct', reasonCode: null }
        : { classification: 'noop', reasonCode: 'SKILL_PROJECTION_NOT_FOUND' }
    }
    if (request.action === 'update_packages' && typeof skillsService.previewUpdate === 'function') {
      const update = await skillsService.previewUpdate(entry.value.id)
      return update.hasChanges ? { classification: 'direct', reasonCode: null } : { classification: 'noop', reasonCode: update.reason || 'SKILL_UPDATE_UNAVAILABLE' }
    }
    if ((request.action === 'install_organization' || request.action === 'update_organization') && entry.value.lifecycleStatus === 'REVOKED') {
      return { classification: 'blocked', reasonCode: 'SERVER_SKILL_REVOKED' }
    }
    return { classification: 'direct', reasonCode: null }
  }

  async function preview(request) {
    if (closed) throw batchError('SKILL_BATCH_SHUTDOWN')
    const input = validateRequest(request)
    const snapshot = await resolved(input)
    const entries = []
    const categories = { direct: [], migration_required: [], blocked: [], conflict: [], noop: [] }
    for (const entry of snapshot.entries) {
      const plan = await planEntry(input, entry)
      const planned = { item: entry.item, packageId: entry.item.kind === 'package' ? entry.value.id : null,
        classification: plan.classification, reasonCode: plan.reasonCode, category: categoryFor(plan) }
      entries.push(planned)
      categories[planned.category].push(planned)
    }
    return { revision: snapshot.revision, action: input.action, items: entries, categories }
  }

  async function execute(request, entry, plan) {
    const packageId = entry.item.kind === 'package' ? entry.value.id : null
    if (request.action === 'set_cli_state') {
      const result = await skillsService.applyCliStateChange({
        packageId, scopeType: request.targets.scopeType, scopeKey: request.targets.scopeKey,
        changes: [{ adapterId: request.targets.adapterId, desiredState: request.targets.desiredState }],
        expectedRevision: plan.plan.revision
      })
      const affectedAdapterIds = (result?.plan?.impacts || []).map(item => item.adapterId).filter(Boolean)
      return { packageId, affectedAdapterIds: affectedAdapterIds.length ? affectedAdapterIds : [request.targets.adapterId] }
    }
    if (request.action === 'remove_projections') {
      if (await skillsService.removeInstallation(installationFor(entry.value, request.targets).id) === false) {
        return { skipped: 'SKILL_PROJECTION_NOT_FOUND' }
      }
      return { packageId, affectedAdapterIds: [request.targets.adapterId] }
    }
    if (request.action === 'remove_packages') {
      if (await skillsService.removePackage(packageId) === false) return { skipped: 'SKILL_PACKAGE_NOT_FOUND' }
      return { packageId, affectedAdapterIds: [...new Set((entry.value.installations || []).map(item => item.targetAdapterId))].sort() }
    }
    if (request.action === 'update_packages') {
      await skillsService.update(packageId, entry.value.resolvedRevision || null)
      return { packageId, affectedAdapterIds: [...new Set((entry.value.installations || []).map(item => item.targetAdapterId))].sort() }
    }
    const result = request.action === 'install_organization'
      ? await organizationCatalog.install(entry.value.versionId, targetRequest(request.targets))
      : await organizationCatalog.update(entry.value.versionId, targetRequest(request.targets))
    return { packageId: result?.id || null, affectedAdapterIds: [...request.targets.targetAdapterIds].sort() }
  }

  async function affectedSessionIdsFor(entry) {
    if (typeof skillsService.getAffectedSessions !== 'function') return []
    const installationIds = [...new Set((entry.associatedPackage?.installations || []).map((item) => item?.id)
      .filter((id) => typeof id === 'string' && id))].sort()
    if (!installationIds.length) return []
    try { return safeSessionIds(await skillsService.getAffectedSessions(installationIds)) } catch { return [] }
  }

  async function applyOnce(request) {
    if (closed) return { succeeded: [], failed: [], skipped: [], recoveryRequired: [], aborted: { code: 'SKILL_BATCH_SHUTDOWN', remainingItems: [] } }
    const input = validateRequest(request, { apply: true })
    const initial = await resolved(input)
    if (initial.revision !== input.expectedRevision) {
      throw Object.assign(new Error('Skill batch plan is stale'), { code: 'SKILL_PROJECTION_PLAN_STALE' })
    }
    const result = { succeeded: [], failed: [], skipped: [], recoveryRequired: [], aborted: null }
    const initialDigests = new Map(initial.entries.map(entry => [itemKey(entry.item), entry.digest]))
    for (let index = 0; index < input.items.length; index += 1) {
      if (closed) {
        result.aborted = { code: 'SKILL_BATCH_SHUTDOWN', remainingItems: input.items.slice(index) }
        break
      }
      const item = input.items[index]
      let entry
      let plan
      try {
        const current = await resolved({ ...input, items: [item] })
        entry = current.entries[0]
        if (entry.digest !== initialDigests.get(itemKey(item))) {
          throw Object.assign(new Error('Skill batch plan is stale'), { code: 'SKILL_PROJECTION_PLAN_STALE' })
        }
        plan = await planEntry(input, entry)
        if (plan.classification === 'blocked' || plan.classification === 'noop') {
          result.skipped.push({ item, reasonCode: plan.reasonCode || (plan.classification === 'noop' ? 'SKILL_BATCH_NOOP' : 'SKILL_BATCH_BLOCKED') })
          continue
        }
        // Resolve affected sessions before files or package records change; removal
        // and migrations may make the old installation ids unavailable afterwards.
        const affectedSessionIds = await affectedSessionIdsFor(entry)
        const completed = await execute(input, entry, plan)
        if (completed.skipped) {
          result.skipped.push({ item, reasonCode: completed.skipped })
          continue
        }
        result.succeeded.push({
          item, packageId: completed.packageId, action: input.action,
          affectedAdapterIds: completed.affectedAdapterIds, affectedSessionIds
        })
      } catch (error) {
        const code = error?.code || 'SKILL_OPERATION_FAILED'
        if (code === 'SKILL_PROJECTION_RECOVERY_REQUIRED') {
          result.recoveryRequired.push({ item, packageId: entry?.value?.id || null, recoveryAction: error?.recoveryAction === 'retry_apply_codex' ? 'retry_apply_codex' : null })
        } else {
          result.failed.push(safeFailure(item, error))
        }
        if (STOP_CODES.has(code)) {
          result.aborted = { code, remainingItems: input.items.slice(index + 1) }
          break
        }
      }
    }
    return result
  }

  const active = new Set()
  function apply(request) {
    const work = applyOnce(request)
    active.add(work)
    return work.finally(() => active.delete(work))
  }
  async function shutdown() {
    closed = true
    await Promise.allSettled([...active])
  }

  return { preview, apply, shutdown }
}
