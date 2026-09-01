import { sanitiseSkillError } from './contracts.js'
import { isAbsolute } from 'node:path'

const ADAPTER_IDS = new Set(['claude', 'codex', 'opencode', 'ucode', 'deepseek-harness'])
const REF_TYPES = new Set(['default', 'branch', 'tag', 'commit'])
const SCOPE_TYPES = new Set(['user', 'project'])
const DESIRED_STATES = new Set(['enabled', 'disabled', 'inherit'])

function ipcError(message) {
  return Object.assign(new TypeError(message), { code: 'SKILL_IPC_INVALID' })
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw ipcError(`${name} is invalid`)
  return value
}

function string(value, name, { optional = false, max = 4096 } = {}) {
  if ((value == null || value === '') && optional) return ''
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw ipcError(`${name} is invalid`)
  return value
}

function id(value, name) {
  const result = string(value, name, { max: 128 })
  if (!/^[\w-]+$/.test(result)) throw ipcError(`${name} is invalid`)
  return result
}

function ids(value, name) {
  if (!Array.isArray(value) || value.length > 200) throw ipcError(`${name} is invalid`)
  return [...new Set(value.map((item) => id(item, name)))]
}

function source(value) {
  const input = object(value, 'source')
  if (input.type === 'local') {
    return { type: 'local', path: string(input.path, 'source.path') }
  }
  if (input.type === 'github' || input.type === 'gitlab' || input.type === 'git') {
    const refType = input.refType == null ? 'default' : String(input.refType)
    if (!REF_TYPES.has(refType)) throw ipcError('source.refType is invalid')
    return {
      type: input.type,
      url: string(input.url, 'source.url'),
      ref: string(input.ref, 'source.ref', { optional: true, max: 256 }),
      refType,
      subdir: string(input.subdir, 'source.subdir', { optional: true })
    }
  }
  throw ipcError('source.type is invalid')
}

function installRequest(value) {
  const input = object(value, 'request')
  if (!Array.isArray(input.targetAdapterIds) || !input.targetAdapterIds.length || input.targetAdapterIds.length > ADAPTER_IDS.size) {
    throw ipcError('targetAdapterIds is invalid')
  }
  const targetAdapterIds = [...new Set(input.targetAdapterIds.map((adapterId) => {
    if (!ADAPTER_IDS.has(adapterId)) throw ipcError('targetAdapterIds is invalid')
    return adapterId
  }))]
  if (!['user', 'project'].includes(input.scopeType)) throw ipcError('scopeType is invalid')
  const projectPath = input.scopeType === 'project'
    ? string(input.projectPath, 'projectPath')
    : ''
  return { source: source(input.source), targetAdapterIds, scopeType: input.scopeType, projectPath }
}

function installRequests(value) {
  if (!Array.isArray(value) || !value.length || value.length > 200) {
    throw ipcError('requests is invalid')
  }
  return value.map((request) => ({
    ...installRequest(request),
    expectedRevision: string(request?.expectedRevision, 'expectedRevision', { max: 256 })
  }))
}

function cliStateRequest(value, { apply = false } = {}) {
  const input = object(value, 'request')
  if (!SCOPE_TYPES.has(input.scopeType)) throw ipcError('scopeType is invalid')
  const scopeKey = string(input.scopeKey, 'scopeKey')
  if ((input.scopeType === 'user' && scopeKey !== '*') ||
    (input.scopeType === 'project' && !isAbsolute(scopeKey))) {
    throw ipcError('scopeKey is invalid')
  }
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > ADAPTER_IDS.size) {
    throw ipcError('changes is invalid')
  }
  const adapterIds = new Set()
  const changes = input.changes.map((change) => {
    const item = object(change, 'change')
    if (!ADAPTER_IDS.has(item.adapterId) || !DESIRED_STATES.has(item.desiredState) || adapterIds.has(item.adapterId)) {
      throw ipcError('changes is invalid')
    }
    adapterIds.add(item.adapterId)
    return { adapterId: item.adapterId, desiredState: item.desiredState }
  })
  const request = {
    packageId: id(input.packageId, 'packageId'),
    scopeType: input.scopeType,
    scopeKey,
    changes
  }
  if (!apply) return request
  const expectedRevision = string(input.expectedRevision, 'expectedRevision', { max: 64 })
  if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) throw ipcError('expectedRevision is invalid')
  return { ...request, expectedRevision }
}

