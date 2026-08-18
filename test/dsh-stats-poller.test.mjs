import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshStatsPoller } from '../electron/adapters/dshStatsPoller.js'

test('poller aggregates tokens for active DSH web sessions and skips inactive ones', async () => {
  const aggregated = []
  const called = []
  const poller = createDshStatsPoller({
    entries: () => new Map([
      ['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }],
      ['s2', { session: { adapterId: 'deepseek-harness' }, surfaceState: null }],
      ['s3', { session: { adapterId: 'claude' }, surfaceState: { url: 'http://127.0.0.1:43128' } }]
    ]),
    dshClient: { aggregateTokenUsage: async (url) => { aggregated.push(url); return { input: 10, output: 4 } } },
    onStats: async (sessionId, tokens) => { called.push([sessionId, tokens]) }
  })
  await poller.tick()
  assert.deepEqual(aggregated, ['http://127.0.0.1:43127'])
  assert.deepEqual(called, [['s1', { input: 10, output: 4 }]])
})

test('poller swallows client failures and keeps the session untouched', async () => {
  let called = 0
  const poller = createDshStatsPoller({
    entries: () => new Map([['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }]]),
    dshClient: { aggregateTokenUsage: async () => { throw new Error('boom') } },
    onStats: async () => { called += 1 }
  })
  await poller.tick() // must not throw
  assert.equal(called, 0)
})

test('poller skips sessions whose client returns null', async () => {
  let called = 0
  const poller = createDshStatsPoller({
    entries: () => new Map([['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }]]),
    dshClient: { aggregateTokenUsage: async () => null },
    onStats: async () => { called += 1 }
  })
  await poller.tick()
  assert.equal(called, 0)
})

function fakeTimers() {
  const scheduled = []
  const cleared = []
  const setTimer = (fn) => { scheduled.push(fn); return fn }
  const clearTimer = (handle) => { cleared.push(handle) }
  return { scheduled, cleared, setTimer, clearTimer }
}

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

test('poller start is idempotent and stop clears the timer once', () => {
  const { scheduled, cleared, setTimer, clearTimer } = fakeTimers()
  const poller = createDshStatsPoller({
    entries: () => new Map(),
    dshClient: { aggregateTokenUsage: async () => null },
    onStats: async () => {},
    setTimer,
    clearTimer
  })
  poller.start()
  assert.equal(scheduled.length, 1)
  poller.start()
  assert.equal(scheduled.length, 1)
  poller.stop()
  assert.equal(cleared.length, 1)
  poller.stop()
  assert.equal(cleared.length, 1)
})

test('poller does not reschedule when stopped mid-tick', async () => {
  const { scheduled, cleared, setTimer, clearTimer } = fakeTimers()
  const gate = deferred()
  let called = 0
  const poller = createDshStatsPoller({
    entries: () => new Map([['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }]]),
    dshClient: { aggregateTokenUsage: async () => { await gate.promise; return { input: 1, output: 2 } } },
    onStats: async () => { called += 1 },
    setTimer,
    clearTimer
  })
  poller.start()
  assert.equal(scheduled.length, 1)
  // Drive the loop synchronously until it suspends inside aggregateTokenUsage.
  const loopPromise = scheduled[0]()
  poller.stop()
  gate.resolve()
  await loopPromise
  assert.equal(called, 1)
  assert.equal(scheduled.length, 1)
  assert.equal(cleared.length, 1)
})
