import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

function requireAccepted(result, fallbackMessage) {
  if (result?.accepted !== false) return result
  const messages = {
    binding_candidate_not_found: '该绑定请求已失效，请从飞书重新发起。',
    configuration_operation_in_progress: '另一项 Gateway 配置操作正在进行，请稍后重试。'
  }
  throw Object.assign(
    new Error(messages[result.reason] || fallbackMessage),
    { code: result.reason || 'GATEWAY_OPERATION_REJECTED' }
  )
}

function requireApplied(result) {
  if (result?.applied !== false) return result
  const messages = {
    test_expired: '连接测试已失效，请重新测试后再应用。',
    configuration_operation_in_progress: '另一项 Gateway 配置操作正在进行，请稍后重试。'
  }
  throw Object.assign(
    new Error(messages[result.reason] || 'Gateway 配置应用失败'),
    { code: result.reason || 'GATEWAY_APPLY_REJECTED' }
  )
}

let unsubscribe = null

const EMPTY_STATE = {
  desiredEnabled: false,
  phase: 'off',
  channelType: null,
  targetLabel: '',
  botIdentity: null,
  errorCode: null,
  errorMessage: '',
  selectedSessionCount: 0,
  readySessionCount: 0,
  pendingDecisionCount: 0,
  queuedTaskCount: 0,
  bindingCandidate: null,
  lastConnectedAt: null
}

export const useGatewayStore = defineStore('gateway', {
  state: () => ({
    runtime: { ...EMPTY_STATE },
    configuration: null,
    sessions: [],
    testedDraft: null,
    initialized: false,
    loading: false
  }),
  actions: {
    async init() {
      if (!unsubscribe) {
        unsubscribe = ipc.onGatewayState((state) => {
          this.runtime = { ...EMPTY_STATE, ...state }
        })
      }
      if (this.initialized) return
      this.loading = true
      try {
        const [runtime, configuration, sessions] = await Promise.all([
          ipc.getGatewayState(),
          ipc.getGatewayConfiguration(),
          ipc.listGatewaySessions()
        ])
        this.runtime = { ...EMPTY_STATE, ...runtime }
        this.configuration = configuration
        this.sessions = sessions
        this.initialized = true
      } finally {
        this.loading = false
      }
    },
    async setDesiredEnabled(enabled) {
      this.runtime = {
        ...this.runtime,
        desiredEnabled: Boolean(enabled)
      }
      try {
        this.runtime = await ipc.setGatewayDesiredEnabled(Boolean(enabled))
      } catch (error) {
        this.runtime = await ipc.getGatewayState()
        throw error
      }
    },
    async refreshConfiguration() {
      this.configuration = await ipc.getGatewayConfiguration()
      return this.configuration
    },
    async refreshSessions() {
      this.sessions = await ipc.listGatewaySessions()
      return this.sessions
    },
    async testDraft(payload) {
      this.testedDraft = null
      const result = await ipc.testGatewayDraft(payload)
      this.testedDraft = result
      return result
    },
    async applyDraft(testId) {
      const applied = await ipc.applyGatewayDraft(testId)
      if (
        applied?.applied === false &&
        applied.reason !== 'configuration_operation_in_progress'
      ) {
        this.testedDraft = null
      }
      requireApplied(applied)
      this.testedDraft = null
      this.configuration = applied
      this.runtime = await ipc.getGatewayState()
      await this.refreshSessions()
      return applied
    },
    async confirmBinding(bindingId) {
      const result = await ipc.confirmGatewayBinding(bindingId)
      requireAccepted(result, '确认绑定失败')
      await Promise.all([
        this.refreshConfiguration(),
        this.refreshSessions()
      ])
      this.runtime = await ipc.getGatewayState()
      return result
    },
    async dismissBinding(bindingId) {
      const result = await ipc.dismissGatewayBinding(bindingId)
      requireAccepted(result, '忽略绑定请求失败')
      this.runtime = await ipc.getGatewayState()
      return result
    },
    async clearBinding() {
      const result = await ipc.clearGatewayBinding()
      requireAccepted(result, '解除绑定失败')
      await Promise.all([
        this.refreshConfiguration(),
        this.refreshSessions()
      ])
      this.runtime = await ipc.getGatewayState()
      return result
    },
    invalidateTest() {
      this.testedDraft = null
    },
    async setSessionRelayEnabled(sessionId, enabled) {
      const result = await ipc.setSessionRelayEnabled(sessionId, enabled)
      await this.refreshSessions()
      this.runtime = await ipc.getGatewayState()
      return result
    },
    async resyncSession(sessionId) {
      const result = await ipc.resyncGatewaySession(sessionId)
      await this.refreshSessions()
      this.runtime = await ipc.getGatewayState()
      return result
    }
  }
})
