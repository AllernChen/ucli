import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

export const useAiCliProfilesStore = defineStore('ai-cli-profiles', {
  state: () => ({
    profiles: [],
    cliInventory: [],
    cliConfiguration: [],
    codexRuntime: null,
    revisionsByProfileId: {},
    cwd: '',
    loading: false,
    saving: false,
    error: null
  }),
  getters: {
    profileById: (state) => (profileId) =>
      state.profiles.find((profile) => profile.id === profileId) || null,
    cliById: (state) => (adapterId) => {
      const inventory = state.cliInventory.find((item) => item.id === adapterId) || {}
      const configuration = state.cliConfiguration.find((item) => item.adapterId === adapterId) || {}
      return { ...inventory, ...configuration, id: adapterId }
    }
  },
  actions: {
    async load(cwd = this.cwd) {
      this.cwd = cwd || ''
      this.loading = true
      this.error = null
      try {
        const state = await ipc.getAiCliProfileState({ cwd: this.cwd || undefined })
        this.profiles = state.profiles || []
        this.cliInventory = state.cliInventory || []
        this.cliConfiguration = state.cliConfiguration || []
        this.codexRuntime = state.codexRuntime || null
        return state
      } catch (error) {
        this.error = { code: error?.code || 'PROFILE_OPERATION_FAILED', message: error?.message || '加载配置档案失败' }
        throw error
      } finally {
        this.loading = false
      }
    },
    async runSaving(operation) {
      this.saving = true
      this.error = null
      try {
        return await operation()
      } catch (error) {
        this.error = { code: error?.code || 'PROFILE_OPERATION_FAILED', message: error?.message || '保存配置档案失败' }
        throw error
      } finally {
        this.saving = false
      }
    },
    async create(draft) {
      return this.runSaving(async () => {
        const profile = await ipc.createAiCliProfile(draft)
        await this.load()
        return profile
      })
    },
    async update(profileId, patch) {
      return this.runSaving(async () => {
        const profile = await ipc.updateAiCliProfile(profileId, patch)
        await this.load()
        return profile
      })
    },
    async setSecret(profileId, secret) {
      return this.runSaving(async () => {
        const profile = await ipc.setAiCliProfileSecret(profileId, secret)
        await this.load()
        return profile
      })
    },
    async deleteSecret(profileId) {
      return this.runSaving(async () => {
        const profile = await ipc.deleteAiCliProfileSecret(profileId)
        await this.load()
        return profile
      })
    },
    async remove(profileId) {
      return this.runSaving(async () => {
        const removed = await ipc.deleteAiCliProfile(profileId)
        await this.load()
        return removed
      })
    },
    async setBinding(binding) {
      return this.runSaving(async () => {
        const result = await ipc.setAiCliProfileBinding(binding)
        await this.load()
        return result
      })
    },
    async loadRevisions(profileId) {
      const revisions = await ipc.listAiCliProfileRevisions(profileId)
      this.revisionsByProfileId = { ...this.revisionsByProfileId, [profileId]: revisions }
      return revisions
    },
    async rollback(profileId, revisionId) {
      return this.runSaving(async () => {
        const profile = await ipc.rollbackAiCliProfile(profileId, revisionId)
        await Promise.all([this.load(), this.loadRevisions(profileId)])
        return profile
      })
    },
    async repair(profileId) {
      return this.runSaving(async () => {
        const profile = await ipc.repairAiCliProfile(profileId)
        await this.load()
        return profile
      })
    },
    async reconcile() {
      return this.runSaving(async () => {
        const result = await ipc.reconcileAiCliProfiles()
        await this.load()
        return result
      })
    }
  }
})
