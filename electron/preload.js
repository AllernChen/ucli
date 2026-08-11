import { contextBridge, ipcRenderer } from 'electron'

async function invokeSummary(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args)
  if (response?.ok) return response.value
  const payload = response?.error || {
    code: 'SUMMARY_SERVICE_UNAVAILABLE',
    message: 'Summary service is unavailable'
  }
  throw Object.assign(new Error(payload.message), { code: payload.code })
}

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
  getCodexRuntime: () => ipcRenderer.invoke('codex:runtime:get'),

  // ---- AI CLI profiles ----
  getAiCliProfileState: (options) => ipcRenderer.invoke('ai-cli-profiles:get-state', options || {}),
  createAiCliProfile: (draft) => ipcRenderer.invoke('ai-cli-profiles:create', draft),
  updateAiCliProfile: (profileId, patch) => ipcRenderer.invoke('ai-cli-profiles:update', profileId, patch),
  setAiCliProfileSecret: (profileId, secret) => ipcRenderer.invoke('ai-cli-profiles:set-secret', profileId, secret),
  deleteAiCliProfileSecret: (profileId) => ipcRenderer.invoke('ai-cli-profiles:delete-secret', profileId),
  deleteAiCliProfile: (profileId) => ipcRenderer.invoke('ai-cli-profiles:delete', profileId),
  setAiCliProfileBinding: (binding) => ipcRenderer.invoke('ai-cli-profiles:set-binding', binding),
  listAiCliProfileRevisions: (profileId) => ipcRenderer.invoke('ai-cli-profiles:list-revisions', profileId),
  rollbackAiCliProfile: (profileId, revisionId) => ipcRenderer.invoke('ai-cli-profiles:rollback', profileId, revisionId),
  repairAiCliProfile: (profileId) => ipcRenderer.invoke('ai-cli-profiles:repair', profileId),
  reconcileAiCliProfiles: () => ipcRenderer.invoke('ai-cli-profiles:reconcile'),

  // ---- Skills ----
  getSkillsState: (options) => ipcRenderer.invoke('skills:get-state', options || {}),
  inspectSkillSource: (source, context) => ipcRenderer.invoke('skills:inspect-source', source, context),
  installSkill: (request) => ipcRenderer.invoke('skills:install', request),
  installSkills: (requests) => ipcRenderer.invoke('skills:install-many', requests),
  applySkillToAdapter: (packageId, targetAdapterId) => ipcRenderer.invoke('skills:apply-to-adapter', { packageId, targetAdapterId }),
  checkSkillUpdates: (packageIds) => ipcRenderer.invoke('skills:check-updates', packageIds ?? null),
  previewSkillUpdate: (packageId) => ipcRenderer.invoke('skills:preview-update', packageId),
  updateSkill: (packageId, expectedRevision) => ipcRenderer.invoke('skills:update', packageId, expectedRevision ?? null),
  setSkillEnabled: (installationId, enabled) => ipcRenderer.invoke('skills:set-enabled', installationId, enabled),
  removeSkillInstallation: (installationId) => ipcRenderer.invoke('skills:remove-installation', installationId),
  resolveSkillDrift: (installationId, resolution) => ipcRenderer.invoke('skills:resolve-drift', installationId, resolution),
  adoptSkill: (request) => ipcRenderer.invoke('skills:adopt', request),
  getSkillAffectedSessions: (installationIds) => ipcRenderer.invoke('skills:get-affected-sessions', installationIds),
  restartSkillSessions: (sessionIds) => ipcRenderer.invoke('skills:restart-sessions', sessionIds),

  // ---- dialog ----
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  pickSkillArchive: () => ipcRenderer.invoke('dialog:pick-skill-archive'),
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
  getSessionHistory: (sessionId, options) =>
    ipcRenderer.invoke('session:get-history', sessionId, options),
  getSessionDiagnostics: (sessionId) =>
    ipcRenderer.invoke('session:get-diagnostics', sessionId),
  repairSessionBinding: (sessionId) =>
    ipcRenderer.invoke('session:repair-binding', sessionId),
  resumeSession: (sessionId, cliSessionId) =>
    ipcRenderer.invoke('session:resume', sessionId, cliSessionId),
  stopSession: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  restartSession: (sessionId) => ipcRenderer.invoke('session:restart', sessionId),
  setSessionProfile: (sessionId, profileId) =>
    ipcRenderer.invoke('session:set-profile', sessionId, profileId),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
  listSessions: () => ipcRenderer.invoke('session:list'),
  updateSessionNote: (sessionId, note) => ipcRenderer.invoke('session:update-note', sessionId, note),
  updateSessionName: (sessionId, name) => ipcRenderer.invoke('session:update-name', sessionId, name),
  updateCodexProviderPolicy: (sessionId, policy) =>
    ipcRenderer.invoke('session:update-codex-provider-policy', sessionId, policy),

  // ---- rules / permission ----
  getRules: () => ipcRenderer.invoke('rules:get'),
  updateRules: (config) => ipcRenderer.invoke('rules:update', config),
  getBlacklist: () => ipcRenderer.invoke('rules:blacklist'),
  testPattern: (sample, classifierInput) =>
    ipcRenderer.invoke('rules:test-pattern', sample, classifierInput),

  // ---- stats ----
  getStats: () => ipcRenderer.invoke('stats:get'),
  queryStats: async (query) => {
    const response = await ipcRenderer.invoke('stats:query', query)
    if (response?.ok) return response.value
    const payload = response?.error || {
      code: 'USAGE_QUERY_FAILED',
      message: 'Unable to query usage'
    }
    const error = new Error(payload.message)
    error.code = payload.code
    if (typeof payload.suggestedGranularity === 'string') {
      error.suggestedGranularity = payload.suggestedGranularity
    }
    throw error
  },

  // ---- settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (s) => ipcRenderer.invoke('settings:update', s),

  // ---- work summaries ----
  getSummarySettings: () => invokeSummary('summary:get-settings'),
  setSummarySettings: (value) => invokeSummary('summary:set-settings', value),
  listSummaryReports: (filters) => invokeSummary('summary:list-reports', filters || {}),
  getSummaryReport: (reportId) => invokeSummary('summary:get-report', reportId),
  generateSummary: (value) => invokeSummary('summary:generate', value),
  confirmSummary: (reportId, confirmationCallLimit) => invokeSummary('summary:generate', {
    reportId, confirm: true, confirmationCallLimit
  }),
  cancelSummary: (reportId) => invokeSummary('summary:cancel', reportId),
  setCurrentSummary: (reportId) => invokeSummary('summary:set-current', reportId),
  exportSummaryMarkdown: (value) => invokeSummary('summary:export-markdown', value),
  exportSummaryHtml: (value) => invokeSummary('summary:export-html', value),
  onSummaryProgress: (handler) => {
    const wrapped = (_event, payload) => handler(payload)
    ipcRenderer.on('summary:progress', wrapped)
    return () => ipcRenderer.removeListener('summary:progress', wrapped)
  },

  // ---- communication Gateway ----
  getGatewayState: () => ipcRenderer.invoke('gateway:get-state'),
  setGatewayDesiredEnabled: (enabled) =>
    ipcRenderer.invoke('gateway:set-desired-enabled', enabled),
  getGatewayConfiguration: () =>
    ipcRenderer.invoke('gateway:get-configuration'),
  testGatewayDraft: (draft) => ipcRenderer.invoke('gateway:test-draft', draft),
  applyGatewayDraft: (testId) =>
    ipcRenderer.invoke('gateway:apply-draft', testId),
  confirmGatewayBinding: (bindingId) =>
    ipcRenderer.invoke('gateway:confirm-binding', bindingId),
  dismissGatewayBinding: (bindingId) =>
    ipcRenderer.invoke('gateway:dismiss-binding', bindingId),
  clearGatewayBinding: () => ipcRenderer.invoke('gateway:clear-binding'),
  listGatewaySessions: () => ipcRenderer.invoke('gateway:list-sessions'),
  setSessionRelayEnabled: (sessionId, enabled) =>
    ipcRenderer.invoke('gateway:set-session-relay', sessionId, enabled),
  resyncGatewaySession: (sessionId) =>
    ipcRenderer.invoke('gateway:resync-session', sessionId),
  onGatewayState: (handler) => {
    const wrapped = (_event, payload) => handler(payload)
    ipcRenderer.on('gateway:state', wrapped)
    return () => ipcRenderer.removeListener('gateway:state', wrapped)
  },
  onCodexRuntime: (handler) => {
    const wrapped = (_event, payload) => handler(payload)
    ipcRenderer.on('codex:runtime', wrapped)
    return () => ipcRenderer.removeListener('codex:runtime', wrapped)
  },

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