const BATCH_ACTIONS = new Map([
  ['install_organization', 'organization_version'], ['update_organization', 'organization_version'],
  ['update_packages', 'package'], ['set_cli_state', 'package'],
  ['remove_projections', 'package'], ['remove_packages', 'package']
])

function batchRequest(value, { apply = false } = {}) {
  const input = object(value, 'request')
  const expectedKind = BATCH_ACTIONS.get(input.action)
  if (!expectedKind || !Array.isArray(input.items) || !input.items.length || input.items.length > 200) {
    throw ipcError('batch request is invalid')
  }
  const seen = new Set()
  const items = input.items.map((item) => {
    const value = object(item, 'item')
    if (value.kind !== expectedKind) throw ipcError('batch items are invalid')
    const itemId = id(value.id, 'item.id')
    const key = `${value.kind}:${itemId}`
    if (seen.has(key)) throw ipcError('batch items are invalid')
    seen.add(key)
    return { kind: value.kind, id: itemId }
  })
  const rawTargets = object(input.targets, 'targets')
  if (!SCOPE_TYPES.has(rawTargets.scopeType)) throw ipcError('scopeType is invalid')
  const scopeKey = string(rawTargets.scopeKey, 'scopeKey')
  if ((rawTargets.scopeType === 'user' && scopeKey !== '*') ||
    (rawTargets.scopeType === 'project' && !isAbsolute(scopeKey))) throw ipcError('scopeKey is invalid')
  const targets = { scopeType: rawTargets.scopeType, scopeKey }
  if (input.action === 'set_cli_state') {
    if (!ADAPTER_IDS.has(rawTargets.adapterId) || !['enabled', 'disabled'].includes(rawTargets.desiredState)) {
      throw ipcError('batch targets are invalid')
    }
    targets.adapterId = rawTargets.adapterId
    targets.desiredState = rawTargets.desiredState
  }
  if (input.action === 'remove_projections') {
    if (!ADAPTER_IDS.has(rawTargets.adapterId)) throw ipcError('batch targets are invalid')
    targets.adapterId = rawTargets.adapterId
  }
  if (input.action === 'install_organization' || input.action === 'update_organization') {
    if (!Array.isArray(rawTargets.targetAdapterIds) || !rawTargets.targetAdapterIds.length || rawTargets.targetAdapterIds.length > ADAPTER_IDS.size) {
      throw ipcError('batch targets are invalid')
    }
    targets.targetAdapterIds = [...new Set(rawTargets.targetAdapterIds.map(adapterId => {
      if (!ADAPTER_IDS.has(adapterId)) throw ipcError('batch targets are invalid')
      return adapterId
    }))]
  }
  if (!apply) return { action: input.action, items, targets }
  const expectedRevision = string(input.expectedRevision, 'expectedRevision', { max: 64 })
  if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) throw ipcError('expectedRevision is invalid')
  return { action: input.action, items, targets, expectedRevision }
}

function inspectionContext(value) {
  if (value == null) return {}
  const input = object(value, 'context')
  if (!Array.isArray(input.targetAdapterIds) || !input.targetAdapterIds.length || input.targetAdapterIds.length > ADAPTER_IDS.size) {
    throw ipcError('targetAdapterIds is invalid')
  }
  const targetAdapterIds = [...new Set(input.targetAdapterIds.map((adapterId) => {
    if (!ADAPTER_IDS.has(adapterId)) throw ipcError('targetAdapterIds is invalid')
    return adapterId
  }))]
  if (!['user', 'project'].includes(input.scopeType)) throw ipcError('scopeType is invalid')
  return {
    targetAdapterIds,
    scopeType: input.scopeType,
    projectPath: input.scopeType === 'project' ? string(input.projectPath, 'projectPath') : ''
  }
}

async function safeCall(work) {
  try { return await work() } catch (error) {
    if (error?.code === 'SKILL_IPC_INVALID') throw error
    throw sanitiseSkillError(error)
  }
}

