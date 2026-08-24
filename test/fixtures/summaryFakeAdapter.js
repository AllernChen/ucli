import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'

import { createInteractiveSummarySessionRuntime } from '../../electron/summaries/interactiveSummarySessionRuntime.js'

export class SummaryFakeAdapter extends EventEmitter {
  constructor(sessionId) {
    super()
    this.session = { id: sessionId }
    this.accepted = true
    this.turns = []
    this._sendWaiters = []
  }

  async sendTurn(text) {
    this.turns.push(text)
    for (const resolve of this._sendWaiters.splice(0)) resolve(text)
    return this.accepted
  }

  waitForSend() {
    if (this.turns.length > 0) return Promise.resolve(this.turns.at(-1))
    return new Promise(resolve => this._sendWaiters.push(resolve))
  }

  emitEvent(type, patch = {}) {
    this.emit('event', { type, sessionId: this.session.id, ts: Date.now(), ...patch })
  }

  emitGateway(type, patch = {}) {
    this.emit('gateway-event', {
      type,
      sessionId: this.session.id,
      occurredAt: Date.now(),
      ...patch
    })
  }
}

export function createSummaryFakeAdapterHarness({ workspaceService } = {}) {
  const entries = new Map()
  const configs = new Map()
  const stopped = []
  let nextSession = 0

  const runtime = createInteractiveSummarySessionRuntime({
    createSession(config) {
      const sessionId = `summary-session-${++nextSession}`
      entries.set(sessionId, { adapter: new SummaryFakeAdapter(sessionId) })
      configs.set(sessionId, structuredClone(config))
      return { sessionId }
    },
    async startAdapter(sessionId) {
      return entries.has(sessionId)
    },
    async stopSession(sessionId) {
      stopped.push(sessionId)
      return true
    },
    getEntry(sessionId) {
      return entries.get(sessionId)
    }
  })

  const adapter = sessionId => {
    const value = entries.get(sessionId)?.adapter
    if (!value) throw new Error(`Unknown fake summary session: ${sessionId}`)
    return value
  }

  return {
    runtime,
    stopped,
    config(sessionId) { return configs.get(sessionId) },
    adapter,
    emitReady(sessionId) { adapter(sessionId).emitEvent('ready') },
    emitTurnStarted(sessionId, turnId = 'turn-1') {
      adapter(sessionId).emitGateway('turn_started', { turnId })
    },
    emitTurnCompleted(sessionId, turnId = 'turn-1') {
      adapter(sessionId).emitGateway('turn_completed', { turnId })
    },
    emitTurnFailed(sessionId, turnId = 'turn-1') {
      adapter(sessionId).emitGateway('turn_failed', { turnId })
    },
    emitTurnInterrupted(sessionId, turnId = 'turn-1') {
      adapter(sessionId).emitGateway('turn_interrupted', { turnId })
    },
    emitSessionStopped(sessionId) { adapter(sessionId).emitGateway('session_stopped') },
    emitExit(sessionId) { adapter(sessionId).emitEvent('exit', { code: 1 }) },
    emitError(sessionId) { adapter(sessionId).emitEvent('error', { code: 'PRIVATE_ERROR' }) },
    setSendAccepted(sessionId, accepted) { adapter(sessionId).accepted = accepted },
    waitForSend(sessionId) { return adapter(sessionId).waitForSend() },
    async writeCanonicalMarkdown(reportId, markdown) {
      if (!workspaceService) throw new Error('workspaceService is required')
      return writeFile(workspaceService.resolveArtifact(reportId, 'output/report.md'), markdown, 'utf8')
    },
    listenerCount(sessionId) {
      const value = adapter(sessionId)
      return value.listenerCount('event') + value.listenerCount('gateway-event')
    }
  }
}
