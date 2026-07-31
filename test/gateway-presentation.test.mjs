import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import {
  gatewayPhaseColor,
  gatewayPhaseLabel,
  gatewayTargetLabel,
  gatewayTooltip
} from '../src/gatewayPresentation.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const runtime = (overrides = {}) => ({ phase: 'off', ...overrides })
const initialSessions = [{ id: 'session-1', relayEnabled: false }]

let stateCalls = 0
let configurationCalls = 0
let sessionCalls = 0
let relayCalls = 0
let relayRequest = null

globalThis.window = {
  ucli: {
    onGatewayState: () => () => {},
    getGatewayState: async () => {
      stateCalls += 1
      return runtime()
    },
    getGatewayConfiguration: async () => {
      configurationCalls += 1
      return { configured: false }
    },
    listGatewaySessions: async () => {
      sessionCalls += 1
      return initialSessions
    },
    setSessionRelayEnabled: async () => {
      relayCalls += 1
      return relayRequest.promise
    }
  }
}

const { useGatewayStore } = await import('../src/stores/gateway.js')

function freshGatewayStore() {
  setActivePinia(createPinia())
  return useGatewayStore()
}

test('Gateway presentation covers every runtime phase with safe Chinese labels', () => {
  assert.deepEqual(
    ['off', 'connecting', 'waiting_binding', 'connected', 'reconnecting', 'error']
      .map(gatewayPhaseLabel),
    ['已关闭', '连接中', '等待绑定', '已连接', '重连中', '连接异常']
  )
  assert.deepEqual(
    ['off', 'connecting', 'waiting_binding', 'connected', 'reconnecting', 'error']
      .map(gatewayPhaseColor),
    ['default', 'blue', 'orange', 'green', 'orange', 'red']
  )
})

test('Gateway target and tooltip expose bounded metadata rather than endpoint details', () => {
  assert.equal(
    gatewayTargetLabel({ target: { type: 'group', id: 'oc_1234567890' } }),
    '群聊 · oc_1…7890'
  )
  const tooltip = gatewayTooltip({
    selectedSessionCount: 2,
    readySessionCount: 1,
    errorMessage: 'Gateway 权限不足，请检查飞书应用权限。'
  })
  assert.match(tooltip, /已选择 2/)
  assert.match(tooltip, /可转发 1/)
  assert.match(tooltip, /Gateway 权限不足/)
})

test('unbound Gateway presentation explains that Feishu is waiting for binding', () => {
  assert.equal(gatewayPhaseLabel('waiting_binding'), '等待绑定')
  assert.equal(gatewayTargetLabel({ target: null }), '等待飞书绑定')
  assert.equal(
    gatewayTargetLabel({
      target: { type: 'group', id: 'oc_1234567890', name: '研发群' }
    }),
    '群聊 · 研发群'
  )
})

test('Gateway store never declares or assigns an App Secret field', () => {
  const source = readFileSync(
    new URL('../src/stores/gateway.js', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /appSecret/)
  assert.match(source, /onGatewayState/)
  assert.match(source, /testGatewayDraft/)
  assert.match(source, /setSessionRelayEnabled/)
  assert.match(source, /requireApplied/)
  assert.match(source, /configuration_operation_in_progress/)
})

test('Gateway store shares one in-flight IPC initialization across callers', async () => {
  const gate = deferred()
  stateCalls = 0
  configurationCalls = 0
  sessionCalls = 0
  globalThis.window.ucli.getGatewayState = async () => {
    stateCalls += 1
    return gate.promise
  }
  const gateway = freshGatewayStore()

  const first = gateway.init()
  const second = gateway.init()
  assert.equal(stateCalls, 1)
  assert.equal(configurationCalls, 1)
  assert.equal(sessionCalls, 1)

  gate.resolve(runtime({ phase: 'connected' }))
  await Promise.all([first, second])
  assert.equal(gateway.initialized, true)
  assert.equal(gateway.loading, false)
  assert.equal(gateway.runtime.phase, 'connected')
})

test('Gateway store rejects a concurrent relay update for the same session', async () => {
  const gateway = freshGatewayStore()
  gateway.sessions = initialSessions
  relayCalls = 0
  relayRequest = deferred()
  globalThis.window.ucli.getGatewayState = async () => runtime({ phase: 'connected' })

  const first = gateway.setSessionRelayEnabled('session-1', true)
  assert.equal(gateway.relayPendingFor('session-1'), true)
  await assert.rejects(
    gateway.setSessionRelayEnabled('session-1', false),
    (error) => error.code === 'GATEWAY_RELAY_BUSY'
  )
  assert.equal(relayCalls, 1)

  relayRequest.resolve({ accepted: true })
  await first
  assert.equal(gateway.relayPendingFor('session-1'), false)
})

test('Gateway store restores server state after a rejected relay mutation', async () => {
  const gateway = freshGatewayStore()
  gateway.sessions = initialSessions
  relayRequest = {
    promise: Promise.resolve({ accepted: false, reason: 'relay_rejected' })
  }
  globalThis.window.ucli.listGatewaySessions = async () => [
    { id: 'session-1', relayEnabled: false, routeStatus: 'waiting' }
  ]
  globalThis.window.ucli.getGatewayState = async () => runtime({ phase: 'off' })

  await assert.rejects(
    gateway.setSessionRelayEnabled('session-1', true),
    (error) => error.code === 'relay_rejected'
  )
  assert.deepEqual(gateway.relaySessionFor('session-1'), {
    id: 'session-1', relayEnabled: false, routeStatus: 'waiting'
  })
  assert.equal(gateway.runtime.phase, 'off')
  assert.equal(gateway.relayPendingFor('session-1'), false)
})
