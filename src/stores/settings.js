import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    defaultTier: 'safety-rules',
    defaultAdapter: 'claude',
    defaultCwd: '',
    language: 'zh-CN',
    theme: 'light',
    workbench: { splitCount: 1, activePane: 0, paneSessionIds: [] },
    loaded: false
  }),
  actions: {
    async load() {
      const s = await ipc.getSettings()
      Object.assign(this, s)
      this.loaded = true
    },
    async save(patch) {
      Object.assign(this, patch)
      await ipc.updateSettings(this.$state)
    }
  }
})
