import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

let unsub = null
let actCounter = 0
const MAX_ACTIVITIES = 200 // keep DOM light — older events are trimmed from the head

function newActId() {
  actCounter += 1
  return `a${Date.now()}_${actCounter}`
}

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    adapters: [],
    sessions: [], // summary cards: {id, adapterId, displayName, icon, cwd, model, tier, status, stats, cliSessionId, lastActivity, lastActivityTs, taskNote, contextWindow, maxOutputTokens}
    activities: {}, // sessionId -> [activityItem]
    pendingApprovals: {}, // sessionId -> [approvalReq]
    pendingAssign: null, // sessionId to auto-assign on SessionDetail load
    // Persisted workbench state — survives route changes
    workbench: {
      splitCount: 1,
      activePane: 0,
      paneSessionIds: [] // [sessionId|null, ...] — which session is in each pane
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
      const { sessionId } = await ipc.createSession(config)
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
        tier: config.tier,
        status: 'starting',
        createdAt: Date.now(),
        startedAt: config.startedAt || null,
        stats: { tokens: { input: 0, output: 0 }, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
        cliSessionId: config.cliSessionId || null,
        startedAt: config.startedAt || null,
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

    // Workbench state persistence
    setWorkbenchSplit(count) {
      this.workbench.splitCount = count
      // Extend paneSessionIds if needed
      while (this.workbench.paneSessionIds.length < count) {
        this.workbench.paneSessionIds.push(null)
      }
    },
    setWorkbenchPane(index, sessionId) {
      this.workbench.paneSessionIds[index] = sessionId
    },
    setWorkbenchActivePane(index) {
      this.workbench.activePane = index
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
          startedAt: s.startedAt || null,
          lastActivity: isImport ? ('📋 已离线 · ' + fmtShort(s.startedAt)) : '已离线',
          lastActivityTs: Date.now(),
          taskNote: s.taskNote || '', contextWindow: s.contextWindow || null, maxOutputTokens: s.maxOutputTokens || null
        }
        this.sessions.push(row)
        this.activities[s.id] = []
        this.pendingApprovals[s.id] = []
      } else {
        row.status = s.status
        row.stats = s.stats
        if (s.cliSessionId) row.cliSessionId = s.cliSessionId
        if (s.lastActivity) row.lastActivity = s.lastActivity
        if (s.taskNote != null) row.taskNote = s.taskNote
        if (s.createdAt) row.createdAt = s.createdAt
      }
    },

    _onEvent(evt) {
      const row = this.sessions.find((s) => s.id === evt.sessionId)
      if (row) {
        if (evt.status) row.status = evt.status
        if (evt.type === 'ready') {
          row.lastActivity = '已就绪'
        } else if (evt.type === 'init') {
          if (evt.cliSessionId && !row.cliSessionId) row.cliSessionId = evt.cliSessionId
        } else if (evt.type === 'exit') {
          row.lastActivity = `进程退出 (${evt.code})`
        } else if (evt.type === 'error') {
          row.lastActivity = `错误: ${evt.message}`
        } else if (evt.type === 'stats_update') {
          // Live stats from transcript extraction
          row.stats.tokens = { input: evt.usage.inputTokens, output: evt.usage.outputTokens }
          if (evt.costUsd != null) row.stats.costUsd = evt.costUsd
          if (evt.turns != null) row.stats.turns = evt.turns
          if (evt.model) row.model = evt.model
          if (evt.contextWindow) row.contextWindow = evt.contextWindow
          row.lastActivity = `↑${evt.usage.inputTokens.toLocaleString()} ↓${evt.usage.outputTokens.toLocaleString()}`
        }
        row.lastActivityTs = evt.ts || Date.now()
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
      if (!this.pendingApprovals[req.sessionId]) this.pendingApprovals[req.sessionId] = []
      this.pendingApprovals[req.sessionId].push(req)
      const row = this.sessions.find((s) => s.id === req.sessionId)
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
