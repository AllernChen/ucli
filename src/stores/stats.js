import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

let unsub = null
let refreshTimer = null

export const useStatsStore = defineStore('stats', {
  state: () => ({
    total: { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
    perSession: {},
    modelStats: [],
    loaded: false
  }),
  actions: {
    initLiveUpdates() {
      if (unsub) return
      unsub = ipc.on('session:event', (evt) => {
        if (evt.type !== 'stats_update') return
        const existing = this.perSession[evt.sessionId] || {
          adapterId: null,
          model: null,
          cwd: '',
          status: evt.status,
          tokens: { input: 0, output: 0 },
          costUsd: 0,
          turns: 0,
          approvals: { autoAllowed: 0, confirmed: 0, denied: 0 }
        }
        const next = {
          ...existing,
          status: evt.status || existing.status,
          model: evt.model || existing.model,
          tokens: {
            input: evt.usage?.inputTokens || 0,
            output: evt.usage?.outputTokens || 0
          },
          costUsd: evt.costUsd ?? existing.costUsd,
          turns: evt.turns ?? existing.turns
        }
        this.perSession = { ...this.perSession, [evt.sessionId]: next }
        this._updateLiveModelStats(evt, next)
        this._recomputeTotal()
        this._scheduleRefresh()
      })
    },

    async refresh() {
      try {
        const s = await ipc.getStats()
        this.total = s.total || { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
        this.perSession = s.perSession || {}
        this.modelStats = s.modelStats || []
        this.loaded = true
        this.initLiveUpdates()
      } catch (e) {
        console.error('stats refresh failed:', e)
      }
    },

    _recomputeTotal() {
      const total = { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
      for (const s of Object.values(this.perSession)) {
        total.input += s.tokens?.input || 0
        total.output += s.tokens?.output || 0
        total.costUsd += s.costUsd || 0
        total.turns += s.turns || 0
        for (const k of Object.keys(total.approvals)) {
          total.approvals[k] += s.approvals?.[k] || 0
        }
      }
      this.total = total
    },

    _updateLiveModelStats(evt, sessionStats) {
      const rows = [...(this.modelStats || [])]
      const updates = evt.modelBreakdown?.length
        ? evt.modelBreakdown
        : evt.model
          ? [{
              model: evt.model,
              inputTokens: sessionStats.tokens?.input || 0,
              outputTokens: sessionStats.tokens?.output || 0,
              costUsd: sessionStats.costUsd || 0
            }]
          : []

      for (const update of updates) {
        const idx = rows.findIndex((row) => row.model === update.model)
        const next = {
          model: update.model,
          input_tokens: update.inputTokens || 0,
          output_tokens: update.outputTokens || 0,
          cost_usd: update.costUsd || 0,
          session_count: idx >= 0 ? rows[idx].session_count : 1
        }
        if (idx >= 0) rows[idx] = { ...rows[idx], ...next }
        else rows.push(next)
      }
      if (updates.length) this.modelStats = rows
    },

    _scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        this.refresh()
      }, 1000)
    }
  }
})
