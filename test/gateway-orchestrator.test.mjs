import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createGatewayPort } from '../electron/gateway/orchestratorPort.js'

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
  assert.doesNotMatch(source, /gatewayRuntime\.sessions/)
})
