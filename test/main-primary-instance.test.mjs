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

test('second-instance registration can reference a module-scoped window focus function', () => {
  const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  const gate = source.indexOf('runPrimaryInstanceGate({')
  const secondInstance = source.indexOf("onSecondInstance: (handler) => app.on('second-instance'", gate)
  const forwarding = source.indexOf('handler({ argv, workingDirectory })', secondInstance)
  const deepLink = source.indexOf('handleSecondInstance: ({ argv }) => deepLinks.acceptArgv(argv)', forwarding)
  const showMainWindow = source.indexOf('function showMainWindow()')

  assert.ok(secondInstance > gate)
  assert.ok(forwarding > secondInstance && deepLink > forwarding)
  assert.ok(showMainWindow >= 0 && showMainWindow < gate,
    'showMainWindow must be declared before the second-instance gate')
  assert.equal(braceDepthAt(source, showMainWindow), 0,
    'showMainWindow must be declared at module scope')
})

test('primary-instance forwarding preserves argv and workingDirectory for validated deep-link handling', () => {
  let handler = null
  const received = []
  runPrimaryInstanceGate({
    acquireLock: () => true,
    quit: () => assert.fail('primary instance must not quit'),
    bootstrap: () => {},
    onSecondInstance: (next) => { handler = next },
    handleSecondInstance: (payload) => received.push(payload)
  })

  const argv = ['ucli.exe', 'ucli://connect?server=https%3A%2F%2Fserver.example.test#link=opaque']
  handler({ argv, workingDirectory: 'C:\\untrusted' })
  assert.deepEqual(received, [{ argv, workingDirectory: 'C:\\untrusted' }])
})

function braceDepthAt(source, end) {
  let depth = 0
  for (let index = 0; index < end; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
  }
  return depth
}
