import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { runPrimaryInstanceGate } from '../electron/primaryInstanceGate.js'

test('a secondary instance quits without running shared startup side effects', () => {
  const calls = []
  assert.equal(runPrimaryInstanceGate({
    acquireLock: () => false,
    quit: () => calls.push('quit'),
    onSecondInstance: () => calls.push('second-instance'),
    bootstrap: () => calls.push('cleanup-session-startup')
  }), false)
  assert.deepEqual(calls, ['quit'])
})

test('main gates cleanup, session setup, and application startup behind the primary lock', () => {
  const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  const lock = source.indexOf('runPrimaryInstanceGate({')
  const acquire = source.indexOf('acquireLock: () => app.requestSingleInstanceLock()', lock)
  const quit = source.indexOf('quit: () => app.quit()', acquire)
  const bootstrap = source.indexOf('bootstrap: bootstrapPrimaryInstance', quit)
  const cleanup = source.indexOf('runScheduledStorageCleanupSync({')
  const sessionMkdir = source.indexOf('mkdirSync(sessionDataPath', cleanup)
  const ready = source.indexOf('app.whenReady()', sessionMkdir)

  assert.ok(lock >= 0 && acquire > lock && quit > acquire && bootstrap > quit)
  assert.ok(cleanup > bootstrap && sessionMkdir > cleanup && ready > sessionMkdir)
  assert.equal(source.match(/requestSingleInstanceLock\(\)/g)?.length, 1)
})