export function registerSkillsIpc({ ipcMain, service, batchCoordinator = null }) {
  ipcMain.handle('skills:get-state', (_event, options = {}) => safeCall(() => {
    const input = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    return service.getState({
      projectPath: input.projectPath ? string(input.projectPath, 'projectPath') : undefined
    })
  }))
  ipcMain.handle('skills:inspect-source', (_event, input, context) => safeCall(() =>
    service.inspectSource(source(input), inspectionContext(context))
  ))
  ipcMain.handle('skills:install', (_event, input) => safeCall(() => service.install(installRequest(input))))
  ipcMain.handle('skills:install-many', (_event, input) => safeCall(() => service.installMany(installRequests(input))))
  if (batchCoordinator) {
    ipcMain.handle('skills:preview-batch-action', (_event, request) => safeCall(() =>
      batchCoordinator.preview(batchRequest(request))
    ))
    ipcMain.handle('skills:apply-batch-action', (_event, request) => safeCall(() =>
      batchCoordinator.apply(batchRequest(request, { apply: true }))
    ))
  }
  ipcMain.handle('skills:preview-cli-state-change', (_event, request) => safeCall(() =>
    service.previewCliStateChange(cliStateRequest(request))
  ))
  ipcMain.handle('skills:apply-cli-state-change', (_event, request) => safeCall(() =>
    service.applyCliStateChange(cliStateRequest(request, { apply: true }))
  ))
  ipcMain.handle('skills:resolve-cli-state-recovery', (_event, packageId) => safeCall(() =>
    service.resolveCliStateRecovery(id(packageId, 'packageId'))
  ))
  ipcMain.handle('skills:apply-to-adapter', (_event, request) => safeCall(() => {
    const input = object(request, 'request')
    if (!ADAPTER_IDS.has(input.targetAdapterId)) throw ipcError('targetAdapterId is invalid')
    return service.applyToAdapter(id(input.packageId, 'packageId'), input.targetAdapterId)
  }))
  ipcMain.handle('skills:check-updates', (_event, packageIds) => safeCall(() =>
    service.checkUpdates(packageIds == null ? null : ids(packageIds, 'packageIds'))
  ))
  ipcMain.handle('skills:preview-update', (_event, packageId) => safeCall(() =>
    service.previewUpdate(id(packageId, 'packageId'))
  ))
  ipcMain.handle('skills:update', (_event, packageId, expectedRevision) => safeCall(() =>
    service.update(
      id(packageId, 'packageId'),
      expectedRevision == null ? null : string(expectedRevision, 'expectedRevision', { max: 256 })
    )
  ))
  ipcMain.handle('skills:set-enabled', (_event, installationId, enabled) => safeCall(() => {
    if (typeof enabled !== 'boolean') throw ipcError('enabled is invalid')
    return service.setEnabled(id(installationId, 'installationId'), enabled)
  }))
  ipcMain.handle('skills:remove-installation', (_event, installationId) => safeCall(() =>
    service.removeInstallation(id(installationId, 'installationId'))
  ))
  ipcMain.handle('skills:remove-package', (_event, packageId) => safeCall(() =>
    service.removePackage(id(packageId, 'packageId'))
  ))
  ipcMain.handle('skills:resolve-drift', (_event, installationId, resolution) => safeCall(() => {
    if (!['restore', 'adopt'].includes(resolution)) throw ipcError('resolution is invalid')
    return service.resolveDrift(id(installationId, 'installationId'), resolution)
  }))
  ipcMain.handle('skills:adopt', (_event, request) => safeCall(() => {
    const input = object(request, 'request')
    if (!ADAPTER_IDS.has(input.targetAdapterId)) throw ipcError('targetAdapterId is invalid')
    if (!['user', 'project'].includes(input.scopeType)) throw ipcError('scopeType is invalid')
    return service.adopt({
      path: string(input.path, 'path'),
      targetAdapterId: input.targetAdapterId,
      scopeType: input.scopeType,
      projectPath: input.scopeType === 'project' ? string(input.projectPath, 'projectPath') : ''
    })
  }))
  ipcMain.handle('skills:get-affected-sessions', (_event, installationIds) => safeCall(() =>
    service.getAffectedSessions(ids(installationIds, 'installationIds'))
  ))
  ipcMain.handle('skills:restart-sessions', (_event, sessionIds) => safeCall(() =>
    service.restartSessions(ids(sessionIds, 'sessionIds'))
  ))
}
