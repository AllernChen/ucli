import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    defaultTier: 'safety-rules',
    defaultAdapter: 'claude',
    defaultCwd: '',
    codexConfigDir: '',
    language: 'zh-CN',
    theme: 'light',
    keybindings: {},
    workbench: { splitCount: 1, activePane: 0, paneSessionIds: [] },
    autoEnabled: false,
    autoPeriods: { day: true, week: true, month: false, quarter: false, year: false },
    defaultExecutorId: null,
    defaultProfileId: null,
    defaultModel: null,
    firstEnableDisclosureAcceptedAt: null,
    automaticCallLimit: 20,
    cacheEnabled: true,
    cacheMaxBytes: 1073741824,
    failedWorkspaceRetentionDays: 7,
    mapConcurrency: 2,
    loaded: false
  }),
  actions: {
    async load() {
      const s = await ipc.getSettings()
      Object.assign(this, s)
      this.loaded = true
    },
    async save(patch) {
      const next = { ...this.$state, ...patch }
      await ipc.updateSettings(next)
      Object.assign(this, patch)
    }
  }
})
