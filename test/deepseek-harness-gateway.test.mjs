import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createGatewaySessionOperations,
  describeGatewaySessionEligibility
} from '../electron/gateway/orchestratorPort.js'
import { GatewayManager } from '../electron/gateway/manager.js'
import { DeepSeekHarnessAdapter } from '../electron/adapters/deepSeekHarnessAdapter.js'

const tuiCapabilities = {
  surface: 'terminal',
  permissionOwner: 'ucli',
  historyOwner: 'ucli',
  statsOwner: 'ucli',
  gateway: true,
  bridge: true
}

function fakePtyProcess() {
  return {
    pid: 8123,
    onData(handler) { this.dataHandler = handler },
    onExit(handler) { this.exitHandler = handler },
    write() {},
    resize() {}
  }
}

async function startDshGatewayAdapter({
  engine = null,
  onRequest = async () => ({ accepted: true }),
  isConnected = () => true,
  onAdapter = () => {},
  nativeBeforeHello = false
} = {}) {
  let bridgeOptions
  const requests = []
  const proc = fakePtyProcess()
  const bridge = {
    endpoint: 'dsh-gateway-endpoint',
    token: 'a'.repeat(64),
    protocolVersion: 1,
    isConnected,
    async waitForHello() {
      if (nativeBeforeHello) {
        bridgeOptions.onEvent({
          type: 'session-ready', nativeSessionId: 'native-gateway'
        })
      }
    },
    async request(method, params) {
      requests.push({ method, params })
      return onRequest(method, params)
    },
    async close() {}
  }
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'dsh-gateway',
      cwd: 'F:\\workspace',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine,
    settings: {
      inspectRuntime: async () => ({
        compatible: true,
        version: '0.1.0-rc.6',
        home: 'F:\\dsh-home',
        launch: { file: 'C:\\node.exe', prefixArgs: ['C:\\dsh\\bin.js'] }
      }),
      profileManager: {
        listProfiles: async () => ({ profiles: [{
          profileName: 'tui', profileReady: true,
          bridgeCompatible: true, bridgeVersion: '0.11.0'
        }] })
      },
      createBridgeServer: async options => {
        bridgeOptions = options
        return bridge
      },
      pty: { spawn: () => proc },
      terminatePtyTree: async (_ownedProc, exitPromise) => {
        proc.exitHandler?.({ exitCode: 0 })
        await exitPromise
      }
    }
  })
  onAdapter(adapter)
  await adapter.start()
  return { adapter, bridge, bridgeOptions, proc, requests }
}

