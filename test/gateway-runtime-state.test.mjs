import assert from 'node:assert/strict'
import test from 'node:test'

import { GatewayRuntime } from '../electron/gateway/runtime.js'
import {
  createPort,
  FakeGatewayChannel,
  FEISHU_CONFIG,
  MemoryRouteStore,
  session
} from './helpers/gatewayRuntimeHarness.mjs'

test('runtime publishes redacted observable state for every connection transition', async () => {
  const port = createPort([session('session-1')])
  const routes = new MemoryRouteStore()
  routes.upsertSessionRoute({ sessionId: 'session-1', relayEnabled: true })
  const channel = new FakeGatewayChannel()
  const published = []
  const runtime = new GatewayRuntime({
    port,
    routeStore: routes,
    publishState: (state) => published.push(state)
  })

  await runtime.attachConnectedChannel({
    channel,
    config: FEISHU_CONFIG,
    fingerprint: 'fingerprint-1',
    botIdentity: { openId: 'ou_bot', name: 'UCLI Bot' }
  })
  assert.deepEqual(runtime.getState(), {
    desiredEnabled: true,
    phase: 'connected',
    channelType: 'feishu',
    targetLabel: 'oc_group',
    errorCode: null,
    errorMessage: '',
    selectedSessionCount: 1,
    readySessionCount: 1,
    pendingDecisionCount: 0,
    queuedTaskCount: 0,
    lastConnectedAt: runtime.getState().lastConnectedAt
  })

  await channel.emitStatus({ type: 'reconnecting' })
  await channel.emitStatus({ type: 'reconnected' })
  await channel.emitStatus({
    type: 'error',
    errorCode: 'permission_denied',
    errorMessage: 'raw credential details'
  })
  assert.deepEqual(published.slice(-3).map((state) => state.phase), [
    'reconnecting',
    'connected',
    'error'
  ])
  assert.equal(JSON.stringify(published).includes('raw credential details'), false)
})
