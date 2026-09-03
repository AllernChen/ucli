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
  if (!['connected', 'expiring', 'unreachable'].includes(state?.status) || typeof state.serverOrigin !== 'string' ||
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
    skillsSyncState: { status: 'idle', lastSyncedAt: null, catalogRevision: 0, error: null },
    busy: false,
    initialized: false,
    _initializePromise: null,
    _confirmPromise: null,
    _redeemPromise: null,
    _unsubscribeState: null,
    _unsubscribeRegistration: null,
    _unsubscribeSkillsCatalog: null,
    _lifecycle: 0,
    _attemptRequest: 0,
    _registrationGeneration: 0,
    _catalogRequest: 0,
    _modelRequest: 0,
    _skillActionRequest: 0,
    _skillsSyncRequest: 0,
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
        this._modelRequest += 1
        this.models = []
        this.skills = []
        this.modelCatalogError = null
        this.skillsCatalogError = null
        this.skillsSyncState = { status: 'idle', lastSyncedAt: null, catalogRevision: 0, error: null }
        this._connectionIdentity = nextIdentity
      }
      return true
    },
    handleState(value, lifecycle = this._lifecycle) {
      const previousIdentity = this._connectionIdentity
      const applied = this.applyState(value)
      if (applied && this._lifecycle === lifecycle && this._connectionIdentity && this._connectionIdentity !== previousIdentity) {
        void Promise.allSettled([this.syncModels(), this.loadCachedSkills(lifecycle, this._connectionIdentity)])
        void this.ensureSkillsFresh().catch(() => {})
      }
      return applied
    },
    handleSkillsCatalogChanged(value, lifecycle = this._lifecycle) {
      if (this._lifecycle !== lifecycle || !this._connectionIdentity || value?.connectionId !== this.connectionId ||
        value?.connectionRevision !== this.connectionRevision || !Number.isSafeInteger(value?.catalogRevision) ||
        !Number.isSafeInteger(value?.lastSyncedAt) || value?.status !== 'ready') return false
      this.skillsSyncState = {
        status: 'ready', lastSyncedAt: value.lastSyncedAt, catalogRevision: value.catalogRevision, error: null
      }
      void this.loadCachedSkills(lifecycle, this._connectionIdentity).catch(() => {})
      return true
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
          this._unsubscribeSkillsCatalog = api.onSkillsCatalogChanged((value) => {
            this.handleSkillsCatalogChanged(value, lifecycle)
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
            void this.loadSkillsSyncState(lifecycle, this._connectionIdentity).catch(() => {})
            void this.ensureSkillsFresh().catch(() => {})
            await Promise.allSettled([this.syncModels(), this.loadCachedSkills(lifecycle, this._connectionIdentity)])
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
      this._skillsSyncRequest += 1
      this.unsubscribe()
      this.initialized = false
      this._initializePromise = null
    },
    unsubscribe() {
      this._unsubscribeState?.()
      this._unsubscribeRegistration?.()
      this._unsubscribeSkillsCatalog?.()
      this._unsubscribeState = null
      this._unsubscribeRegistration = null
      this._unsubscribeSkillsCatalog = null
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
    async syncServiceProfiles() {
      await this.syncConnection()
      return this.syncModels()
    },
    async syncModels() {
      const lifecycle = this._lifecycle
      const identity = this._connectionIdentity
      const request = ++this._modelRequest
      this.modelCatalogError = null
      try {
        const models = await ipc.serverConnection.listModels()
        await useAiCliProfilesStore().load()
        if (this._lifecycle === lifecycle && identity && identity === this._connectionIdentity && request === this._modelRequest) {
          this.models = Array.isArray(models) ? models : []
        }
        return this.models
      } catch (error) {
        if (this._lifecycle === lifecycle && identity && identity === this._connectionIdentity && request === this._modelRequest) {
          this.modelCatalogError = publicError(error)
        }
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
    async loadSkillsSyncState(expectedLifecycle = this._lifecycle, expectedIdentity = this._connectionIdentity) {
      if (!expectedIdentity) return this.skillsSyncState
      const request = ++this._skillsSyncRequest
      try {
        const syncState = await ipc.serverConnection.getSkillsSyncState()
        if (this._lifecycle === expectedLifecycle && expectedIdentity === this._connectionIdentity && request === this._skillsSyncRequest && syncState) {
          this.skillsSyncState = {
            status: typeof syncState.status === 'string' ? syncState.status : 'idle',
            lastSyncedAt: Number.isSafeInteger(syncState.lastSyncedAt) ? syncState.lastSyncedAt : null,
            catalogRevision: Number.isSafeInteger(syncState.catalogRevision) ? syncState.catalogRevision : 0,
            error: syncState.error ? publicError(syncState.error) : null
          }
        }
        return this.skillsSyncState
      } catch (error) {
        if (this._lifecycle === expectedLifecycle && expectedIdentity === this._connectionIdentity && request === this._skillsSyncRequest) {
          const safe = publicError(error)
          this.skillsSyncState = { ...this.skillsSyncState, status: 'error', error: safe }
          this.skillsCatalogError = safe
        }
        throw error
      }
    },
    async ensureSkillsFresh({ force = false } = {}) {
      const lifecycle = this._lifecycle
      const identity = this._connectionIdentity
      if (!identity || !['connected', 'expiring'].includes(this.status)) return this.skillsSyncState
      const request = ++this._skillsSyncRequest
      this.skillsSyncState = { ...this.skillsSyncState, status: 'syncing', error: null }
      try {
        const syncState = await ipc.serverConnection.ensureSkillsFresh({ force: force === true })
        if (this._lifecycle === lifecycle && identity === this._connectionIdentity && request === this._skillsSyncRequest && syncState) {
          this.skillsSyncState = {
            status: typeof syncState.status === 'string' ? syncState.status : 'ready',
            lastSyncedAt: Number.isSafeInteger(syncState.lastSyncedAt) ? syncState.lastSyncedAt : null,
            catalogRevision: Number.isSafeInteger(syncState.catalogRevision) ? syncState.catalogRevision : 0,
            error: syncState.error ? publicError(syncState.error) : null
          }
          if (this.skillsSyncState.error) this.skillsCatalogError = this.skillsSyncState.error
        }
        return this.skillsSyncState
      } catch (error) {
        if (this._lifecycle === lifecycle && identity === this._connectionIdentity && request === this._skillsSyncRequest) {
          const safe = publicError(error)
          this.skillsSyncState = { ...this.skillsSyncState, status: 'error', error: safe }
          this.skillsCatalogError = safe
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
      const lifecycle = this._lifecycle
      const identity = this._connectionIdentity
      const actionRequest = ++this._skillActionRequest
      const catalogRequest = this._catalogRequest
      if (identity && identity === this._connectionIdentity) this.skillsCatalogError = null
      try {
        const result = await ipc.serverConnection.installSkill(versionId, target)
        await this.syncSkills()
        return result
      } catch (error) {
        if (this._lifecycle === lifecycle && identity && identity === this._connectionIdentity &&
          actionRequest === this._skillActionRequest && catalogRequest === this._catalogRequest) {
          this.skillsCatalogError = publicError(error)
        }
        throw error
      }
    },
    async updateSkill(versionId, targets) {
      const target = validateSkillTargets(targets)
      const lifecycle = this._lifecycle
      const identity = this._connectionIdentity
      const actionRequest = ++this._skillActionRequest
      const catalogRequest = this._catalogRequest
      if (identity && identity === this._connectionIdentity) this.skillsCatalogError = null
      try {
        const result = await ipc.serverConnection.updateSkill(versionId, target)
        await this.syncSkills()
        return result
      } catch (error) {
        if (this._lifecycle === lifecycle && identity && identity === this._connectionIdentity &&
          actionRequest === this._skillActionRequest && catalogRequest === this._catalogRequest) {
          this.skillsCatalogError = publicError(error)
        }
        throw error
      }
    }
  }
})
