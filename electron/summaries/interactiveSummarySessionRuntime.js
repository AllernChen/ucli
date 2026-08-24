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

function requireAdapter(getEntry, sessionId) {
  const entry = getEntry(sessionId)
  if (!entry?.adapter || typeof entry.adapter.on !== 'function') {
    throw typed('SUMMARY_SESSION_UNAVAILABLE')
  }
  return entry.adapter
}

function createWaiter({
  adapter,
  sessionId,
  timeoutMs,
  timeoutCode,
  onGateway,
  onEvent
}) {
  const delayMs = requireTimeout(timeoutMs)
  let settled = false
  let resolvePromise
  let rejectPromise
  let timer = null

  const cleanup = () => {
    adapter.removeListener('gateway-event', handleGateway)
    adapter.removeListener('event', handleEvent)
    if (timer) clearTimeout(timer)
  }
  const resolve = value => {
    if (settled) return
    settled = true
    cleanup()
    resolvePromise(value)
  }
  const reject = error => {
    if (settled) return
    settled = true
    cleanup()
    rejectPromise(error)
  }
  const handleGateway = event => {
    if (event?.sessionId !== sessionId) return
    onGateway?.(event, resolve, reject)
  }
  const handleEvent = event => {
    if (event?.sessionId !== sessionId) return
    onEvent?.(event, resolve, reject)
  }
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  adapter.on('gateway-event', handleGateway)
  adapter.on('event', handleEvent)
  timer = setTimeout(() => reject(typed(timeoutCode)), delayMs)

  return {
    promise,
    cancel() {
      reject(typed('SUMMARY_RUNTIME_WAIT_CANCELLED'))
    }
  }
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

  async function create(config) {
    return createSession(config)
  }

  async function start(sessionId) {
    return startAdapter(sessionId)
  }

  async function waitReady(sessionId, { timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    const adapter = requireAdapter(getEntry, sessionId)
    const waiter = createWaiter({
      adapter,
      sessionId,
      timeoutMs,
      timeoutCode: 'SUMMARY_READY_TIMEOUT',
      onEvent(event, resolve, reject) {
        if (event.type === 'ready') resolve({ ready: true })
        if (PROCESS_TERMINALS.has(event.type)) reject(typed('SUMMARY_RUN_FAILED'))
      }
    })
    return waiter.promise
  }

  async function deliver(sessionId, text, { timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS } = {}) {
    const adapter = requireAdapter(getEntry, sessionId)
    const waiter = createWaiter({
      adapter,
      sessionId,
      timeoutMs,
      timeoutCode: 'SUMMARY_TURN_NOT_CONFIRMED',
      onGateway(event, resolve, reject) {
        if (event.type === 'turn_started') resolve(event)
        if (DELIVERY_TERMINALS.has(event.type)) reject(typed('SUMMARY_TURN_NOT_CONFIRMED'))
      },
      onEvent(event, _resolve, reject) {
        if (PROCESS_TERMINALS.has(event.type)) reject(typed('SUMMARY_TURN_NOT_CONFIRMED'))
      }
    })
    const confirmation = waiter.promise.then(
      event => ({ event }),
      error => ({ error })
    )

    let accepted
    try {
      accepted = await adapter.sendTurn(text)
    } catch {
      waiter.cancel()
      await confirmation
      throw typed('SUMMARY_TURN_NOT_ACCEPTED')
    }
    if (accepted !== true) {
      waiter.cancel()
      await confirmation
      throw typed('SUMMARY_TURN_NOT_ACCEPTED')
    }
    const outcome = await confirmation
    if (outcome.error) throw outcome.error
    return {
      accepted: true,
      confirmed: true,
      turnId: outcome.event.turnId
    }
  }

  function subscribe(sessionId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required')
    const adapter = requireAdapter(getEntry, sessionId)
    const publish = event => {
      if (event?.sessionId === sessionId) listener(event)
    }
    adapter.on('gateway-event', publish)
    adapter.on('event', publish)
    let active = true
    return () => {
      if (!active) return
      active = false
      adapter.removeListener('gateway-event', publish)
      adapter.removeListener('event', publish)
    }
  }

  async function stop(sessionId) {
    return stopSession(sessionId)
  }

  return Object.freeze({ create, start, waitReady, deliver, subscribe, stop })
}
