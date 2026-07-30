import { randomUUID } from 'node:crypto'

const MAX_WAITING = 5

function emptyState() {
  return {
    running: null,
    waiting: [],
    paused: false
  }
}

function cloneTask(task) {
  return task ? { ...task } : null
}

export class GatewayTaskQueue {
  constructor() {
    this._sessions = new Map()
  }

  _state(sessionId) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, emptyState())
    }
    return this._sessions.get(sessionId)
  }

  enqueue(sessionId, sourceMessageId, text) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof sourceMessageId !== 'string' ||
      !sourceMessageId ||
      typeof text !== 'string' ||
      !text.trim()
    ) {
      return { accepted: false, reason: 'invalid_task' }
    }
    const state = this._state(sessionId)
    if (state.running && state.waiting.length >= MAX_WAITING) {
      return { accepted: false, reason: 'queue_full' }
    }
    if (state.paused && state.waiting.length >= MAX_WAITING) {
      return { accepted: false, reason: 'queue_full' }
    }
    const task = {
      relayTaskId: randomUUID(),
      sessionId,
      sourceMessageId,
      text: text.trim(),
      enqueuedAt: Date.now()
    }
    if (!state.running && !state.paused) {
      state.running = task
      return { accepted: true, task: cloneTask(task), position: 0 }
    }
    state.waiting.push(task)
    return {
      accepted: true,
      task: cloneTask(task),
      position: state.running ? state.waiting.length : state.waiting.length
    }
  }

  completeCurrent(sessionId, relayTaskId) {
    const state = this._sessions.get(sessionId)
    if (!state?.running) return null
    if (relayTaskId && state.running.relayTaskId !== relayTaskId) return null
    state.running = null
    if (!state.paused) state.running = state.waiting.shift() || null
    this._deleteIfEmpty(sessionId, state)
    return cloneTask(state.running)
  }

  interrupt(sessionId) {
    const state = this._state(sessionId)
    const interrupted = state.running
    state.running = null
    state.paused = true
    return cloneTask(interrupted)
  }

  continue(sessionId) {
    const state = this._sessions.get(sessionId)
    if (!state) return null
    state.paused = false
    if (!state.running) state.running = state.waiting.shift() || null
    this._deleteIfEmpty(sessionId, state)
    return cloneTask(state.running)
  }

  clear(sessionId) {
    const state = this._sessions.get(sessionId)
    if (!state) return 0
    const count = (state.running ? 1 : 0) + state.waiting.length
    this._sessions.delete(sessionId)
    return count
  }

  onSessionStopped(sessionId) {
    return this.clear(sessionId)
  }

  onRelayDisabled(sessionId) {
    return this.clear(sessionId)
  }

  getState(sessionId) {
    const state = this._sessions.get(sessionId) || emptyState()
    return {
      running: cloneTask(state.running),
      waiting: state.waiting.map(cloneTask),
      paused: state.paused
    }
  }

  listSessionIds() {
    return [...this._sessions.keys()]
  }

  _deleteIfEmpty(sessionId, state) {
    if (!state.running && !state.waiting.length && !state.paused) {
      this._sessions.delete(sessionId)
    }
  }
}
