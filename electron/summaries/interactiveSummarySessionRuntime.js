const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 12_000
const DELIVERY_TERMINALS = new Set([
  'turn_failed',
  'turn_interrupted',
  'session_stopped'
])
const PROCESS_TERMINALS = new Set(['error', 'exit'])

function typed(code) {
  return Object.assign(new Error(code), { code })
}

function requireTimeout(value) {
  if (!Number.isFinite(value) || value < 1) {
    throw typed('SUMMARY_RUNTIME_TIMEOUT_INVALID')
  }
  return value
}

export function createInteractiveSummarySessionRuntime({
  createSession,
  startAdapter,
  stopSession,
  getEntry
} = {}) {
  if (typeof createSession !== 'function' || typeof startAdapter !== 'function' ||
    typeof stopSession !== 'function' || typeof getEntry !== 'function') {
    throw new TypeError('Interactive summary session runtime dependencies are required')
  }

  const states = new Map()
  const stoppedIds = new Set()

  function makeState(sessionId, adapter = getEntry(sessionId)?.adapter || null) {
    const state = {
      sessionId,
      adapter,
      startPromise: null,
      stopPromise: null,
      stopped: false,
      retired: false,
      readyOutcome: null,
      readyCleanup: null,
      readyWaiters: new Set(),
      deliveries: new Set(),
      subscriptions: new Set()
    }
    states.set(sessionId, state)
    return state
  }

  function rejectReadyWaiters(state, error) {
    for (const waiter of [...state.readyWaiters]) {
      clearTimeout(waiter.timer)
      state.readyWaiters.delete(waiter)
      waiter.reject(error)
    }
  }

  function retireState(state, {
    readyError = typed('SUMMARY_SESSION_UNAVAILABLE'),
    deliveryError = typed('SUMMARY_TURN_NOT_CONFIRMED')
  } = {}) {
    if (state.retired) return
    state.retired = true
    state.readyCleanup?.()
    rejectReadyWaiters(state, readyError)
    for (const cancel of [...state.deliveries]) cancel(deliveryError)
    for (const unsubscribe of [...state.subscriptions]) unsubscribe()
    state.adapter = null
    if (states.get(state.sessionId) === state) states.delete(state.sessionId)
  }

  function stateFor(sessionId) {
    if (stoppedIds.has(sessionId)) throw typed('SUMMARY_SESSION_STOPPED')
    let state = states.get(sessionId)
    const adapter = getEntry(sessionId)?.adapter || null
    if (state?.stopped) throw typed('SUMMARY_SESSION_STOPPED')
    if (state && state.adapter !== adapter) {
      retireState(state)
      state = null
    }
    if (!adapter || typeof adapter.on !== 'function') {
      throw typed('SUMMARY_SESSION_UNAVAILABLE')
    }
    if (!state) state = makeState(sessionId, adapter)
    return state
  }

  function settleReady(state, outcome) {
    if (state.readyOutcome || state.retired) return
    state.readyOutcome = outcome
    state.readyCleanup?.()
    for (const waiter of [...state.readyWaiters]) {
      clearTimeout(waiter.timer)
      state.readyWaiters.delete(waiter)
      if (outcome.error) waiter.reject(outcome.error)
      else waiter.resolve(outcome.value)
    }
  }

  function armReady(state) {
    if (state.readyOutcome || state.readyCleanup) return
    const onEvent = event => {
      if (event?.sessionId !== state.sessionId) return
      if (event.type === 'ready') {
        settleReady(state, { value: { ready: true } })
      } else if (PROCESS_TERMINALS.has(event.type)) {
        settleReady(state, { error: typed('SUMMARY_RUN_FAILED') })
      }
    }
    state.adapter.on('event', onEvent)
    state.readyCleanup = () => {
      state.adapter.removeListener('event', onEvent)
      state.readyCleanup = null
    }
  }

  async function create(config) {
    return createSession(config)
  }

  async function start(sessionId) {
    const state = stateFor(sessionId)
    if (state.startPromise) return state.startPromise
    armReady(state)
    state.startPromise = (async () => {
      try {
        const accepted = await startAdapter(sessionId)
        if (state.stopped) throw typed('SUMMARY_SESSION_STOPPED')
        if (state.retired) throw typed('SUMMARY_SESSION_UNAVAILABLE')
        if (accepted !== true) settleReady(state, { error: typed('SUMMARY_RUN_FAILED') })
        return accepted === true
      } catch (error) {
        if (error?.code === 'SUMMARY_SESSION_STOPPED' ||
          error?.code === 'SUMMARY_SESSION_UNAVAILABLE') throw error
        settleReady(state, { error: typed('SUMMARY_RUN_FAILED') })
        throw typed('SUMMARY_RUN_FAILED')
      }
    })()
    return state.startPromise
  }

  async function waitReady(sessionId, { timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    const delayMs = requireTimeout(timeoutMs)
    const state = stateFor(sessionId)
    if (state.readyOutcome?.error) throw state.readyOutcome.error
    if (state.readyOutcome) return state.readyOutcome.value
    armReady(state)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      state.readyWaiters.add(waiter)
      waiter.timer = setTimeout(() => {
        if (!state.readyWaiters.delete(waiter)) return
        reject(typed('SUMMARY_READY_TIMEOUT'))
        if (state.readyWaiters.size === 0 && !state.startPromise) {
          state.readyCleanup?.()
        }
      }, delayMs)
    })
  }

  async function deliver(sessionId, text, { timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS } = {}) {
    const delayMs = requireTimeout(timeoutMs)
    const state = stateFor(sessionId)
    const { adapter } = state
    let confirmationSettled = false
    let resolveConfirmation
    let rejectConfirmation
    let rejectCancellation
    let timer = null

    const confirmation = new Promise((resolve, reject) => {
      resolveConfirmation = resolve
      rejectConfirmation = reject
    })
    const settleConfirmation = (error, event) => {
      if (confirmationSettled) return
      confirmationSettled = true
      if (error) rejectConfirmation(error)
      else resolveConfirmation(event)
    }
    const onGateway = event => {
      if (event?.sessionId !== sessionId) return
      if (event.type === 'turn_started') settleConfirmation(null, event)
      else if (DELIVERY_TERMINALS.has(event.type)) {
        settleConfirmation(typed('SUMMARY_TURN_NOT_CONFIRMED'))
      }
    }
    const onEvent = event => {
      if (event?.sessionId === sessionId && PROCESS_TERMINALS.has(event.type)) {
        settleConfirmation(typed('SUMMARY_TURN_NOT_CONFIRMED'))
      }
    }
    adapter.on('gateway-event', onGateway)
    adapter.on('event', onEvent)

    const send = Promise.resolve().then(() => adapter.sendTurn(text)).then(
      accepted => {
        if (accepted !== true) throw typed('SUMMARY_TURN_NOT_ACCEPTED')
        return true
      },
      () => { throw typed('SUMMARY_TURN_NOT_ACCEPTED') }
    )
    const operation = Promise.all([send, confirmation]).then(([, event]) => ({
      accepted: true,
      confirmed: true,
      turnId: event.turnId
    }))
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(typed('SUMMARY_TURN_NOT_CONFIRMED')), delayMs)
    })
    const cancellation = new Promise((_resolve, reject) => {
      rejectCancellation = reject
    })
    const cancel = (error = typed('SUMMARY_TURN_NOT_CONFIRMED')) => rejectCancellation(error)
    state.deliveries.add(cancel)

    try {
      return await Promise.race([operation, deadline, cancellation])
    } finally {
      state.deliveries.delete(cancel)
      adapter.removeListener('gateway-event', onGateway)
      adapter.removeListener('event', onEvent)
      if (timer) clearTimeout(timer)
      settleConfirmation(typed('SUMMARY_TURN_NOT_CONFIRMED'))
    }
  }

  function subscribe(sessionId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required')
    const state = stateFor(sessionId)
    const { adapter } = state
    const publish = event => {
      if (event?.sessionId === sessionId) listener(event)
    }
    adapter.on('gateway-event', publish)
    adapter.on('event', publish)
    let active = true
    const cleanup = () => {
      if (!active) return
      active = false
      adapter.removeListener('gateway-event', publish)
      adapter.removeListener('event', publish)
      state.subscriptions.delete(cleanup)
    }
    state.subscriptions.add(cleanup)
    return cleanup
  }

  async function stop(sessionId) {
    if (stoppedIds.has(sessionId)) return true
    let state = states.get(sessionId)
    if (!state) state = makeState(sessionId)
    if (state.stopPromise) return state.stopPromise
    state.stopped = true
    state.readyCleanup?.()
    rejectReadyWaiters(state, typed('SUMMARY_SESSION_STOPPED'))
    for (const cancel of [...state.deliveries]) {
      cancel(typed('SUMMARY_TURN_NOT_CONFIRMED'))
    }
    for (const unsubscribe of [...state.subscriptions]) unsubscribe()
    const activeStart = state.startPromise
    state.stopPromise = (async () => {
      if (activeStart) {
        try { await activeStart } catch {}
      }
      try {
        const stopped = await stopSession(sessionId)
        if (stopped !== true) throw typed('SUMMARY_RUN_FAILED')
        stoppedIds.add(sessionId)
        retireState(state, { readyError: typed('SUMMARY_SESSION_STOPPED') })
        return true
      } catch {
        state.stopPromise = null
        throw typed('SUMMARY_RUN_FAILED')
      }
    })()
    return state.stopPromise
  }

  return Object.freeze({ create, start, waitReady, deliver, subscribe, stop })
}
