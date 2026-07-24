import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeStatsScheduler } from '../electron/openCodeStats.js'

function createFakeTimers() {
  const timers = []
  return {
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn(timer) {
      timer.cleared = true
    },
    fire(delay) {
      const timer = timers.find((candidate) => candidate.delay === delay && !candidate.cleared)
      if (!timer) throw new Error(`no active ${delay}ms timer`)
      timer.callback()
    },
    active(delay) {
      return timers.filter((timer) => timer.delay === delay && !timer.cleared).length
    }
  }
}

test('coalesces terminal output into one idle statistics scan', () => {
  const timers = createFakeTimers()
  let calls = 0
  const scheduler = new OpenCodeStatsScheduler({
    onRun: () => { calls += 1 },
    idleDelayMs: 20,
    maxWaitMs: 100,
    ...timers
  })

  scheduler.schedule()
  scheduler.schedule()
  assert.equal(timers.active(20), 1)
  assert.equal(timers.active(100), 1)

  timers.fire(20)
  assert.equal(calls, 1)
  assert.equal(timers.active(100), 0)
})

test('runs a statistics scan at max wait during continuous output', () => {
  const timers = createFakeTimers()
  let calls = 0
  const scheduler = new OpenCodeStatsScheduler({
    onRun: () => { calls += 1 },
    idleDelayMs: 20,
    maxWaitMs: 100,
    ...timers
  })

  scheduler.schedule()
  scheduler.schedule()
  timers.fire(100)

  assert.equal(calls, 1)
  assert.equal(timers.active(20), 0)
})

test('dispose clears outstanding OpenCode statistics timers', () => {
  const timers = createFakeTimers()
  const scheduler = new OpenCodeStatsScheduler({
    onRun: () => {},
    idleDelayMs: 20,
    maxWaitMs: 100,
    ...timers
  })

  scheduler.schedule()
  scheduler.dispose()

  assert.equal(timers.active(20), 0)
  assert.equal(timers.active(100), 0)
})
