/**
 * Thin typed wrapper over the preload bridge (`window.ucli`). All renderer
 * access to the main process goes through here so the IPC surface stays in
 * one place.
 */
const u = window.ucli

export const ipc = {
  // logging
  log: (level, ...args) => u.log(level, ...args),

  // adapters
  listAdapters: () => u.listAdapters(),
  listCliTools: () => u.listCliTools(),
  runCliToolAction: (id, action) => u.runCliToolAction(id, action),
  // dialog
  pickDirectory: (defaultPath) => u.pickDirectory(defaultPath),
  openFolder: (dirPath) => u.openFolder(dirPath),
  openExternal: (url) => u.openExternal(url),
  scanClaudeSessions: (cwd) => u.scanClaudeSessions(cwd),
  discoverSessions: (cwd) => u.discoverSessions(cwd),
  // sessions
  createSession: (config) => u.createSession(config),
  startAdapter: (sessionId) => u.startAdapter(sessionId),
  sendTurn: (sessionId, text) => u.sendTurn(sessionId, text),
  respondApproval: (sessionId, requestId, verdict) => u.respondApproval(sessionId, requestId, verdict),
  interruptSession: (sessionId) => u.interruptSession(sessionId),
  sendTerminalInput: (sessionId, data) => u.sendTerminalInput(sessionId, data),
  terminalResize: (sessionId, cols, rows) => u.terminalResize(sessionId, cols, rows),
  attachTerminal: (sessionId) => u.attachTerminal(sessionId),
  resumeSession: (sessionId, cliSessionId) => u.resumeSession(sessionId, cliSessionId),
  stopSession: (sessionId) => u.stopSession(sessionId),
  restartSession: (sessionId) => u.restartSession(sessionId),
  deleteSession: (sessionId) => u.deleteSession(sessionId),
  listSessions: () => u.listSessions(),
  updateSessionNote: (sessionId, note) => u.updateSessionNote(sessionId, note),
  updateSessionName: (sessionId, name) => u.updateSessionName(sessionId, name),
  markSessionOpened: (sessionId) => u.markSessionOpened(sessionId),
  updateSessionCwd: (sessionId, cwd) => u.updateSessionCwd(sessionId, cwd),
  // rules
  getRules: () => u.getRules(),
  updateRules: (config) => u.updateRules(config),
  getBlacklist: () => u.getBlacklist(),
  testPattern: (payload) => u.testPattern(payload),
  // stats
  getStats: () => u.getStats(),
  // settings
  getVersion: () => u.getVersion(),
  getSettings: () => u.getSettings(),
  updateSettings: (s) => u.updateSettings(s),
  // workbench
  getWorkbench: () => u.getWorkbench(),
  saveWorkbench: (state) => u.saveWorkbench(state),
  // events
  on: (channel, handler) => u.on(channel, handler)
}

export default ipc
