import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

export const useStatsStore = defineStore('stats', {
  state: () => ({
    total: { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } },
    perSession: {},
    modelStats: [],
    loaded: false
  }),
  actions: {
    async refresh() {
      try {
        const s = await ipc.getStats()
        this.total = s.total || { input: 0, output: 0, costUsd: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
        this.perSession = s.perSession || {}
        this.modelStats = s.modelStats || []
        this.loaded = true
      } catch (e) {
        console.error('stats refresh failed:', e)
      }
    }
  }
})
