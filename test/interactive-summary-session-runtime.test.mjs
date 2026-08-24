import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createInteractiveSummarySessionRuntime } from '../electron/summaries/interactiveSummarySessionRuntime.js'

class FakeAdapter extends EventEmitter {
  constructor(sessionId = 'session-1') {
    super()
    this.session = { id: sessionId }
    this.accepted = true
    this.onSend = null
  }

  async sendTurn(text) {
    this.lastTurn = text
    this.onSend?.()
    return this.accepted
  }

  emitEvent(type, patch = {}) {
    this.emit('event', {
      type,
      sessionId: this.session.id,
      ts: Date.now(),
      ...patch
    })
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

function harness({
  adapter = new FakeAdapter(),
  startResult = true,
  onStart,
  startGate,
  stopError
} = {}) {
  const entries = new Map([['session-1', { adapter }]])
  const stopped = []
  let startCalls = 0
  const runtime = createInteractiveSummarySessionRuntime({
    createSession(config) {
      const sessionId = config.sessionId || 'session-created'
      entries.set(sessionId, { adapter: new FakeAdapter(sessionId), config })
      return { sessionId }
    },
    startAdapter: async sessionId => {
      startCalls += 1
      await startGate?.promise
      onStart?.(entries.get(sessionId)?.adapter)
      return startResult
    },
    stopSession: async (sessionId) => {
      if (stopError) throw stopError
      stopped.push(sessionId)
      const entry = entries.get(sessionId)
      if (entry) entry.stopped = true
      return true
    },
    getEntry: sessionId => entries.get(sessionId)
  })
  return { adapter, entries, runtime, stopped, get startCalls() { return startCalls } }
}

test('create, start and stop delegate without deleting the persisted session entry', async () => {
  const { entries, runtime, stopped } = harness()

  const created = await runtime.create({ sessionId: 'summary-session', cwd: 'F:\\summary-work' })
  assert.deepEqual(created, { sessionId: 'summary-session' })
  assert.equal(await runtime.start('summary-session'), true)
  assert.equal(await runtime.stop('summary-session'), true)
  assert.deepEqual(stopped, ['summary-session'])
  assert.equal(entries.has('summary-session'), true)
  assert.equal(entries.get('summary-session').stopped, true)
})

test('waitReady resolves only from the requested session and removes listeners', async () => {
  const { adapter, runtime } = harness()
  const pending = runtime.waitReady('session-1', { timeoutMs: 100 })

  adapter.emit('event', {
    type: 'ready', sessionId: 'session-other', ts: Date.now()
  })
  adapter.emitEvent('ready')

  assert.deepEqual(await pending, { ready: true })
  assert.equal(adapter.listenerCount('event'), 0)
})

test('start pre-arms ready so a synchronous ready event is cached for later waitReady', async () => {
  const state = harness({ onStart: adapter => adapter.emitEvent('ready') })

  assert.equal(await state.runtime.start('session-1'), true)
  assert.deepEqual(await state.runtime.waitReady('session-1', { timeoutMs: 5 }), {
    ready: true
  })
  assert.equal(state.startCalls, 1)
  assert.equal(state.adapter.listenerCount('event'), 0)
})

test('start and stop are idempotent and a stopped session cannot restart', async () => {
  const state = harness({ onStart: adapter => adapter.emitEvent('ready') })

  assert.equal(await state.runtime.start('session-1'), true)
  assert.equal(await state.runtime.start('session-1'), true)
  assert.equal(state.startCalls, 1)
  assert.equal(await state.runtime.stop('session-1'), true)
  assert.equal(await state.runtime.stop('session-1'), true)
  assert.deepEqual(state.stopped, ['session-1'])
  await assert.rejects(state.runtime.start('session-1'), {
    code: 'SUMMARY_SESSION_STOPPED'
  })
})

test('stop waits for an in-flight start then stops exactly once', async () => {
  let releaseStart
  const startGate = {
    promise: new Promise(resolve => { releaseStart = resolve })
  }
  const state = harness({
    startGate,
    onStart: adapter => adapter.emitEvent('ready')
  })
  const starting = state.runtime.start('session-1')
  const stopping = state.runtime.stop('session-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.stopped, [])

  releaseStart()
  await assert.rejects(starting, { code: 'SUMMARY_SESSION_STOPPED' })
  assert.equal(await stopping, true)
  assert.equal(await state.runtime.stop('session-1'), true)
  assert.deepEqual(state.stopped, ['session-1'])
  assert.equal(state.adapter.listenerCount('event'), 0)
})

test('stop maps dependency failure to a stable typed error', async () => {
  const { runtime } = harness({ stopError: new Error('private stop detail') })

  await assert.rejects(runtime.stop('session-1'), { code: 'SUMMARY_RUN_FAILED' })
})

test('invalid wait timeout fails without installing listeners', async () => {
  const { adapter, runtime } = harness()

  await assert.rejects(runtime.waitReady('session-1', { timeoutMs: 0 }), {
    code: 'SUMMARY_RUNTIME_TIMEOUT_INVALID'
  })
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('waitReady rejects with a typed timeout and removes listeners', async () => {
  const { adapter, runtime } = harness()

  await assert.rejects(runtime.waitReady('session-1', { timeoutMs: 5 }), {
    code: 'SUMMARY_READY_TIMEOUT'
  })
  assert.equal(adapter.listenerCount('event'), 0)
})

test('one ready timeout does not poison a longer waiter for the same session', async () => {
  const { adapter, runtime } = harness()
  const short = runtime.waitReady('session-1', { timeoutMs: 5 })
  const long = runtime.waitReady('session-1', { timeoutMs: 100 })

  setTimeout(() => adapter.emitEvent('ready'), 20)

  await assert.rejects(short, { code: 'SUMMARY_READY_TIMEOUT' })
  assert.deepEqual(await long, { ready: true })
  assert.equal(adapter.listenerCount('event'), 0)
})

test('last ready timeout keeps the monitor while session start is still in flight', async () => {
  let releaseStart
  const startGate = {
    promise: new Promise(resolve => { releaseStart = resolve })
  }
  const state = harness({
    startGate,
    onStart: adapter => adapter.emitEvent('ready')
  })
  const starting = state.runtime.start('session-1')

  await assert.rejects(
    state.runtime.waitReady('session-1', { timeoutMs: 5 }),
    { code: 'SUMMARY_READY_TIMEOUT' }
  )
  releaseStart()
  assert.equal(await starting, true)
  assert.deepEqual(
    await state.runtime.waitReady('session-1', { timeoutMs: 10 }),
    { ready: true }
  )
  assert.equal(state.adapter.listenerCount('event'), 0)
})

test('waitReady caches error and exit terminals and removes its monitor', async t => {
  for (const terminal of ['error', 'exit']) {
    await t.test(terminal, async () => {
      const { adapter, runtime } = harness()
      const pending = runtime.waitReady('session-1', { timeoutMs: 100 })

      adapter.emitEvent(terminal, { message: 'provider secret must not escape' })

      await assert.rejects(pending, { code: 'SUMMARY_RUN_FAILED' })
      await assert.rejects(runtime.waitReady('session-1', { timeoutMs: 100 }), {
        code: 'SUMMARY_RUN_FAILED'
      })
      assert.equal(adapter.listenerCount('event'), 0)
    })
  }
})

test('delivery installs confirmation listener before send and confirms same-session turn_started', async () => {
  const { adapter, runtime } = harness()
  adapter.onSend = () => adapter.emitGateway('turn_started', { turnId: 'turn-1' })

  assert.deepEqual(
    await runtime.deliver('session-1', 'prompt', { timeoutMs: 100 }),
    { accepted: true, confirmed: true, turnId: 'turn-1' }
  )
  assert.equal(adapter.lastTurn, 'prompt')
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('delivery ignores another session turn_started until the requested session confirms', async () => {
  const { adapter, runtime } = harness()
  const pending = runtime.deliver('session-1', 'prompt', { timeoutMs: 100 })

  adapter.emit('gateway-event', {
    type: 'turn_started',
    sessionId: 'session-other',
    turnId: 'wrong-turn',
    occurredAt: Date.now()
  })
  adapter.emitGateway('turn_started', { turnId: 'right-turn' })

  assert.deepEqual(await pending, {
    accepted: true,
    confirmed: true,
    turnId: 'right-turn'
  })
})

test('delivery rejects false send acceptance and cancels the confirmation waiter', async () => {
  const { adapter, runtime } = harness()
  adapter.accepted = false

  await assert.rejects(runtime.deliver('session-1', 'prompt', { timeoutMs: 100 }), {
    code: 'SUMMARY_TURN_NOT_ACCEPTED'
  })
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('delivery timeout is typed and removes every waiter resource', async () => {
  const { adapter, runtime } = harness()

  await assert.rejects(runtime.deliver('session-1', 'prompt', { timeoutMs: 5 }), {
    code: 'SUMMARY_TURN_NOT_CONFIRMED'
  })
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('delivery deadline includes a hung send after turn_started confirmation', async () => {
  const { adapter, runtime } = harness()
  adapter.sendTurn = () => {
    adapter.emitGateway('turn_started', { turnId: 'turn-1' })
    return new Promise(() => {})
  }

  await assert.rejects(runtime.deliver('session-1', 'prompt', { timeoutMs: 5 }), {
    code: 'SUMMARY_TURN_NOT_CONFIRMED'
  })
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('stop cancels pending waits and late send settlement stays inert', async t => {
  for (const outcome of ['false', 'throw']) {
    await t.test(outcome, async () => {
      const { adapter, runtime } = harness()
      let settleSend
      adapter.sendTurn = () => new Promise((resolve, reject) => {
        settleSend = outcome === 'false'
          ? () => resolve(false)
          : () => reject(new Error('late private rejection'))
      })
      const ready = runtime.waitReady('session-1', { timeoutMs: 100 })
      const delivery = runtime.deliver('session-1', 'prompt', { timeoutMs: 100 })

      await runtime.stop('session-1')
      await assert.rejects(ready, { code: 'SUMMARY_SESSION_STOPPED' })
      await assert.rejects(delivery, { code: 'SUMMARY_TURN_NOT_CONFIRMED' })
      settleSend()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(adapter.listenerCount('gateway-event'), 0)
      assert.equal(adapter.listenerCount('event'), 0)
    })
  }
})

test('delivery rejects if the requested turn fails or process exits before confirmation', async t => {
  for (const terminal of ['turn_failed', 'turn_interrupted', 'session_stopped', 'exit', 'error']) {
    await t.test(terminal, async () => {
      const { adapter, runtime } = harness()
      const pending = runtime.deliver('session-1', 'prompt', { timeoutMs: 100 })
      if (terminal === 'exit' || terminal === 'error') adapter.emitEvent(terminal)
      else adapter.emitGateway(terminal, { turnId: 'turn-1' })

      await assert.rejects(pending, { code: 'SUMMARY_TURN_NOT_CONFIRMED' })
      assert.equal(adapter.listenerCount('gateway-event'), 0)
      assert.equal(adapter.listenerCount('event'), 0)
    })
  }
})

test('duplicate turn_started settles once and leaves no listeners behind', async () => {
  const { adapter, runtime } = harness()
  adapter.onSend = () => {
    adapter.emitGateway('turn_started', { turnId: 'turn-first' })
    adapter.emitGateway('turn_started', { turnId: 'turn-duplicate' })
  }

  assert.equal((await runtime.deliver('session-1', 'prompt')).turnId, 'turn-first')
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('subscribe scopes lifecycle events to one session and unsubscribe removes listeners', () => {
  const { adapter, runtime } = harness()
  const observed = []
  const unsubscribe = runtime.subscribe('session-1', event => observed.push(event.type))

  adapter.emitGateway('turn_started', { turnId: 'turn-1' })
  adapter.emitGateway('turn_completed', { turnId: 'turn-1' })
  adapter.emit('gateway-event', {
    type: 'turn_failed', sessionId: 'session-other', turnId: 'other', occurredAt: Date.now()
  })
  adapter.emitEvent('exit', { code: 1 })
  unsubscribe()
  adapter.emitGateway('turn_interrupted', { turnId: 'turn-2' })

  assert.deepEqual(observed, ['turn_started', 'turn_completed', 'exit'])
  assert.equal(adapter.listenerCount('gateway-event'), 0)
  assert.equal(adapter.listenerCount('event'), 0)
})

test('adapter replacement tears down old pending work and allows the new adapter to start', async () => {
  const state = harness({ onStart: adapter => adapter.emitEvent('ready') })
  const oldAdapter = state.adapter
  const ready = state.runtime.waitReady('session-1', { timeoutMs: 100 })
  const delivery = state.runtime.deliver('session-1', 'prompt', { timeoutMs: 100 })
  const unsubscribe = state.runtime.subscribe('session-1', () => {})
  const readyRejected = assert.rejects(ready, { code: 'SUMMARY_SESSION_UNAVAILABLE' })
  const deliveryRejected = assert.rejects(delivery, { code: 'SUMMARY_TURN_NOT_CONFIRMED' })
  const newAdapter = new FakeAdapter('session-1')

  state.entries.set('session-1', { adapter: newAdapter })
  assert.equal(await state.runtime.start('session-1'), true)
  await Promise.all([readyRejected, deliveryRejected])
  assert.deepEqual(await state.runtime.waitReady('session-1'), { ready: true })
  assert.equal(oldAdapter.listenerCount('gateway-event'), 0)
  assert.equal(oldAdapter.listenerCount('event'), 0)
  unsubscribe()

  assert.equal(await state.runtime.stop('session-1'), true)
  assert.equal(newAdapter.listenerCount('gateway-event'), 0)
  assert.equal(newAdapter.listenerCount('event'), 0)
})

test('offline entry rejects cached adapter use and releases its listeners', async () => {
  const state = harness()
  const unsubscribe = state.runtime.subscribe('session-1', () => {})
  state.entries.set('session-1', { adapter: null })

  await assert.rejects(state.runtime.waitReady('session-1'), {
    code: 'SUMMARY_SESSION_UNAVAILABLE'
  })
  assert.equal(state.adapter.listenerCount('gateway-event'), 0)
  assert.equal(state.adapter.listenerCount('event'), 0)
  unsubscribe()
})