test('DeepSeek Gateway eligibility requires a live bridged terminal surface', () => {
  assert.deepEqual(describeGatewaySessionEligibility({
    adapterId: 'deepseek-harness', capabilities: tuiCapabilities, bridgeLive: true
  }), { eligible: true, reason: null })
  assert.deepEqual(describeGatewaySessionEligibility({
    adapterId: 'deepseek-harness',
    capabilities: { ...tuiCapabilities, surface: 'web', gateway: false, bridge: false },
    bridgeLive: false
  }), { eligible: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED' })
  assert.deepEqual(describeGatewaySessionEligibility({
    adapterId: 'deepseek-harness', capabilities: tuiCapabilities, bridgeLive: false
  }), { eligible: false, reason: 'DSH_BRIDGE_DISCONNECTED' })
  assert.deepEqual(describeGatewaySessionEligibility({
    adapterId: 'deepseek-harness',
    adapterConfig: { surfacePreference: 'web' },
    capabilities: tuiCapabilities,
    bridgeLive: false
  }), { eligible: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED' })
})

test('Gateway manager exposes stable DSH reasons and rejects mutation before routing', async () => {
  const sessions = [
    { id: 'live', adapterId: 'deepseek-harness', status: 'idle', capabilities: tuiCapabilities, bridgeLive: true },
    { id: 'web', adapterId: 'deepseek-harness', status: 'idle', capabilities: { ...tuiCapabilities, surface: 'web', gateway: false, bridge: false }, bridgeLive: false },
    { id: 'gone', adapterId: 'deepseek-harness', status: 'idle', capabilities: tuiCapabilities, bridgeLive: false }
  ]
  let relayMutations = 0
  const runtime = {
    getState: () => ({}),
    getSessionRelayState: () => ({ queueCount: 0 }),
    async setSessionRelayEnabled() { relayMutations += 1; return { accepted: true } },
    async resyncSession() { relayMutations += 1 }
  }
  const manager = new GatewayManager({
    db: {}, safeStorage: {}, runtime,
    port: {
      listSessions: () => sessions,
      getSession: id => sessions.find(session => session.id === id) || null
    },
    routeStore: { listSessionRoutes: () => [] },
    secretStore: {},
    configService: { getAppliedConfig: () => null }
  })

  assert.deepEqual(manager.listSessions().map(({ id, gatewayEligible, gatewayReason }) => ({
    id, gatewayEligible, gatewayReason
  })), [
    { id: 'live', gatewayEligible: true, gatewayReason: null },
    { id: 'web', gatewayEligible: false, gatewayReason: 'DSH_WEB_GATEWAY_UNSUPPORTED' },
    { id: 'gone', gatewayEligible: false, gatewayReason: 'DSH_BRIDGE_DISCONNECTED' }
  ])
  assert.deepEqual(await manager.setSessionRelayEnabled('web', true), {
    accepted: false, reason: 'DSH_WEB_GATEWAY_UNSUPPORTED'
  })
  assert.deepEqual(await manager.setSessionRelayEnabled('gone', true), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.deepEqual(await manager.resyncSession('gone'), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.equal(relayMutations, 0)
})

test('Gateway session operations mutate turn state only after a live bridge accepts RPC', async () => {
  const rpcError = Object.assign(new Error('gone'), { code: 'DSH_BRIDGE_DISCONNECTED' })
  const entry = {
    status: 'idle',
    _gatewayTurnActive: false,
    adapter: { async sendTurn() { throw rpcError } }
  }
  let view = {
    id: 'dsh', adapterId: 'deepseek-harness', status: 'idle',
    capabilities: tuiCapabilities, bridgeLive: true
  }
  const operations = createGatewaySessionOperations({
    getEntry: () => entry,
    getSession: () => view
  })

  await assert.rejects(operations.sendTurn('dsh', 'Run tests'), error => error === rpcError)
  assert.equal(entry.status, 'idle')
  assert.equal(entry._gatewayTurnActive, false)

  view = { ...view, bridgeLive: false }
  entry.adapter.sendTurn = async () => assert.fail('disconnected route must not call RPC')
  assert.deepEqual(await operations.sendTurn('dsh', 'blocked'), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  assert.equal(entry.status, 'idle')
  assert.equal(entry._gatewayTurnActive, false)
})

test('renderer-started adapters resync Gateway after start has fully settled', () => {
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  const handler = source.match(/session:start-adapter'[\s\S]*?ipcMain\.handle\('session:send-turn'/)?.[0]
  assert.match(handler, /await e\.adapter\.start\(\)[\s\S]*await gatewayManager\?\.resyncSession\(sessionId\)[\s\S]*return true/)
  assert.match(source, /case 'init':[\s\S]*?native_session_id:[\s\S]*?await gatewayManager\?\.resyncSession\(sessionId\)[\s\S]*?break/)
})

test('a late session-ready changes a started adapter from disconnected to resync eligible', async () => {
  const { adapter, bridgeOptions } = await startDshGatewayAdapter()
  let resyncs = 0
  const sessionView = () => ({
    id: 'dsh-gateway', adapterId: 'deepseek-harness', status: 'idle',
    capabilities: tuiCapabilities, bridgeLive: adapter.isGatewayLive()
  })
  const manager = new GatewayManager({
    db: {}, safeStorage: {},
    port: { getSession: sessionView, listSessions: () => [sessionView()] },
    runtime: {
      async resyncSession() { resyncs += 1 },
      getState: () => ({}),
      getSessionRelayState: () => ({ queueCount: 0 })
    },
    routeStore: { listSessionRoutes: () => [] },
    secretStore: {}, configService: { getAppliedConfig: () => null }
  })

  assert.deepEqual(await manager.resyncSession('dsh-gateway'), {
    accepted: false, reason: 'DSH_BRIDGE_DISCONNECTED'
  })
  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-late' })
  assert.deepEqual(await manager.resyncSession('dsh-gateway'), { accepted: true })
  assert.equal(resyncs, 1)
})

test('DSH Gateway final results come only from assistant-committed before turn completion', async () => {
  const { adapter, bridgeOptions, proc } = await startDshGatewayAdapter()
  const gatewayEvents = []
  adapter.on('gateway-event', event => gatewayEvents.push(event))

  assert.equal(adapter.isGatewayLive(), false)
  bridgeOptions.onEvent({
    type: 'session-ready', nativeSessionId: 'native-gateway', model: 'deepseek'
  })
  assert.equal(adapter.isGatewayLive(), true)
  proc.dataHandler('terminal text must never become a Gateway final reply')
  bridgeOptions.onEvent({
    type: 'assistant-committed', nativeSessionId: 'native-gateway',
    turnId: 'turn-1', text: 'Committed answer'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-gateway',
    turnId: 'turn-1', status: 'completed'
  })

  assert.deepEqual(gatewayEvents.map(({ type, turnId }) => ({ type, turnId })), [
    { type: 'turn_completed', turnId: 'turn-1' }
  ])
  const result = await adapter.getLatestResultSnapshot('turn-1')
  assert.deepEqual({ ...result, capturedAt: 0 }, {
    kind: 'result',
    title: 'DeepSeek Harness result',
    markdown: 'Committed answer',
    provider: 'deepseek-harness',
    nativeSessionId: 'native-gateway',
    turnId: 'turn-1',
    capturedAt: 0
  })
  assert.equal(await adapter.getLatestResultSnapshot('unknown-turn'), null)

  bridgeOptions.onEvent({
    type: 'result-snapshot', nativeSessionId: 'native-gateway',
    markdown: 'A later mismatched snapshot must not replace committed output'
  })
  assert.equal((await adapter.getLatestResultSnapshot('turn-1')).markdown, 'Committed answer')
})

test('DSH Gateway maps controls, terminal outcomes, and optionId approvals', async () => {
  const approvals = []
  const { adapter, bridgeOptions, requests } = await startDshGatewayAdapter({
    engine: {
      respondApproval(sessionId, decisionId, verdict) {
        approvals.push({ sessionId, decisionId, verdict })
        return true
      }
    }
  })
  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-gateway' })
  const events = []
  adapter.on('gateway-event', event => events.push(event))

  await adapter.sendTurn('Run tests')
  await adapter.interrupt()
  assert.deepEqual(requests, [
    { method: 'turn.send', params: { nativeSessionId: 'native-gateway', text: 'Run tests' } },
    { method: 'turn.interrupt', params: { nativeSessionId: 'native-gateway' } }
  ])
  assert.deepEqual(await adapter.respondDecision('decision-1', { optionId: 'allow_once' }), {
    accepted: true
  })
  assert.deepEqual(approvals, [{
    sessionId: 'dsh-gateway', decisionId: 'decision-1', verdict: 'allow'
  }])

  for (const [turnId, status] of [
    ['turn-interrupted', 'interrupted'],
    ['turn-failed', 'failed']
  ]) {
    bridgeOptions.onEvent({
      type: 'turn-complete', nativeSessionId: 'native-gateway', turnId, status
    })
  }
  assert.deepEqual(events.map(({ type, turnId }) => ({ type, turnId })), [
    { type: 'turn_interrupted', turnId: 'turn-interrupted' },
    { type: 'turn_failed', turnId: 'turn-failed' }
  ])
})

test('DSH snapshot fallback never assigns another turn committed result to a failed turn', async () => {
  const { adapter, bridgeOptions, requests } = await startDshGatewayAdapter({
    onRequest: async method => method === 'snapshot.plan'
      ? { markdown: '# Cached plan' }
      : { turnId: 'turn-fallback', markdown: 'Fallback committed result' }
  })
  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-gateway' })

  assert.equal((await adapter.getLatestPlanSnapshot('decision-1')).markdown, '# Cached plan')
  bridgeOptions.onEvent({
    type: 'assistant-committed', nativeSessionId: 'native-gateway',
    turnId: 'turn-committed', text: 'Committed A'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-gateway',
    turnId: 'turn-committed', status: 'completed'
  })
  assert.equal(
    (await adapter.getLatestResultSnapshot('turn-committed')).markdown,
    'Committed A'
  )

  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-gateway',
    turnId: 'turn-failed', status: 'failed'
  })
  const before = requests.length
  assert.equal(await adapter.getLatestResultSnapshot('turn-failed'), null)
  assert.equal(requests.length, before)

  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-gateway',
    turnId: 'turn-fallback', status: 'completed'
  })
  assert.equal(
    (await adapter.getLatestResultSnapshot('turn-fallback')).markdown,
    'Fallback committed result'
  )
})

test('DSH emits one terminal lifecycle event per turn and one stopped event per bridge generation', async () => {
  let liveAtReady = false
  const { adapter, bridgeOptions, proc } = await startDshGatewayAdapter({
    nativeBeforeHello: true,
    onAdapter(value) {
      value.on('event', event => {
        if (event.type === 'ready') liveAtReady = value.isGatewayLive()
      })
    }
  })
  const events = []
  adapter.on('gateway-event', event => events.push(event))

  for (let index = 0; index < 2; index += 1) {
    bridgeOptions.onEvent({
      type: 'turn-complete', nativeSessionId: 'native-gateway',
      turnId: 'turn-aborted', status: 'aborted'
    })
  }
  proc.exitHandler({ exitCode: 0 })
  proc.exitHandler({ exitCode: 0 })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(liveAtReady, true)
  assert.deepEqual(events.map(({ type, turnId }) => ({ type, turnId })), [
    { type: 'turn_interrupted', turnId: 'turn-aborted' },
    { type: 'session_stopped', turnId: undefined }
  ])
})
