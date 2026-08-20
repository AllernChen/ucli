import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'
import { deriveSessionCapabilityState } from '../sessionMaintenancePresentation.js'
import { useSessionsStore } from './sessions.js'

let unsub = null
let refreshTimer = null

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export const useStatsStore = defineStore('stats', {
  state: () => ({
    total: { input: 0, output: 0, costUsd: 0, costUnavailableCount: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
    perSession: {},
    modelStats: [],
    loaded: false,
    granularity: 'day',
    range: null,
    filters: { projectPaths: [], adapterIds: [], models: [] },
    trend: null,
    trendLoading: false,
    trendError: null,
    _trendRequestSequence: 0
  }),
  actions: {
    _invalidateTrendQuery() {
      this._trendRequestSequence += 1
      this.trendLoading = false
      this.trendError = null
      this.trend = null
    },

    setGranularity(granularity) {
      if (granularity === this.granularity) return
      this.granularity = granularity
      this.range = null
      this._invalidateTrendQuery()
    },

    setFilters(filters = {}) {
      const next = {
        projectPaths: Array.isArray(filters.projectPaths) ? [...filters.projectPaths] : [],
        adapterIds: Array.isArray(filters.adapterIds) ? [...filters.adapterIds] : [],
        models: Array.isArray(filters.models) ? [...filters.models] : []
      }
      const changed = !sameArray(next.projectPaths, this.filters.projectPaths) ||
        !sameArray(next.adapterIds, this.filters.adapterIds) ||
        !sameArray(next.models, this.filters.models)
      if (!changed) return
      this.filters = next
      this._invalidateTrendQuery()
    },

    async loadTrend() {
      const sequence = ++this._trendRequestSequence
      this.trendLoading = true
      this.trendError = null
      const range = this.range && typeof this.range === 'object'
        ? {
            start: this.range.start,
            endExclusive: this.range.endExclusive,
            ...(this.range.timeZone ? { timeZone: this.range.timeZone } : {})
          }
        : {}
      const query = {
        granularity: this.granularity,
        ...range,
        projectPaths: [...this.filters.projectPaths],
        adapterIds: [...this.filters.adapterIds],
        models: [...this.filters.models]
      }
      try {
        const trend = await ipc.queryStats(query)
        if (sequence !== this._trendRequestSequence) return null
        this.trend = trend
        return trend
      } catch (error) {
        if (sequence !== this._trendRequestSequence) return null
        this.trendError = {
          code: typeof error?.code === 'string' ? error.code : 'USAGE_QUERY_FAILED',
          message: typeof error?.message === 'string' && error.message
            ? error.message
            : 'Unable to query usage',
          ...(typeof error?.suggestedGranularity === 'string'
            ? { suggestedGranularity: error.suggestedGranularity }
            : {})
        }
        return null
      } finally {
        if (sequence === this._trendRequestSequence) this.trendLoading = false
      }
    },

    initLiveUpdates() {
      if (unsub) return
      unsub = ipc.on('session:event', (evt) => {
        if (evt.type !== 'stats_update') return
        const session = useSessionsStore().byId(evt.sessionId)
        if (!deriveSessionCapabilityState(session || {}).ucliStats) return
        const existing = this.perSession[evt.sessionId] || {
          adapterId: null,
          model: null,
          cwd: '',
          status: evt.status,
          tokens: { input: 0, output: 0 },
          costUsd: null,
          costAvailable: false,
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
          costAvailable: evt.costAvailable ?? (evt.costUsd != null ? true : existing.costAvailable),
          costUsd: evt.costAvailable === false ? null : (evt.costUsd ?? existing.costUsd),
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
        this.total = s.total || { input: 0, output: 0, costUsd: 0, costUnavailableCount: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
        this.perSession = s.perSession || {}
        this.modelStats = s.modelStats || []
        this.loaded = true
        this.initLiveUpdates()
      } catch (e) {
        console.error('stats refresh failed:', e)
      }
    },

    _recomputeTotal() {
      const total = { input: 0, output: 0, costUsd: 0, costUnavailableCount: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
      for (const s of Object.values(this.perSession)) {
        total.input += s.tokens?.input || 0
        total.output += s.tokens?.output || 0
        if (s.costAvailable === false) total.costUnavailableCount += 1
        else total.costUsd += s.costUsd || 0
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
              costUsd: sessionStats.costUsd,
              costAvailable: sessionStats.costAvailable
            }]
          : []

      for (const update of updates) {
        const idx = rows.findIndex((row) => row.model === update.model)
        const next = {
          model: update.model,
          input_tokens: update.inputTokens || 0,
          output_tokens: update.outputTokens || 0,
          cost_usd: update.costUsd ?? 0,
          cost_unavailable_count: update.costAvailable === false ? 1 : 0,
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
