import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { GatewayManager } from '../electron/gateway/manager.js'
import {
  createPort,
  MemoryRouteStore
} from './helpers/gatewayRuntimeHarness.mjs'

function memoryDb(values = {}) {
  const settings = new Map(Object.entries(values))
  return {
    getGatewaySetting: (key) => settings.get(key) ?? null,
    saveGatewaySetting: (key, value) => settings.set(key, structuredClone(value)),
    flush: () => {},
    async transaction(work) { return work() }
  }
}

test('a startup connection failure becomes Gateway error state without rejecting startup', async () => {
  const db = memoryDb({
    'gateway.desiredEnabled': true,
    'gateway.config': {
      channelType: 'feishu',
      appId: 'cli_example',
      target: { type: 'group', id: 'oc_group' },
      operatorOpenIds: ['ou_operator']
    }
  })
  const manager = new GatewayManager({
    db,
    port: createPort(),
    routeStore: new MemoryRouteStore(),
    secretStore: { getSecret: () => 'secret', hasSecret: () => true },
    configService: { dispose: async () => {} },
    createChannel: () => ({
      async connect() {
        throw Object.assign(new Error('raw secret-bearing failure'), {
          code: 'permission_denied'
        })
      },
      async disconnect() {}
    })
  })

  await manager.start()

  assert.equal(manager.getState().desiredEnabled, true)
  assert.equal(manager.getState().phase, 'error')
  assert.equal(manager.getState().errorCode, 'permission_denied')
  assert.equal(JSON.stringify(manager.getState()).includes('raw secret-bearing failure'), false)
})

test('a valid persisted enable connects once and shutdown disconnects without changing intent', async () => {
  const db = memoryDb({
    'gateway.desiredEnabled': true,
    'gateway.config': {
      channelType: 'feishu',
      appId: 'cli_example',
      target: { type: 'group', id: 'oc_group' },
      operatorOpenIds: ['ou_operator']
    }
  })
  const channel = {
    connectCount: 0,
    disconnectCount: 0,
    async connect() {
      this.connectCount += 1
      return { openId: 'ou_bot', name: 'UCLI Bot' }
    },
    async disconnect() {
      this.disconnectCount += 1
    },
    onUserMessage: () => () => {},
    onAction: () => () => {},
    onStatus: () => () => {}
  }
  const manager = new GatewayManager({
    db,
    port: createPort(),
    routeStore: new MemoryRouteStore(),
    secretStore: { getSecret: () => 'secret', hasSecret: () => true },
    configService: { dispose: async () => {} },
    createChannel: () => channel
  })

  await manager.start()
  assert.equal(manager.getState().phase, 'connected')
  assert.equal(channel.connectCount, 1)
  await manager.shutdown()
  assert.equal(channel.disconnectCount, 1)
  assert.equal(db.getGatewaySetting('gateway.desiredEnabled'), true)
})

test('manual enable keeps configuration errors explicit and connection errors redacted', async () => {
  const config = {
    channelType: 'feishu',
    appId: 'cli_example',
    target: { type: 'group', id: 'oc_group' },
    operatorOpenIds: ['ou_operator']
  }
  const missing = new GatewayManager({
    db: memoryDb(),
    port: createPort(),
    routeStore: new MemoryRouteStore(),
    secretStore: { getSecret: () => null, hasSecret: () => false },
    configService: { invalidateTests: () => {}, dispose: async () => {} },
    createChannel: () => ({})
  })
  await missing.start()
  await assert.rejects(missing.setDesiredEnabled(true), { code: 'CONFIG_REQUIRED' })
  assert.equal(missing.getState().desiredEnabled, false)

  const failing = new GatewayManager({
    db: memoryDb({ 'gateway.config': config }),
    port: createPort(),
    routeStore: new MemoryRouteStore(),
    secretStore: { getSecret: () => 'secret', hasSecret: () => true },
    configService: { invalidateTests: () => {}, dispose: async () => {} },
    createChannel: () => ({
      async connect() {
        throw Object.assign(new Error('raw app secret and network details'), {
          code: 'permission_denied'
        })
      },
      async disconnect() {}
    })
  })
  await failing.start()
  await assert.rejects(
    failing.setDesiredEnabled(true),
    (error) =>
      error.code === 'permission_denied' &&
      !error.message.includes('raw app secret')
  )
  assert.equal(failing.getState().desiredEnabled, true)
  assert.equal(failing.getState().phase, 'error')
})

test('main process starts Gateway after persistence and shuts it down before adapters', () => {
  const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )

  const persistence = main.indexOf('await orchestrator.initPersistence()')
  const gateway = main.indexOf('await orchestrator.startGateway()')
  const ipc = main.indexOf('orchestrator.registerIpc()')
  assert.ok(persistence >= 0 && gateway > persistence && ipc > gateway)

  const gatewayShutdown = orchestrator.indexOf('await gatewayManager?.shutdown()')
  const adapterShutdown = orchestrator.indexOf('entry.adapter.dispose()', gatewayShutdown)
  const hookShutdown = orchestrator.indexOf('await server?.close()', adapterShutdown)
  const databaseFlush = orchestrator.indexOf('db.flush()', hookShutdown)
  assert.ok(gatewayShutdown >= 0 && adapterShutdown > gatewayShutdown)
  assert.ok(hookShutdown > adapterShutdown && databaseFlush > hookShutdown)
})
