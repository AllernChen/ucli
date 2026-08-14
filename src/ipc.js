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
  listDshProfiles: () => u.listDshProfiles(),
  enableDshBridge: (profileName) => u.enableDshBridge(profileName),
  getUpdateState: () => u.getUpdateState(),
  checkForUpdates: () => u.checkForUpdates(),
  downloadUpdate: () => u.downloadUpdate(),
  installUpdate: () => u.installUpdate(),
  onUpdateState: (handler) => u.onUpdateState(handler),
  getDiagnostics: () => u.getDiagnostics(),
  exportDiagnostics: () => u.exportDiagnostics(),
  getCodexRuntime: () => u.getCodexRuntime(),
  // AI CLI profiles
  getAiCliProfileState: (options) => u.getAiCliProfileState(options),
  createAiCliProfile: (draft) => u.createAiCliProfile(draft),
  updateAiCliProfile: (profileId, patch) => u.updateAiCliProfile(profileId, patch),
  setAiCliProfileSecret: (profileId, secret) => u.setAiCliProfileSecret(profileId, secret),
  deleteAiCliProfileSecret: (profileId) => u.deleteAiCliProfileSecret(profileId),
  deleteAiCliProfile: (profileId) => u.deleteAiCliProfile(profileId),
  setAiCliProfileBinding: (binding) => u.setAiCliProfileBinding(binding),
  listAiCliProfileRevisions: (profileId) => u.listAiCliProfileRevisions(profileId),
  rollbackAiCliProfile: (profileId, revisionId) => u.rollbackAiCliProfile(profileId, revisionId),
  repairAiCliProfile: (profileId) => u.repairAiCliProfile(profileId),
  reconcileAiCliProfiles: () => u.reconcileAiCliProfiles(),
  // Skills
  getSkillsState: (options) => u.getSkillsState(options),
  inspectSkillSource: (source, context) => u.inspectSkillSource(source, context),
  installSkill: (request) => u.installSkill(request),
  installSkills: (requests) => u.installSkills(requests),
  applySkillToAdapter: (packageId, targetAdapterId) => u.applySkillToAdapter(packageId, targetAdapterId),
  checkSkillUpdates: (packageIds) => u.checkSkillUpdates(packageIds),
  previewSkillUpdate: (packageId) => u.previewSkillUpdate(packageId),
  updateSkill: (packageId, expectedRevision) => u.updateSkill(packageId, expectedRevision),
  setSkillEnabled: (installationId, enabled) => u.setSkillEnabled(installationId, enabled),
  removeSkillInstallation: (installationId) => u.removeSkillInstallation(installationId),
  resolveSkillDrift: (installationId, resolution) => u.resolveSkillDrift(installationId, resolution),
  adoptSkill: (request) => u.adoptSkill(request),
  getSkillAffectedSessions: (installationIds) => u.getSkillAffectedSessions(installationIds),
  restartSkillSessions: (sessionIds) => u.restartSkillSessions(sessionIds),
  // dialog
  pickDirectory: () => u.pickDirectory(),
  pickSkillArchive: () => u.pickSkillArchive(),
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
  getSessionHistory: (sessionId, options) => u.getSessionHistory(sessionId, options),
  getSessionDiagnostics: (sessionId) => u.getSessionDiagnostics(sessionId),
  repairSessionBinding: (sessionId) => u.repairSessionBinding(sessionId),
  resumeSession: (sessionId, cliSessionId) => u.resumeSession(sessionId, cliSessionId),
  stopSession: (sessionId) => u.stopSession(sessionId),
  restartSession: (sessionId) => u.restartSession(sessionId),
  setSessionProfile: (sessionId, profileId) => u.setSessionProfile(sessionId, profileId),
  deleteSession: (sessionId) => u.deleteSession(sessionId),
  listSessions: () => u.listSessions(),
  updateSessionNote: (sessionId, note) => u.updateSessionNote(sessionId, note),
  updateSessionName: (sessionId, name) => u.updateSessionName(sessionId, name),
  updateCodexProviderPolicy: (sessionId, policy) => u.updateCodexProviderPolicy(sessionId, policy),
  // rules
  getRules: () => u.getRules(),
  updateRules: (config) => u.updateRules(config),
  getBlacklist: () => u.getBlacklist(),
  testPattern: (payload) => u.testPattern(payload),
  // stats
  getStats: () => u.getStats(),
  queryStats: (query) => u.queryStats(query),
  // settings
  getSettings: () => u.getSettings(),
  updateSettings: (s) => u.updateSettings(s),
  // application storage
  getStorageUsage: () => u.getStorageUsage(),
  clearStorageCategory: (categoryId) => u.clearStorageCategory(categoryId),
  // work summaries
  getSummarySettings: () => u.getSummarySettings(),
  setSummarySettings: (value) => u.setSummarySettings(value),
  listSummaryReports: (filters) => u.listSummaryReports(filters),
  getSummaryReport: (reportId) => u.getSummaryReport(reportId),
  generateSummary: (value) => u.generateSummary(value),
  confirmSummary: (reportId, confirmationCallLimit) => u.confirmSummary(reportId, confirmationCallLimit),
  cancelSummary: (reportId) => u.cancelSummary(reportId),
  setCurrentSummary: (reportId) => u.setCurrentSummary(reportId),
  deleteSummaryReport: (reportId) => u.deleteSummaryReport(reportId),
  exportSummaryMarkdown: (value) => u.exportSummaryMarkdown(value),
  exportSummaryHtml: (value) => u.exportSummaryHtml(value),
  getSummaryCacheStats: () => u.getSummaryCacheStats(),
  clearSummaryCache: (value) => u.clearSummaryCache(value),
  onSummaryProgress: (handler) => u.onSummaryProgress(handler),
  // communication Gateway
  getGatewayState: () => u.getGatewayState(),
  setGatewayDesiredEnabled: (enabled) => u.setGatewayDesiredEnabled(enabled),
  getGatewayConfiguration: () => u.getGatewayConfiguration(),
  testGatewayDraft: (draft) => u.testGatewayDraft(draft),
  applyGatewayDraft: (testId) => u.applyGatewayDraft(testId),
  confirmGatewayBinding: (bindingId) => u.confirmGatewayBinding(bindingId),
  dismissGatewayBinding: (bindingId) => u.dismissGatewayBinding(bindingId),
  clearGatewayBinding: () => u.clearGatewayBinding(),
  listGatewaySessions: () => u.listGatewaySessions(),
  setSessionRelayEnabled: (sessionId, enabled) =>
    u.setSessionRelayEnabled(sessionId, enabled),
  resyncGatewaySession: (sessionId) => u.resyncGatewaySession(sessionId),
  onGatewayState: (handler) => u.onGatewayState(handler),
  onCodexRuntime: (handler) => u.onCodexRuntime(handler),
  // workbench
  getWorkbench: () => u.getWorkbench(),
  saveWorkbench: (state) => u.saveWorkbench(state),
  // shell
  openExternal: (url) => u.openExternal(url),
  // events
  on: (channel, handler) => u.on(channel, handler)
}

export default ipc
