import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

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
      this.testedDraft = null
      this.configuration = applied
      this.runtime = await ipc.getGatewayState()
      await this.refreshSessions()
      return applied
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
