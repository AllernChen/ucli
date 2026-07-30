function ipcError(message) {
  return Object.assign(new TypeError(message), {
    code: 'INVALID_GATEWAY_IPC'
  })
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw ipcError(`${field} must be boolean`)
  return value
}

function requireOpaqueId(value, field) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw ipcError(`${field} is invalid`)
  }
  return value
}

function requireDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ipcError('draft must be an object')
  }
  return value
}

export function registerGatewayIpc({ ipcMain, manager }) {
  ipcMain.handle('gateway:get-state', () => manager.getState())
  ipcMain.handle('gateway:set-desired-enabled', async (_event, enabled) =>
    manager.setDesiredEnabled(requireBoolean(enabled, 'enabled'))
  )
  ipcMain.handle('gateway:get-configuration', () => manager.getConfiguration())
  ipcMain.handle('gateway:test-draft', async (_event, draft) =>
    manager.testDraft(requireDraft(draft))
  )
  ipcMain.handle('gateway:apply-draft', async (_event, testId) =>
    manager.applyDraft(requireOpaqueId(testId, 'testId'))
  )
  ipcMain.handle('gateway:list-sessions', () => manager.listSessions())
  ipcMain.handle('gateway:set-session-relay', async (_event, sessionId, enabled) =>
    manager.setSessionRelayEnabled(
      requireOpaqueId(sessionId, 'sessionId'),
      requireBoolean(enabled, 'enabled')
    )
  )
  ipcMain.handle('gateway:resync-session', async (_event, sessionId) =>
    manager.resyncSession(requireOpaqueId(sessionId, 'sessionId'))
  )
}
