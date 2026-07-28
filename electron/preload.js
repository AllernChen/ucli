import { contextBridge, ipcRenderer } from 'electron'

/**
 * The single bridge between the renderer (Vue) and the main process.
 * Renderer code never touches Node directly — it calls `window.ucli.*`.
 *
 * Session events arrive via `on(channel, cb)`:
 *   'session:message'           { sessionId, ...activityEvent }
 *   'session:status'            { sessionId, status, error? }
 *   'session:approval-request'  { sessionId, requestId, tool, input, risk }
 *   'session:token-usage'       { sessionId, usage, costUsd }
 *   'session:turn-complete'     { sessionId, result, usage }
 *   'session:exit'              { sessionId, code }
 */
const api = {
  // ---- logging ----
  log: (level, ...args) => ipcRenderer.invoke('log:write', level, ...args),

  // ---- adapters / discovery ----
  listAdapters: () => ipcRenderer.invoke('adapters:list'),
  listCliTools: () => ipcRenderer.invoke('cli-tools:list'),
  runCliToolAction: (id, action) => ipcRenderer.invoke('cli-tools:run', id, action),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),

  // ---- dialog ----
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  scanClaudeSessions: (cwd) => ipcRenderer.invoke('session:scan-claude', cwd),
  discoverSessions: (cwd) => ipcRenderer.invoke('session:discover', cwd),

  // ---- session lifecycle ----
  createSession: (config) => ipcRenderer.invoke('session:create', config),
  startAdapter: (sessionId) => ipcRenderer.invoke('session:start-adapter', sessionId),
  sendTurn: (sessionId, text) => ipcRenderer.invoke('session:send-turn', sessionId, text),
  respondApproval: (sessionId, requestId, decision) =>
    ipcRenderer.invoke('session:respond-approval', sessionId, requestId, decision),
  interruptSession: (sessionId) => ipcRenderer.invoke('session:interrupt', sessionId),
  sendTerminalInput: (sessionId, data) => ipcRenderer.invoke('session:send-terminal-input', sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.invoke('session:terminal-resize', sessionId, cols, rows),
  attachTerminal: (sessionId) => ipcRenderer.invoke('session:attach-terminal', sessionId),
  resumeSession: (sessionId, cliSessionId) =>
    ipcRenderer.invoke('session:resume', sessionId, cliSessionId),
  stopSession: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  restartSession: (sessionId) => ipcRenderer.invoke('session:restart', sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
  listSessions: () => ipcRenderer.invoke('session:list'),
  updateSessionNote: (sessionId, note) => ipcRenderer.invoke('session:update-note', sessionId, note),
  updateSessionName: (sessionId, name) => ipcRenderer.invoke('session:update-name', sessionId, name),

  // ---- rules / permission ----
  getRules: () => ipcRenderer.invoke('rules:get'),
  updateRules: (config) => ipcRenderer.invoke('rules:update', config),
  getBlacklist: () => ipcRenderer.invoke('rules:blacklist'),
  testPattern: (sample, classifierInput) =>
    ipcRenderer.invoke('rules:test-pattern', sample, classifierInput),

  // ---- stats ----
  getStats: () => ipcRenderer.invoke('stats:get'),

  // ---- settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (s) => ipcRenderer.invoke('settings:update', s),

  // ---- workbench ----
  getWorkbench: () => ipcRenderer.invoke('workbench:get'),
  saveWorkbench: (state) => ipcRenderer.invoke('workbench:save', state),

  // ---- shell ----
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // ---- events ----
  on: (channel, handler) => {
    const wrapped = (_event, payload) => handler(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('ucli', api)
