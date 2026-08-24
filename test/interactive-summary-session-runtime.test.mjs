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

function harness({ adapter = new FakeAdapter(), startResult = true } = {}) {
  const entries = new Map([['session-1', { adapter }]])
  const stopped = []
  const runtime = createInteractiveSummarySessionRuntime({
    createSession(config) {
      const sessionId = config.sessionId || 'session-created'
      entries.set(sessionId, { adapter: new FakeAdapter(sessionId), config })
      return { sessionId }
    },
    startAdapter: async () => startResult,
    stopSession: async (sessionId) => {
      stopped.push(sessionId)
      const entry = entries.get(sessionId)
      if (entry) entry.stopped = true
      return true
    },
    getEntry: sessionId => entries.get(sessionId)
  })
  return { adapter, entries, runtime, stopped }
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

test('waitReady rejects when the process fails before becoming ready', async () => {
  const { adapter, runtime } = harness()
  const pending = runtime.waitReady('session-1', { timeoutMs: 100 })

  adapter.emitEvent('error', { message: 'provider secret must not escape' })

  await assert.rejects(pending, { code: 'SUMMARY_RUN_FAILED' })
  assert.equal(adapter.listenerCount('event'), 0)
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
