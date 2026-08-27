import { sanitiseServerError } from './contracts.js'

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,200}$/
const LOCAL_ERRORS = Object.freeze({
  SECURE_STORAGE_UNAVAILABLE: ['Secure storage is unavailable', false],
  PERSISTENCE_PENDING: ['Server credentials could not be saved', true],
  SERVER_CREDENTIAL_ENCRYPT_FAILED: ['Server credentials could not be encrypted', false],
  SERVER_CANDIDATE_NOT_FOUND: ['Server registration could not be completed', false]
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

export function registerServerConnectionIpc({ ipcMain, manager, send = () => {} } = {}) {
  if (!ipcMain?.handle || !manager) throw new TypeError('IPC dependencies are required')
  ipcMain.handle('server-connection:submit-link', invoke((_event, ...args) => {
    exact(args, 1)
    return manager.submitLink(input(args[0]))
  }))
  ipcMain.handle('server-connection:get-attempt', invoke((_event, ...args) => {
    exact(args, 1)
    return manager.getAttempt(attemptId(args[0]))
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
    ['server-connection:disconnect', 'disconnect'],
    ['server-connection:list-models', 'listModels'],
    ['server-connection:list-skills', 'listSkills']
  ]) {
    ipcMain.handle(channel, invoke((_event, ...args) => {
      exact(args, 0)
      return manager[method]()
    }))
  }
  manager.subscribe(state => send('server-connection:state', state))
  manager.onRegistrationRequested(attempt => send('server-connection:registration-requested', attempt))
}
