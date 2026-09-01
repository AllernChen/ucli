import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

function sameStatePreviewIdentity(left, right) {
  return left?.packageId === right?.packageId &&
    left?.scopeType === right?.scopeType &&
    left?.scopeKey === right?.scopeKey
}

function statePreviewIdentity(request) {
  return {
    packageId: request?.packageId ?? null,
    scopeType: request?.scopeType ?? null,
    scopeKey: request?.scopeKey ?? null
  }
}

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
    stateSaving: false,
    statePreview: null,
    statePreviewIdentity: null,
    statePreviewToken: 0,
    checking: false,
    batchProgress: null,
    error: null
  }),
  actions: {
    clearStatePreview() {
      this.statePreviewToken += 1
      this.statePreview = null
      this.statePreviewIdentity = null
    },
    safeError(error, fallbackMessage) {
      const safe = {
        code: error?.code || 'SKILL_OPERATION_FAILED',
        message: error?.message || fallbackMessage
      }
      if (error?.recoveryAction === 'retry_apply_codex') safe.recoveryAction = 'retry_apply_codex'
      return safe
    },
    async load(projectPath = this.projectPath) {
      const nextProjectPath = projectPath || ''
      if (nextProjectPath !== this.projectPath) this.clearStatePreview()
      this.projectPath = nextProjectPath
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
        this.error = this.safeError(error, '加载 Skills 失败')
        throw error
      } finally {
        this.loading = false
      }
    },
    async runSaving(work) {
      this.saving = true
      this.error = null
      try { return await work() } catch (error) {
        this.error = this.safeError(error, 'Skill 操作失败')
        throw error
      } finally {
        this.saving = false
      }
    },
    inspectSource(source, context) { return ipc.inspectSkillSource(source, context) },
    async previewCliStateChange(request) {
      this.error = null
      const identity = statePreviewIdentity(request)
      const token = this.statePreviewToken + 1
      this.statePreviewToken = token
      if (!sameStatePreviewIdentity(this.statePreviewIdentity, identity)) this.statePreview = null
      this.statePreviewIdentity = identity
      try {
        const preview = await ipc.previewCliStateChange(request)
        if (this.statePreviewToken !== token || !sameStatePreviewIdentity(this.statePreviewIdentity, identity)) return preview
        this.statePreview = preview
        return preview
      } catch (error) {
        if (this.statePreviewToken === token && sameStatePreviewIdentity(this.statePreviewIdentity, identity)) {
          this.statePreview = null
          this.statePreviewIdentity = null
        }
        this.error = this.safeError(error, 'Skill 状态预览失败')
        throw error
      }
    },
    async applyCliStateChange(request) {
      this.stateSaving = true
      this.error = null
      try {
        const result = await ipc.applyCliStateChange(request)
        await this.load()
        this.clearStatePreview()
        return result
      } catch (error) {
        this.error = this.safeError(error, 'Skill 状态保存失败')
        throw error
      } finally {
        this.stateSaving = false
      }
    },
    install(request) {
      return this.runSaving(async () => {
        const result = await ipc.installSkill(request)
        await this.load()
        return result
      })
    },
    installMany(requests = []) {
      return this.runSaving(async () => {
        this.batchProgress = { total: requests.length }
        try {
          const result = await ipc.installSkills(requests)
          try {
            await this.load()
            return result
          } catch (error) {
            return {
              ...result,
              refreshError: {
                code: error?.code || 'SKILL_REFRESH_FAILED',
                message: error?.message || 'Skills 状态刷新失败'
              }
            }
          }
        } finally {
          this.batchProgress = null
        }
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
    removePackage(packageId) {
      return this.runSaving(async () => {
        const result = await ipc.removePackage(packageId)
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
