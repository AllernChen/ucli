import { sanitiseServerError } from './contracts.js'
import { safeProfile } from '../aiCliProfiles/ipc.js'

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,200}$/
const VERSION_ID = /^[A-Za-z0-9_-]{1,200}$/
const ADAPTER_IDS = new Set(['claude', 'codex', 'opencode', 'ucode', 'deepseek-harness'])
const LOCAL_ERRORS = Object.freeze({
  SECURE_STORAGE_UNAVAILABLE: ['Secure storage is unavailable', false],
  PERSISTENCE_PENDING: ['Server credentials could not be saved', true],
  SERVER_CREDENTIAL_ENCRYPT_FAILED: ['Server credentials could not be encrypted', false],
  SERVER_CANDIDATE_NOT_FOUND: ['Server registration could not be completed', false],
  REGISTRATION_BUSY: ['Another registration is already in progress', true]
})

function invalidIpc() {
  const error = Object.assign(new TypeError('Invalid server connection request'), { code: 'INVALID_SERVER_CONNECTION_IPC' })
  delete error.stack
  return error
}

function attemptId(value) {
  if (typeof value !== 'string' || !ATTEMPT_ID.test(value)) throw invalidIpc()
  return value
}

function input(value) {
  if (typeof value !== 'string' || !value || value.length > 16_384 || value.includes('\0')) throw invalidIpc()
  return value
}

function versionId(value) {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) throw invalidIpc()
  return value
}

function targets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.targetAdapterIds) ||
    !value.targetAdapterIds.length || value.targetAdapterIds.length > ADAPTER_IDS.size || !['user', 'project'].includes(value.scopeType)) {
    throw invalidIpc()
  }
  const targetAdapterIds = [...new Set(value.targetAdapterIds)]
  if (targetAdapterIds.some(id => typeof id !== 'string' || !ADAPTER_IDS.has(id))) throw invalidIpc()
  const projectPath = value.scopeType === 'project' ? input(value.projectPath) : ''
  return { targetAdapterIds, scopeType: value.scopeType, projectPath }
}

function safeError(error) {
  if (error?.code === 'INVALID_SERVER_CONNECTION_IPC') return error
  if (LOCAL_ERRORS[error?.code]) {
    const [message, retryable] = LOCAL_ERRORS[error.code]
    const result = Object.assign(new Error(message), { code: error.code, retryable })
    delete result.stack
    return result
  }
  const safe = sanitiseServerError(error)
  const result = Object.assign(new Error(safe.message), safe)
  delete result.stack
  return result
}

function invoke(operation) {
  return async (...args) => {
    try {
      return await operation(...args)
    } catch (error) {
      throw safeError(error)
    }
  }
}

function exact(args, count) {
  if (args.length !== count) throw invalidIpc()
}

function skillsFreshOptions(args) {
  if (args.length === 0) return { force: false }
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]) ||
    Object.keys(args[0]).length !== 1 || !Object.hasOwn(args[0], 'force') || typeof args[0].force !== 'boolean') {
    throw invalidIpc()
  }
  return { force: args[0].force }
}

export function registerServerConnectionIpc({ ipcMain, manager, skillsCatalog = null, skillsSyncCoordinator = null, serverModelProjection = null, syncModelProjection = null, send = () => {} } = {}) {
  if (!ipcMain?.handle || !manager) throw new TypeError('IPC dependencies are required')
  ipcMain.handle('server-connection:submit-link', invoke((_event, ...args) => {
    exact(args, 1)
    return manager.submitLink(input(args[0]))
  }))
  ipcMain.handle('server-connection:get-attempt', invoke((_event, ...args) => {
    exact(args, 1)
    return manager.getAttempt(attemptId(args[0]))
  }))
  ipcMain.handle('server-connection:get-pending-attempt', invoke((_event, ...args) => {
    exact(args, 0)
    return manager.getPendingAttempt()
  }))
  for (const [channel, method] of [
    ['server-connection:confirm', 'confirm'],
    ['server-connection:retry-redeem', 'retryRedeem'],
    ['server-connection:cancel', 'cancel']
  ]) {
    ipcMain.handle(channel, invoke((_event, ...args) => {
      exact(args, 1)
      return manager[method](attemptId(args[0]))
    }))
  }
  for (const [channel, method] of [
    ['server-connection:get-state', 'getState'],
    ['server-connection:retry', 'retry'],
    ['server-connection:sync', 'sync'],
    ['server-connection:disconnect', 'disconnect']
  ]) {
    ipcMain.handle(channel, invoke((_event, ...args) => {
      exact(args, 0)
      return manager[method]()
    }))
  }
  ipcMain.handle('server-connection:list-models', invoke(async (_event, ...args) => {
    exact(args, 0)
    if (typeof syncModelProjection === 'function') await syncModelProjection()
    return (serverModelProjection?.listProfiles?.() || []).map(safeProfile)
  }))
  ipcMain.handle('server-connection:list-skills', invoke((_event, ...args) => {
    exact(args, 0)
    return skillsCatalog?.list() || []
  }))
  ipcMain.handle('server-connection:sync-skills', invoke(async (_event, ...args) => {
    exact(args, 0)
    if (skillsSyncCoordinator) {
      await skillsSyncCoordinator.ensureFresh({ force: true })
      return skillsCatalog?.list?.() || []
    }
    if (!skillsCatalog) throw Object.assign(new Error(), { code: 'SERVER_SKILL_UNAVAILABLE' })
    return skillsCatalog.sync()
  }))
  ipcMain.handle('server-connection:get-skills-sync-state', invoke((_event, ...args) => {
    exact(args, 0)
    if (!skillsSyncCoordinator) throw Object.assign(new Error(), { code: 'SERVER_SKILL_UNAVAILABLE' })
    return skillsSyncCoordinator.getState()
  }))
  ipcMain.handle('server-connection:ensure-skills-fresh', invoke((_event, ...args) => {
    if (!skillsSyncCoordinator) throw Object.assign(new Error(), { code: 'SERVER_SKILL_UNAVAILABLE' })
    return skillsSyncCoordinator.ensureFresh(skillsFreshOptions(args))
  }))
  for (const [channel, method] of [
    ['server-connection:install-skill', 'install'],
    ['server-connection:update-skill', 'update']
  ]) {
    ipcMain.handle(channel, invoke((_event, ...args) => {
      exact(args, 2)
      if (!skillsCatalog) throw Object.assign(new Error(), { code: 'SERVER_SKILL_UNAVAILABLE' })
      return skillsCatalog[method](versionId(args[0]), targets(args[1]))
    }))
  }
  manager.subscribe(state => send('server-connection:state', state))
  manager.onRegistrationRequested(attempt => send('server-connection:registration-requested', attempt))
}
