import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveGatewayRelayControl } from '../src/gatewayRelayPresentation.js'

const session = (overrides = {}) => ({
  relayEnabled: true,
  routeStatus: 'active',
  status: 'idle',
  ...overrides
})

test('relay control distinguishes selection from effective forwarding', () => {
  assert.equal(deriveGatewayRelayControl({
    session: session({ relayEnabled: false }),
    gatewayPhase: 'connected',
    pending: false
  }).state, 'off')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'off',
    pending: false
  }).state, 'paused')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'waiting_binding',
    pending: false
  }).state, 'waiting_binding')
  assert.equal(deriveGatewayRelayControl({
    session: session({ routeStatus: 'waiting', status: 'stopped' }),
    gatewayPhase: 'connected',
    pending: false
  }).state, 'waiting_session')
  assert.deepEqual(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'connected',
    pending: false
  }), {
    selected: true,
    effective: true,
    state: 'forwarding',
    label: '正在转发',
    tooltip: '此会话正在通过 Gateway 转发',
    tone: 'green',
    nextEnabled: false
  })
})

test('pending and error states never look actively forwarded', () => {
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'connected',
    pending: true
  }).state, 'switching')
  assert.equal(deriveGatewayRelayControl({
    session: session(),
    gatewayPhase: 'error',
    pending: false
  }).state, 'error')
})

test('a runtime-ready route is actively forwarding when Gateway is connected', () => {
  assert.equal(deriveGatewayRelayControl({
    session: session({ routeStatus: 'ready' }),
    gatewayPhase: 'connected',
    pending: false
  }).state, 'forwarding')
})
