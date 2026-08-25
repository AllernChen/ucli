import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createGatewayPort,
  sendAdapterTurn
} from '../electron/gateway/orchestratorPort.js'

test('the Gateway port exposes only the approved UCLI operations', async () => {
  const calls = []
  const events = []
  const methods = {
    listSessions: () => [{ id: 'session-1' }],
    getSession: (id) => ({ id }),
    sendTurn: async (...args) => { calls.push(['turn', ...args]); return true },
    interrupt: async (...args) => { calls.push(['interrupt', ...args]); return true },
    respondDecision: async (...args) => { calls.push(['decision', ...args]); return { accepted: true } },
    getDecisionContext: (...args) => ({ args }),
    getLatestPlanSnapshot: async (...args) => ({ args }),
    getLatestResultSnapshot: async (...args) => ({ args }),
    subscribeGatewayEvents: (listener) => {
      events.push(listener)
      return () => events.splice(events.indexOf(listener), 1)
    },
    forbiddenSessionsMap: new Map()
  }
  const port = createGatewayPort(methods)

  assert.deepEqual(Object.keys(port), [
    'listSessions',
    'getSession',
    'sendTurn',
    'interrupt',
    'respondDecision',
    'getDecisionContext',
    'getLatestPlanSnapshot',
    'getLatestResultSnapshot',
    'subscribeGatewayEvents'
  ])
  assert.equal(Object.isFrozen(port), true)
  await port.sendTurn('session-1', 'test')
  await port.interrupt('session-1')
  await port.respondDecision('session-1', 'decision-1', { action: 'deny' })
  assert.deepEqual(calls, [
    ['turn', 'session-1', 'test'],
    ['interrupt', 'session-1'],
    ['decision', 'session-1', 'decision-1', { action: 'deny' }]
  ])
})

test('orchestrator wires permission and adapter lifecycle into the Gateway boundary', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )

  assert.match(source, /createGatewayPort\(/)
  assert.match(source, /adapter\.on\('gateway-event'/)
  assert.match(source, /gatewaySignals\.publish\(/)
  assert.match(source, /gatewayManager\?\.resyncSession\(sessionId\)/)
  assert.match(source, /gatewayManager\?\.respondDesktopDecision/)
  assert.match(
    source,
    /session:send-terminal-input[\s\S]*gatewayManager\?\.respondDesktopInput\(sessionId\)/
  )
  assert.match(source, /turnActive:\s*entry\._gatewayTurnActive === true/)
  assert.doesNotMatch(source, /gatewayRuntime\.sessions/)
  assert.match(source, /session:send-turn[\s\S]*sendAdapterTurn\(e, text\)/)
})

test('ordinary session turn delivery advances running state only after true acceptance', async () => {
  const rejected = {
    status: 'idle',
    _gatewayTurnActive: false,
    adapter: { sendTurn: async () => false }
  }
  assert.equal(await sendAdapterTurn(rejected, 'prompt'), false)
  assert.equal(rejected.status, 'idle')
  assert.equal(rejected._gatewayTurnActive, false)

  const accepted = {
    status: 'idle',
    _gatewayTurnActive: false,
    adapter: { sendTurn: async () => true }
  }
  assert.equal(await sendAdapterTurn(accepted, 'prompt'), true)
  assert.equal(accepted.status, 'running')
  assert.equal(accepted._gatewayTurnActive, true)
})
