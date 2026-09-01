/**
 * Thin typed wrapper over the preload bridge (`window.ucli`). All renderer
 * access to the main process goes through here so the IPC surface stays in
 * one place.
 */
const u = window.ucli

function validateSessionProfileSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
    Object.keys(selection).length !== 2 || !Object.hasOwn(selection, 'profileId') ||
    !Object.hasOwn(selection, 'model')) {
    throw new TypeError('Invalid session profile selection')
  }
  if (selection.profileId !== null && (typeof selection.profileId !== 'string' ||
    !selection.profileId || selection.profileId.length > 1024 || /[\0-\x1F\x7F]/.test(selection.profileId))) {
    throw new TypeError('Invalid session profile selection')
  }
  if (selection.profileId === null && selection.model !== null) {
    throw new TypeError('Invalid session profile selection')
  }
  if (selection.model !== null && (typeof selection.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:@/+~-]{0,255}$/.test(selection.model))) {
    throw new TypeError('Invalid session profile selection')
  }
  return { profileId: selection.profileId, model: selection.model }
}

export const ipc = {
  // logging
  log: (level, ...args) => u.log(level, ...args),

  // adapters
  listAdapters: () => u.listAdapters(),
  listCliTools: () => u.listCliTools(),
  runCliToolAction: (id, action) => u.runCliToolAction(id, action),
  getDshState: () => u.getDshState(),
  listDshProfiles: () => u.listDshProfiles(),
  initializeDshProfile: (profileName) => u.initializeDshProfile(profileName),
  installDshRuntime: () => u.installDshRuntime(),
  upgradeDshRuntime: () => u.upgradeDshRuntime(),
  repairDshRuntime: () => u.repairDshRuntime(),
  removeDshRuntime: () => u.removeDshRuntime(),
  removeDshLegacyBridge: (profileName) => u.removeDshLegacyBridge(profileName),
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
  previewSkillsBatchAction: (request) => u.previewSkillsBatchAction(request),
  applySkillsBatchAction: (request) => u.applySkillsBatchAction(request),
  applySkillToAdapter: (packageId, targetAdapterId) => u.applySkillToAdapter(packageId, targetAdapterId),
  previewCliStateChange: (request) => u.previewCliStateChange(request),
  applyCliStateChange: (request) => u.applyCliStateChange(request),
  resolveCliStateRecovery: (packageId) => u.resolveCliStateRecovery(packageId),
  checkSkillUpdates: (packageIds) => u.checkSkillUpdates(packageIds),
  previewSkillUpdate: (packageId) => u.previewSkillUpdate(packageId),
  updateSkill: (packageId, expectedRevision) => u.updateSkill(packageId, expectedRevision),
  setSkillEnabled: (installationId, enabled) => u.setSkillEnabled(installationId, enabled),
  removeSkillInstallation: (installationId) => u.removeSkillInstallation(installationId),
  removePackage: (packageId) => u.removePackage(packageId),
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
  // session artifacts
  listArtifacts: (sessionId) => u.listArtifacts(sessionId),
  readArtifact: (sessionId, absolutePath, options) => u.readArtifact(sessionId, absolutePath, options),
  openArtifactWindow: (sessionId) => u.openArtifactWindow(sessionId),
  getSessionDiagnostics: (sessionId) => u.getSessionDiagnostics(sessionId),
  repairSessionBinding: (sessionId) => u.repairSessionBinding(sessionId),
  resumeSession: (sessionId, cliSessionId) => u.resumeSession(sessionId, cliSessionId),
  stopSession: (sessionId) => u.stopSession(sessionId),
  restartSession: (sessionId) => u.restartSession(sessionId),
  setSessionProfile: (sessionId, selection) => u.setSessionProfile(sessionId, validateSessionProfileSelection(selection)),
  deleteSession: (sessionId) => u.deleteSession(sessionId),
  listSessions: () => u.listSessions(),
  updateSessionNote: (sessionId, note) => u.updateSessionNote(sessionId, note),
  resetNativeSession: (sessionId) => u.resetNativeSession(sessionId),
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
  updateSummaryTask: (value) => u.updateSummaryTask(value),
  generateSummary: (value) => u.generateSummary(value),
  startInteractiveSummary: (value) => u.startInteractiveSummary(value),
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
  // server connection
  serverConnection: {
    submitLink: (input) => u.submitServerConnectionLink(input),
    getAttempt: (attemptId) => u.getServerConnectionAttempt(attemptId),
    getPendingAttempt: () => u.getPendingServerConnectionAttempt(),
    confirm: (attemptId) => u.confirmServerConnection(attemptId),
    retryRedeem: (attemptId) => u.retryServerConnectionRedeem(attemptId),
    cancel: (attemptId) => u.cancelServerConnectionAttempt(attemptId),
    getState: () => u.getServerConnectionState(),
    retry: () => u.retryServerConnection(),
    sync: () => u.syncServerConnection(),
    disconnect: () => u.disconnectServerConnection(),
    listModels: () => u.listServerConnectionModels(),
    listSkills: () => u.listServerConnectionSkills(),
    syncSkills: () => u.syncServerConnectionSkills(),
    getSkillsSyncState: () => u.getServerConnectionSkillsSyncState(),
    ensureSkillsFresh: (options) => u.ensureServerConnectionSkillsFresh(options),
    installSkill: (versionId, targets) => u.installServerConnectionSkill(versionId, targets),
    updateSkill: (versionId, targets) => u.updateServerConnectionSkill(versionId, targets),
    onStateChanged: (handler) => u.onServerConnectionState(handler),
    onRegistrationRequested: (handler) => u.onServerConnectionRegistrationRequested(handler),
    onSkillsCatalogChanged: (handler) => u.onServerConnectionSkillsCatalogChanged(handler)
  },
  // workbench
  getWorkbench: () => u.getWorkbench(),
  saveWorkbench: (state) => u.saveWorkbench(state),
  // shell
  openExternal: (url) => u.openExternal(url),
  openPath: (path) => u.openPath(path),
  showItemInFolder: (path) => u.showItemInFolder(path),
  // events
  on: (channel, handler) => u.on(channel, handler)
}

export default ipc
