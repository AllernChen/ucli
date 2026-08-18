import { defineStore } from 'pinia'
import { DSH_UNAVAILABLE_CAPABILITIES } from '../../electron/adapters/adapterCapabilities.js'
import { ipc } from '../ipc.js'

let unsub = null
let actCounter = 0
const MAX_ACTIVITIES = 200 // keep DOM light — older events are trimmed from the head

function newActId() {
  actCounter += 1
  return `a${Date.now()}_${actCounter}`
}

function normalizeRendererCapabilities(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    !['terminal', 'web', 'unavailable'].includes(value.surface) ||
    !['ucli', 'native'].includes(value.permissionOwner) ||
    !['ucli', 'native'].includes(value.historyOwner) ||
    !['ucli', 'native'].includes(value.statsOwner) ||
    typeof value.gateway !== 'boolean' || typeof value.bridge !== 'boolean'
  ) return null
  return {
    surface: value.surface,
    permissionOwner: value.permissionOwner,
    historyOwner: value.historyOwner,
    statsOwner: value.statsOwner,
    gateway: value.gateway,
    bridge: value.bridge
  }
}

function rendererSessionCapabilities(adapterId, value, descriptor) {
  const candidate = value ?? (adapterId === 'deepseek-harness' ? null : descriptor?.capabilities)
  const normalized = normalizeRendererCapabilities(candidate)
  if (adapterId !== 'deepseek-harness') return normalized
  if (!normalized) return DSH_UNAVAILABLE_CAPABILITIES
  const nativeWeb = normalized.surface === 'web' &&
    normalized.permissionOwner === 'native' && normalized.historyOwner === 'native' &&
    normalized.gateway === false && normalized.bridge === false
  const unavailable = normalized.surface === 'unavailable' &&
    normalized.permissionOwner === 'native' && normalized.historyOwner === 'native' &&
    normalized.statsOwner === 'native' && normalized.gateway === false && normalized.bridge === false
  return nativeWeb || unavailable ? normalized : DSH_UNAVAILABLE_CAPABILITIES
}

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    adapters: [],
    sessions: [], // summary cards: {id, adapterId, displayName, icon, cwd, model, tier, status, stats, cliSessionId, lastActivity, lastActivityTs, updatedAt, taskNote, contextWindow, maxOutputTokens}
    activities: {}, // sessionId -> [activityItem]
    pendingApprovals: {}, // sessionId -> [approvalReq]
    pendingAssign: null, // sessionId to auto-assign on SessionDetail load
    // Persisted workbench state — survives route changes
    workbench: {
      splitCount: 1,
      activePane: 0,
      paneSessionIds: [], // [sessionId|null, ...] — which session is in each pane
      navCollapsed: false,
      sessionListHidden: false
    }
  }),

  getters: {
    totalWaiting(state) {
      return Object.values(state.pendingApprovals).reduce((n, list) => n + list.length, 0)
    },
    byId: (state) => (id) => state.sessions.find((s) => s.id === id),
    activitiesFor: (state) => (id) => state.activities[id] || []
  },

  actions: {
    async init() {
      this.adapters = await ipc.listAdapters()
      if (unsub) return
      const offs = [
        ipc.on('session:event', (e) => this._onEvent(e)),
        ipc.on('session:approval-request', (r) => this._onApprovalRequest(r)),
        ipc.on('session:approval-resolved', (r) => this._onApprovalResolved(r))
      ]
      unsub = () => offs.forEach((fn) => fn && fn())
      // Rehydrate persisted sessions from SQLite (app restart / renderer reload)
      const list = await ipc.listSessions()
      for (const s of list) this._upsertSummary(s)
    },

    async createSession(config) {
      const created = await ipc.createSession(config)
      const { sessionId } = created
      const adapter = this.adapters.find((a) => a.id === (config.adapterId || 'claude'))
      const isImport = !!config.cliSessionId
      const summary = {
        id: sessionId,
        adapterId: config.adapterId || 'claude',
        displayName: isImport
          ? (config.name || adapter?.displayName || config.adapterId) + ' · ' + fmtShort(config.startedAt)
          : (config.name || adapter?.displayName || config.adapterId),
        icon: adapter?.icon || '•',
        cwd: config.cwd,
        model: config.model || adapter?.models?.[0] || null,
        provider: config.provider || null,
        sourceProvider: config.sourceProvider || null,
        providerPolicy: config.providerPolicy || (config.cliSessionId ? 'source' : 'live'),
        explicitProvider: config.explicitProvider || null,
        profileId: config.profileId || null,
        activeProfileId: null,
        pendingProfileId: null,
        profileStatus: null,
        actualModel: null,
        profileWarning: null,
        tier: config.tier,
        status: 'starting',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: config.startedAt || null,
        stats: { tokens: { input: 0, output: 0 }, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
        cliSessionId: config.cliSessionId || null,
        nativeSessionId: config.cliSessionId || null,
        adapterConfig: created.adapterConfig || {},
        capabilities: rendererSessionCapabilities(config.adapterId || 'claude', created.capabilities, adapter),
        surfaceState: created.surfaceState || null,
        lastActivity: isImport ? ('📋 已恢复 · ' + fmtShort(config.startedAt)) : '启动中…',
        lastActivityTs: Date.now(),
        taskNote: '',
        contextWindow: null,
        maxOutputTokens: null
      }
      this.sessions.push(summary)
      this.activities[sessionId] = []
      this.pendingApprovals[sessionId] = []
      return sessionId
    },

    sendTurn(id, text) { return ipc.sendTurn(id, text) },
    respondApproval(id, requestId, verdict) { return ipc.respondApproval(id, requestId, verdict) },
    interrupt(id) { return ipc.interruptSession(id) },
    resume(id, cliSessionId) { return ipc.resumeSession(id, cliSessionId) },
    getDiagnostics(id) { return ipc.getSessionDiagnostics(id) },
    async repairBinding(id) {
      const result = await ipc.repairSessionBinding(id)
      const nativeSessionId = result?.diagnostic?.resolvedNativeSessionId
      const row = this.sessions.find((session) => session.id === id)
      if (row && nativeSessionId) row.cliSessionId = nativeSessionId
      return result
    },
    async stop(id) {
      await ipc.stopSession(id)
      const i = this.sessions.findIndex((s) => s.id === id)
      if (i >= 0) this.sessions[i].status = 'offline'
    },
    async restart(id) {
      await ipc.restartSession(id)
      const i = this.sessions.findIndex((s) => s.id === id)
      if (i >= 0) this.sessions[i].status = 'starting'
    },
    async deleteSession(id) {
      await ipc.deleteSession(id)
      const i = this.sessions.findIndex((s) => s.id === id)
      if (i >= 0) this.sessions.splice(i, 1)
      delete this.activities[id]
      delete this.pendingApprovals[id]
    },
    async updateNote(id, note) {
      const row = this.sessions.find((s) => s.id === id)
      if (row) row.taskNote = note
      await ipc.updateSessionNote(id, note)
    },
    async updateName(id, name) {
      const row = this.sessions.find((s) => s.id === id)
      if (row) row.displayName = name
      await ipc.updateSessionName(id, name)
    },
    async setProfile(id, profileId) {
      const result = await ipc.setSessionProfile(id, profileId || null)
      const row = this.sessions.find((session) => session.id === id)
      if (row) Object.assign(row, result)
      return result
    },
    async updateCodexProviderPolicy(id, policy) {
      const result = await ipc.updateCodexProviderPolicy(id, policy)
      const row = this.sessions.find((s) => s.id === id)
      if (row) Object.assign(row, result)
      return result
    },

    // Workbench state persistence
    async loadWorkbench() {
      try {
        const wb = await ipc.getWorkbench()
        ipc.log('info', 'loadWorkbench received:', JSON.stringify(wb))
        if (wb?.paneSessionIds) {
          this.workbench.splitCount = wb.splitCount || 1
          this.workbench.activePane = wb.activePane || 0
          this.workbench.paneSessionIds = wb.paneSessionIds
          if (wb.navCollapsed !== undefined) this.workbench.navCollapsed = wb.navCollapsed
          if (wb.sessionListHidden !== undefined) this.workbench.sessionListHidden = wb.sessionListHidden
          ipc.log('info', 'loadWorkbench — restored workbench state')
        } else {
          ipc.log('info', 'loadWorkbench — no saved workbench, using defaults')
        }
      } catch (err) {
        ipc.log('error', 'loadWorkbench failed:', err?.message || err)
        /* no saved workbench */
      }
    },
    async saveWorkbench() {
      const payload = {
        splitCount: this.workbench.splitCount,
        activePane: this.workbench.activePane,
        paneSessionIds: [...this.workbench.paneSessionIds], // plain array, not Vue Proxy
        navCollapsed: this.workbench.navCollapsed,
        sessionListHidden: this.workbench.sessionListHidden
      }
      ipc.log('info', 'saveWorkbench called, payload:', JSON.stringify(payload))
      try {
        const result = await ipc.saveWorkbench(payload)
        ipc.log('info', 'saveWorkbench completed, result:', result)
      } catch (err) {
        ipc.log('error', 'saveWorkbench FAILED:', err?.message || err)
        console.error('[saveWorkbench]', err)
      }
    },
    setWorkbenchSplit(count) {
      ipc.log('info', 'setWorkbenchSplit', count)
      this.workbench.splitCount = count
      while (this.workbench.paneSessionIds.length < count) {
        this.workbench.paneSessionIds.push(null)
      }
      this.saveWorkbench()
    },
    setWorkbenchPane(index, sessionId) {
      ipc.log('info', 'setWorkbenchPane', index, sessionId)
      this.workbench.paneSessionIds[index] = sessionId
      this.saveWorkbench()
    },
    setWorkbenchActivePane(index) {
      ipc.log('info', 'setWorkbenchActivePane', index)
      this.workbench.activePane = index
      this.saveWorkbench()
    },
    setNavCollapsed(v) {
      this.workbench.navCollapsed = v
      this.saveWorkbench()
    },
    setSessionListHidden(v) {
      this.workbench.sessionListHidden = v
      this.saveWorkbench()
    },

    _upsertSummary(s) {
      let row = this.sessions.find((x) => x.id === s.id)
      const adapter = this.adapters.find((a) => a.id === s.adapterId)
      if (!row) {
        const isImport = !!(s.cliSessionId || s.nativeSessionId)
        const displayName = isImport
          ? (s.name || s.displayName || 'Claude') + (s.startedAt ? ' · ' + fmtShort(s.startedAt) : '')
          : (s.name || adapter?.displayName || s.adapterId)
        row = {
          id: s.id, adapterId: s.adapterId, displayName,
          icon: adapter?.icon || '•', cwd: s.cwd, model: s.model, tier: s.tier, status: s.status,
          stats: s.stats, cliSessionId: s.cliSessionId || s.nativeSessionId || null,
          nativeSessionId: s.nativeSessionId || s.cliSessionId || null,
          adapterConfig: s.adapterConfig || {},
          capabilities: rendererSessionCapabilities(s.adapterId, s.capabilities, adapter),
          surfaceState: s.surfaceState || null,
          provider: s.provider || null, sourceProvider: s.sourceProvider || null,
          providerPolicy: s.providerPolicy || null, explicitProvider: s.explicitProvider || null,
          providerWarning: s.providerWarning || null, pendingProvider: s.pendingProvider || null,
          pendingProviderWarning: s.pendingProviderWarning || null,
          profileId: s.profileId || null, activeProfileId: s.activeProfileId || null,
          pendingProfileId: s.pendingProfileId || null, profileStatus: s.profileStatus || null,
          actualModel: s.actualModel || null, profileWarning: s.profileWarning || null,
          restartRequired: Boolean(s.restartRequired), canStart: s.canStart !== false,
          startedAt: s.startedAt || null,
          lastActivity: isImport ? ('📋 已离线 · ' + fmtShort(s.startedAt)) : '已离线',
          lastActivityTs: s.updatedAt || s.createdAt || s.startedAt || 0,
          updatedAt: s.updatedAt || s.createdAt || null,
          taskNote: s.taskNote || '', contextWindow: s.contextWindow || null, maxOutputTokens: s.maxOutputTokens || null
        }
        this.sessions.push(row)
        this.activities[s.id] = []
        this.pendingApprovals[s.id] = []
      } else {
        row.status = s.status
        row.stats = s.stats
        if (s.cliSessionId) row.cliSessionId = s.cliSessionId
        if (s.nativeSessionId) row.nativeSessionId = s.nativeSessionId
        if (s.adapterConfig !== undefined) row.adapterConfig = s.adapterConfig
        if (s.capabilities !== undefined) {
          row.capabilities = rendererSessionCapabilities(s.adapterId, s.capabilities, adapter)
        }
        if (s.surfaceState !== undefined) row.surfaceState = s.surfaceState
        if (s.lastActivity) row.lastActivity = s.lastActivity
        if (s.taskNote != null) row.taskNote = s.taskNote
        if (s.provider != null) row.provider = s.provider
        if (s.sourceProvider != null) row.sourceProvider = s.sourceProvider
        if (s.providerPolicy != null) row.providerPolicy = s.providerPolicy
        if (s.explicitProvider != null) row.explicitProvider = s.explicitProvider
        if (s.providerWarning !== undefined) row.providerWarning = s.providerWarning
        if (s.pendingProvider !== undefined) row.pendingProvider = s.pendingProvider
        if (s.pendingProviderWarning !== undefined) row.pendingProviderWarning = s.pendingProviderWarning
        if (s.profileId !== undefined) row.profileId = s.profileId
        if (s.activeProfileId !== undefined) row.activeProfileId = s.activeProfileId
        if (s.pendingProfileId !== undefined) row.pendingProfileId = s.pendingProfileId
        if (s.profileStatus !== undefined) row.profileStatus = s.profileStatus
        if (s.actualModel !== undefined) row.actualModel = s.actualModel
        if (s.profileWarning !== undefined) row.profileWarning = s.profileWarning
        if (s.restartRequired !== undefined) row.restartRequired = s.restartRequired
        if (s.canStart !== undefined) row.canStart = s.canStart
        if (s.createdAt) row.createdAt = s.createdAt
        if (s.updatedAt) {
          row.updatedAt = s.updatedAt
          row.lastActivityTs = s.updatedAt
        }
      }
    },

    _onEvent(evt) {
      const row = this.sessions.find((s) => s.id === evt.sessionId)
      if (evt.type === 'stats_update' && row?.capabilities?.statsOwner !== 'ucli') return
      if (row) {
        if (evt.status) row.status = evt.status
        if (evt.type === 'ready') {
          row.lastActivity = '已就绪'
        } else if (evt.type === 'init') {
          if (evt.cliSessionId) {
            row.cliSessionId = evt.cliSessionId
            row.nativeSessionId = evt.cliSessionId
          }
        } else if (evt.type === 'exit') {
          row.lastActivity = `进程退出 (${evt.code})`
        } else if (evt.type === 'error') {
          row.lastActivity = `错误: ${evt.message}`
        } else if (evt.type === 'surface_state') {
          if (evt.surfaceState?.kind === 'web') row.surfaceState = evt.surfaceState
        } else if (evt.type === 'codex-runtime') {
          if (evt.provider != null) row.provider = evt.provider
          if (evt.providerPolicy != null) row.providerPolicy = evt.providerPolicy
          if (evt.explicitProvider != null) row.explicitProvider = evt.explicitProvider
          if (evt.providerWarning !== undefined) row.providerWarning = evt.providerWarning
          if (evt.pendingProvider !== undefined) row.pendingProvider = evt.pendingProvider
          if (evt.pendingProviderWarning !== undefined) row.pendingProviderWarning = evt.pendingProviderWarning
          if (evt.restartRequired !== undefined) row.restartRequired = evt.restartRequired
          if (evt.canStart !== undefined) row.canStart = evt.canStart
        } else if (evt.type === 'profile-runtime') {
          if (evt.profileId !== undefined) row.profileId = evt.profileId
          if (evt.activeProfileId !== undefined) row.activeProfileId = evt.activeProfileId
          if (evt.pendingProfileId !== undefined) row.pendingProfileId = evt.pendingProfileId
          if (evt.profileStatus !== undefined) row.profileStatus = evt.profileStatus
          if (evt.restartRequired !== undefined) row.restartRequired = Boolean(evt.restartRequired)
          if (evt.canStart !== undefined) row.canStart = evt.canStart !== false
        } else if (evt.type === 'profile-model') {
          if (typeof evt.actualModel === 'string') row.actualModel = evt.actualModel
          if (evt.profileWarning === 'model_substituted' || evt.profileWarning === null) {
            row.profileWarning = evt.profileWarning
          }
        } else if (evt.type === 'stats_update') {
          // Live stats from transcript extraction
          row.stats.tokens = { input: evt.usage.inputTokens, output: evt.usage.outputTokens }
          if (evt.costUsd != null) row.stats.costUsd = evt.costUsd
          if (evt.turns != null) row.stats.turns = evt.turns
          if (evt.model && !(row.adapterId === 'claude' && row.profileId)) row.model = evt.model
          if (typeof evt.actualModel === 'string') row.actualModel = evt.actualModel
          if (evt.profileWarning === 'model_substituted' || evt.profileWarning === null) {
            row.profileWarning = evt.profileWarning
          }
          if (evt.contextWindow) row.contextWindow = evt.contextWindow
          row.lastActivity = `↑${evt.usage.inputTokens.toLocaleString()} ↓${evt.usage.outputTokens.toLocaleString()}`
        }
        row.lastActivityTs = evt.ts || Date.now()
        row.updatedAt = row.lastActivityTs
      }
      this._appendActivity(evt)
    },

    _appendActivity(evt) {
      // Don't log raw terminal data — it floods the activity list and
      // pushes out structured events (message, tool_call) that TaskSummary needs.
      // Terminal output goes directly to xterm.js via session:terminal-output.
      if (evt.type === 'terminal' || evt.type === 'cli_raw') return
      const list = this.activities[evt.sessionId] || (this.activities[evt.sessionId] = [])
      list.push({ id: newActId(), ...evt })
      if (list.length > MAX_ACTIVITIES) list.splice(0, list.length - MAX_ACTIVITIES)
    },

    _onApprovalRequest(req) {
      const row = this.sessions.find((s) => s.id === req.sessionId)
      if (row?.capabilities?.permissionOwner !== 'ucli') return
      if (!this.pendingApprovals[req.sessionId]) this.pendingApprovals[req.sessionId] = []
      this.pendingApprovals[req.sessionId].push(req)
      if (row) row.status = 'waiting'
    },
    _onApprovalResolved(req) {
      const list = this.pendingApprovals[req.sessionId]
      if (list) {
        const i = list.findIndex((r) => r.requestId === req.requestId)
        if (i >= 0) list.splice(i, 1)
      }
      const row = this.sessions.find((s) => s.id === req.sessionId)
      if (row && (!this.pendingApprovals[req.sessionId] || this.pendingApprovals[req.sessionId].length === 0)) {
        row.status = 'running'
      }
    }
  }
})

function fmtShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
