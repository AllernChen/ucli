import { sanitiseSkillError } from './contracts.js'

const ADAPTER_IDS = new Set(['claude', 'codex', 'opencode', 'ucode'])
const REF_TYPES = new Set(['default', 'branch', 'tag', 'commit'])

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
  if (input.type === 'github' || input.type === 'gitlab') {
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
  if (!Array.isArray(input.targetAdapterIds) || !input.targetAdapterIds.length || input.targetAdapterIds.length > 4) {
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

function inspectionContext(value) {
  if (value == null) return {}
  const input = object(value, 'context')
  if (!Array.isArray(input.targetAdapterIds) || !input.targetAdapterIds.length || input.targetAdapterIds.length > 4) {
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

export function registerSkillsIpc({ ipcMain, service }) {
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
