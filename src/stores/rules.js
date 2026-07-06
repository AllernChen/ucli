import { defineStore } from 'pinia'
import { ipc } from '../ipc.js'

export const useRulesStore = defineStore('rules', {
  state: () => ({
    rulesets: {}, // { default: {id,name,deny[],highRisk[],allow[]} }
    blacklist: { commands: [], paths: [] },
    loaded: false
  }),
  actions: {
    async load() {
      this.rulesets = await ipc.getRules()
      this.blacklist = await ipc.getBlacklist()
      this.loaded = true
    },
    async save(rulesets) {
      this.rulesets = rulesets || this.rulesets
      await ipc.updateRules(this.rulesets)
    },
    async testPattern(pattern, command, path) {
      return ipc.testPattern({ pattern, command, path })
    }
  }
})
