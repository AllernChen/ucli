import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'
import { useAiCliProfilesStore } from './aiCliProfiles.js'

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  invalid_link: '连接链接无效，请获取新的链接',
  link_expired: '连接链接已过期，请获取新的链接',
  link_revoked: '连接链接已撤销，请获取新的链接',
  link_consumed: '连接链接已使用，请获取新的链接',
  invalid_grant: '服务端授权无效，请重新连接',
  invalid_device: '设备注册无效，请重新连接',
  grant_disabled: '服务端授权已停用',
  grant_expired: '服务端授权已到期',
  grant_deleted: '服务端授权已删除，请重新连接',
  account_inactive: '账号或成员关系不可用',
  organization_inactive: '组织不可用',
  PERSISTENCE_PENDING: '凭证尚未安全保存，请稍后重试',
  NETWORK_UNREACHABLE: '服务端连接暂时不可用，请稍后重试',
  REGISTRATION_NOT_CONFIRMABLE: '当前链接或授权不可确认'
})

function publicError(error, fallback = '服务端操作失败，请稍后重试') {
  const rawCode = typeof error?.code === 'string' ? error.code : ''
  const code = Object.hasOwn(PUBLIC_ERROR_MESSAGES, rawCode) ? rawCode : 'SERVER_CONNECTION_OPERATION_FAILED'
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code] || '服务端操作失败，请稍后重试',
    retryable: error?.retryable === true
  }
}

function isCurrentState(value, revision) {
  return value && Number.isSafeInteger(value.revision) && value.revision >= revision
}

function catalogIdentity(state) {
  if (!['connected', 'expiring'].includes(state?.status) || typeof state.serverOrigin !== 'string' ||
    typeof state.organization?.id !== 'string' || typeof state.connectionId !== 'string' ||
    !Number.isSafeInteger(state.connectionRevision)) return null
  return `${state.serverOrigin}\u0000${state.organization.id}\u0000${state.connectionId}\u0000${state.connectionRevision}`
}

function validateSkillTargets(value) {
  const targetAdapterIds = Array.isArray(value?.targetAdapterIds)
    ? [...new Set(value.targetAdapterIds.filter((id) => typeof id === 'string' && id))]
    : []
  const scopeType = value?.scopeType
  const projectPath = typeof value?.projectPath === 'string' ? value.projectPath.trim() : ''
  if (!targetAdapterIds.length || !['user', 'project'].includes(scopeType) || (scopeType === 'project' && !projectPath)) {
    throw Object.assign(new Error('Invalid Skill targets'), { code: 'INVALID_SKILL_TARGETS', retryable: false })
  }
  return { targetAdapterIds, scopeType, projectPath: scopeType === 'project' ? projectPath : '' }
}

