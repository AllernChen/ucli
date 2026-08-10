import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

export const useSkillsStore = defineStore('skills', {
  state: () => ({
    adapters: [],
    projects: [],
    packages: [],
    discovered: [],
    summary: { managedPackages: 0, activeInstallations: 0, updates: 0, conflicts: 0 },
    lastCheckedAt: null,
    projectPath: '',
    loading: false,
    saving: false,
    checking: false,
    error: null
  }),
  actions: {
    async load(projectPath = this.projectPath) {
      this.projectPath = projectPath || ''
      this.loading = true
      this.error = null
      try {
        const state = await ipc.getSkillsState({ projectPath: this.projectPath || undefined })
        this.adapters = state.adapters || []
        this.projects = state.projects || []
        this.packages = state.packages || []
        this.discovered = state.discovered || []
        this.summary = state.summary || this.summary
        this.lastCheckedAt = state.lastCheckedAt || null
        return state
      } catch (error) {
        this.error = { code: error?.code || 'SKILL_OPERATION_FAILED', message: error?.message || '加载 Skills 失败' }
        throw error
      } finally {
        this.loading = false
      }
    },
    async runSaving(work) {
      this.saving = true
      this.error = null
      try { return await work() } catch (error) {
        this.error = { code: error?.code || 'SKILL_OPERATION_FAILED', message: error?.message || 'Skill 操作失败' }
        throw error
      } finally {
        this.saving = false
      }
    },
    inspectSource(source, context) { return ipc.inspectSkillSource(source, context) },
    install(request) {
      return this.runSaving(async () => {
        const result = await ipc.installSkill(request)
        await this.load()
        return result
      })
    },
    applyToAdapter(packageId, targetAdapterId) {
      return this.runSaving(async () => {
        const result = await ipc.applySkillToAdapter(packageId, targetAdapterId)
        await this.load()
        return result
      })
    },
    setEnabled(installationId, enabled) {
      return this.runSaving(async () => {
        const result = await ipc.setSkillEnabled(installationId, enabled)
        await this.load()
        return result
      })
    },
    removeInstallation(installationId) {
      return this.runSaving(async () => {
        const result = await ipc.removeSkillInstallation(installationId)
        await this.load()
        return result
      })
    },
    resolveDrift(installationId, resolution) {
      return this.runSaving(async () => {
        const result = await ipc.resolveSkillDrift(installationId, resolution)
        await this.load()
        return result
      })
    },
    adopt(request) {
      return this.runSaving(async () => {
        const result = await ipc.adoptSkill(request)
        await this.load()
        return result
      })
    },
    async checkUpdates(packageIds = null) {
      this.checking = true
      try {
        const result = await ipc.checkSkillUpdates(packageIds)
        await this.load()
        return result
      } finally {
        this.checking = false
      }
    },
    previewUpdate(packageId) { return ipc.previewSkillUpdate(packageId) },
    update(packageId, expectedRevision) {
      return this.runSaving(async () => {
        const result = await ipc.updateSkill(packageId, expectedRevision)
        await this.load()
        return result
      })
    },
    getAffectedSessions(installationIds) { return ipc.getSkillAffectedSessions(installationIds) },
    restartSessions(sessionIds) { return ipc.restartSkillSessions(sessionIds) }
  }
})