export const useServerConnectionStore = defineStore('server-connection', {
  state: () => ({
    revision: -1,
    status: 'disconnected',
    reason: null,
    serverOrigin: null,
    account: null,
    organization: null,
    authorizationExpiresAt: null,
    serverTime: null,
    lastSyncedAt: null,
    connectionId: null,
    connectionRevision: null,
    attempt: null,
    pendingAttemptId: null,
    models: [],
    skills: [],
    connectionError: null,
    modelCatalogError: null,
    skillsCatalogError: null,
    busy: false,
    initialized: false,
    _initializePromise: null,
    _confirmPromise: null,
    _redeemPromise: null,
    _unsubscribeState: null,
    _unsubscribeRegistration: null,
    _lifecycle: 0,
    _attemptRequest: 0,
    _registrationGeneration: 0,
    _catalogRequest: 0,
    _connectionIdentity: null
  }),
  getters: {
    canConfirm: (state) => state.attempt?.preview?.link?.status === 'AVAILABLE' &&
      state.attempt?.preview?.authorization?.status === 'AVAILABLE'
  },
  actions: {
    applyState(value) {
      if (!isCurrentState(value, this.revision)) return false
      this.revision = value.revision
      this.status = value.status || 'disconnected'
      this.reason = value.reason || null
      this.serverOrigin = value.serverOrigin || null
      this.account = value.account || null
      this.organization = value.organization || null
      this.authorizationExpiresAt = value.authorizationExpiresAt || value.connection?.authorizationExpiresAt || null
      this.serverTime = value.serverTime || value.connection?.serverTime || null
      this.lastSyncedAt = value.lastSyncedAt || value.connection?.lastSyncedAt || null
      this.connectionId = typeof value.connection?.id === 'string' ? value.connection.id : null
      this.connectionRevision = Number.isSafeInteger(value.connection?.connectionRevision)
        ? value.connection.connectionRevision
        : null
      const nextIdentity = catalogIdentity(this)
      if (nextIdentity !== this._connectionIdentity) {
        this._catalogRequest += 1
        this.skills = []
        this._connectionIdentity = nextIdentity
      }
      return true
    },
    handleState(value, lifecycle = this._lifecycle) {
      const previousIdentity = this._connectionIdentity
      const applied = this.applyState(value)
      if (applied && this._lifecycle === lifecycle && this._connectionIdentity && this._connectionIdentity !== previousIdentity) {
        void this.loadCachedSkills(lifecycle, this._connectionIdentity).catch(() => {})
      }
      return applied
    },
    async initialize() {
      if (this.initialized) return this
      if (this._initializePromise) return this._initializePromise
      const lifecycle = this._lifecycle
      this._initializePromise = (async () => {
        const api = ipc.serverConnection
        try {
          this._unsubscribeState = api.onStateChanged((state) => {
            if (this._lifecycle === lifecycle) this.handleState(state, lifecycle)
          })
          this._unsubscribeRegistration = api.onRegistrationRequested(({ attemptId }) => {
            if (this._lifecycle === lifecycle && typeof attemptId === 'string') {
              this._registrationGeneration += 1
              void this.loadAttempt(attemptId, lifecycle).catch(() => {})
            }
          })
          const pendingBaseline = this._registrationGeneration
          const [state, pendingAttempt] = await Promise.all([api.getState(), api.getPendingAttempt()])
          if (this._lifecycle !== lifecycle) return this
          this.applyState(state)
          this.initialized = true
          if (typeof pendingAttempt?.attemptId === 'string' && this._registrationGeneration === pendingBaseline) {
            await this.loadAttempt(pendingAttempt.attemptId, lifecycle)
          }
          if (this._connectionIdentity) {
            try { await this.loadCachedSkills(lifecycle, this._connectionIdentity) } catch { /* catalog availability does not end core subscriptions */ }
          }
          return this
        } catch (error) {
          if (this._lifecycle === lifecycle) {
            this.connectionError = publicError(error)
            this.unsubscribe()
          }
          throw error
        } finally {
          if (this._lifecycle === lifecycle) this._initializePromise = null
        }
      })()
      return this._initializePromise
    },
    dispose() {
      this._lifecycle += 1
      this._attemptRequest += 1
      this.unsubscribe()
      this.initialized = false
      this._initializePromise = null
    },
    unsubscribe() {
      this._unsubscribeState?.()
      this._unsubscribeRegistration?.()
      this._unsubscribeState = null
      this._unsubscribeRegistration = null
    },
    async loadAttempt(attemptId, expectedLifecycle = this._lifecycle) {
      const request = ++this._attemptRequest
      this.pendingAttemptId = attemptId
      try {
        const attempt = await ipc.serverConnection.getAttempt(attemptId)
        if (this._lifecycle !== expectedLifecycle || request !== this._attemptRequest || attempt?.attemptId !== attemptId) return null
        this.attempt = attempt || null
        this.pendingAttemptId = null
        return this.attempt
      } catch (error) {
        if (this._lifecycle === expectedLifecycle && request === this._attemptRequest) {
          this.pendingAttemptId = null
          this.connectionError = publicError(error)
        }
        throw error
      }
    },
    async submitLink(input) {
      const lifecycle = this._lifecycle
      this.connectionError = null
      try {
        const result = await ipc.serverConnection.submitLink(input)
        if (this._lifecycle !== lifecycle || typeof result?.attemptId !== 'string') return null
        return await this.loadAttempt(result.attemptId, lifecycle)
      } catch (error) {
        this.connectionError = publicError(error)
        throw error
      }
    },
    async confirmAttempt() {
      if (!this.canConfirm) {
        const error = Object.assign(new Error('Registration is not confirmable'), { code: 'REGISTRATION_NOT_CONFIRMABLE', retryable: false })
        this.connectionError = publicError(error)
        throw error
      }
      if (this._confirmPromise) return this._confirmPromise
      const attemptId = this.attempt.attemptId
      this._confirmPromise = (async () => {
        this.busy = true
        this.connectionError = null
        try {
          const state = await ipc.serverConnection.confirm(attemptId)
          this.applyState(state)
          this.attempt = null
          await Promise.allSettled([this.syncModels(), this.syncSkills()])
          return state
        } catch (error) {
          this.connectionError = publicError(error)
          throw error
        } finally {
          this.busy = false
          this._confirmPromise = null
        }
      })()
      return this._confirmPromise
    },
    async retryRedeem() {
      if (!this.attempt?.attemptId) return null
      if (this._redeemPromise) return this._redeemPromise
      const attemptId = this.attempt.attemptId
      this._redeemPromise = (async () => {
        this.busy = true
        this.connectionError = null
        try {
          const state = await ipc.serverConnection.retryRedeem(attemptId)
          this.applyState(state)
          this.attempt = null
          await Promise.allSettled([this.syncModels(), this.syncSkills()])
          return state
        } catch (error) {
          this.connectionError = publicError(error)
          throw error
        } finally {
          this.busy = false
          this._redeemPromise = null
        }
      })()
      return this._redeemPromise
    },
    async cancelAttempt() {
      const attemptId = this.attempt?.attemptId || this.pendingAttemptId
      this._attemptRequest += 1
      this.attempt = null
      this.pendingAttemptId = null
      if (attemptId) await ipc.serverConnection.cancel(attemptId)
    },
    async runConnectionAction(operation, fallback) {
      this.busy = true
      this.connectionError = null
      try {
        const state = await operation()
        this.applyState(state)
        return state
      } catch (error) {
        this.connectionError = publicError(error, fallback)
        throw error
      } finally { this.busy = false }
    },
    retryConnection() { return this.runConnectionAction(() => ipc.serverConnection.retry(), '无法重试服务端连接') },
    syncConnection() { return this.runConnectionAction(() => ipc.serverConnection.sync(), '无法同步服务端连接') },
    disconnect() { return this.runConnectionAction(() => ipc.serverConnection.disconnect(), '无法断开服务端连接') },
    async syncModels() {
      this.modelCatalogError = null
      try {
        this.models = await ipc.serverConnection.listModels()
        await useAiCliProfilesStore().load()
        return this.models
      } catch (error) {
        this.modelCatalogError = publicError(error)
        throw error
      }
    },
    async syncSkills() {
      const lifecycle = this._lifecycle
      const identity = this._connectionIdentity
      const request = ++this._catalogRequest
      this.skillsCatalogError = null
      try {
        const skills = await ipc.serverConnection.syncSkills()
        if (this._lifecycle === lifecycle && identity && identity === this._connectionIdentity && request === this._catalogRequest) {
          this.skills = Array.isArray(skills) ? skills : []
        }
        return this.skills
      } catch (error) {
        if (this._lifecycle === lifecycle && identity === this._connectionIdentity && request === this._catalogRequest) {
          this.skillsCatalogError = publicError(error)
        }
        throw error
      }
    },
    async loadCachedSkills(expectedLifecycle = this._lifecycle, expectedIdentity = this._connectionIdentity) {
      if (!expectedIdentity) return []
      const request = ++this._catalogRequest
      this.skillsCatalogError = null
      try {
        const skills = await ipc.serverConnection.listSkills()
        if (this._lifecycle === expectedLifecycle && expectedIdentity === this._connectionIdentity && request === this._catalogRequest) {
          this.skills = Array.isArray(skills) ? skills : []
        }
        return this.skills
      } catch (error) {
        if (this._lifecycle === expectedLifecycle && expectedIdentity === this._connectionIdentity && request === this._catalogRequest) {
          this.skillsCatalogError = publicError(error)
        }
        throw error
      }
    },
    async installSkill(versionId, targets) {
      const target = validateSkillTargets(targets)
      this.skillsCatalogError = null
      try {
        const result = await ipc.serverConnection.installSkill(versionId, target)
        await this.syncSkills()
        return result
      } catch (error) {
        this.skillsCatalogError = publicError(error)
        throw error
      }
    },
    async updateSkill(versionId, targets) {
      const target = validateSkillTargets(targets)
      this.skillsCatalogError = null
      try {
        const result = await ipc.serverConnection.updateSkill(versionId, target)
        await this.syncSkills()
        return result
      } catch (error) {
        this.skillsCatalogError = publicError(error)
        throw error
      }
    }
  }
})
