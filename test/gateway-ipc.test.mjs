import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { registerGatewayIpc } from '../electron/gateway/ipc.js'

function loadPreloadApi() {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const invocations = []
  const listeners = new Map()
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args })
        return Promise.resolve(channel)
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      }
    }
  )
  return { api, invocations, listeners }
}

function loadRendererIpc() {
  const source = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
    .replace('export const ipc =', 'const ipc =')
    .replace('export default ipc', '')
  const calls = []
  const method = (name) => (...args) => {
    calls.push([name, ...args])
    return Promise.resolve(name)
  }
  const ipc = new Function('window', `${source}\nreturn ipc`)({
    ucli: {
      getGatewayState: method('getState'),
      setGatewayDesiredEnabled: method('setEnabled'),
      getGatewayConfiguration: method('getConfig'),
      testGatewayDraft: method('testDraft'),
      applyGatewayDraft: method('applyDraft'),
      listGatewaySessions: method('listSessions'),
      setSessionRelayEnabled: method('setRelay'),
      resyncGatewaySession: method('resync'),
      onGatewayState: method('onState')
    }
  })
  return { ipc, calls }
}

test('main Gateway IPC validates booleans and opaque IDs before delegation', async () => {
  const handlers = new Map()
  const calls = []
  registerGatewayIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    manager: {
      getState: () => ({ phase: 'off' }),
      setDesiredEnabled: async (value) => calls.push(['enabled', value]),
      getConfiguration: () => null,
      testDraft: async (draft) => calls.push(['test', draft]),
      applyDraft: async (testId) => calls.push(['apply', testId]),
      listSessions: () => [],
      setSessionRelayEnabled: async (...args) => calls.push(['relay', ...args]),
      resyncSession: async (id) => calls.push(['resync', id])
    }
  })

  await assert.rejects(
    handlers.get('gateway:set-desired-enabled')({}, 'true'),
    { code: 'INVALID_GATEWAY_IPC' }
  )
  await assert.rejects(
    handlers.get('gateway:set-session-relay')({}, '../bad', true),
    { code: 'INVALID_GATEWAY_IPC' }
  )
  await handlers.get('gateway:set-desired-enabled')({}, true)
  await handlers.get('gateway:apply-draft')({}, 'test_abc-123')
  await handlers.get('gateway:set-session-relay')({}, 'session-1', false)
  await handlers.get('gateway:resync-session')({}, 'session-1')

  assert.deepEqual(calls, [
    ['enabled', true],
    ['apply', 'test_abc-123'],
    ['relay', 'session-1', false],
    ['resync', 'session-1']
  ])
})

test('preload exposes only named Gateway calls and a removable state listener', async () => {
  const { api, invocations, listeners } = loadPreloadApi()
  await api.getGatewayState()
  await api.setGatewayDesiredEnabled(true)
  await api.getGatewayConfiguration()
  await api.testGatewayDraft({ appSecret: 'plaintext-only-here' })
  await api.applyGatewayDraft('test_1')
  await api.listGatewaySessions()
  await api.setSessionRelayEnabled('session-1', true)
  await api.resyncGatewaySession('session-1')
  const states = []
  const unsubscribe = api.onGatewayState((state) => states.push(state))
  listeners.get('gateway:state')({}, { phase: 'connected' })
  unsubscribe()

  assert.deepEqual(invocations.map(({ channel }) => channel), [
    'gateway:get-state',
    'gateway:set-desired-enabled',
    'gateway:get-configuration',
    'gateway:test-draft',
    'gateway:apply-draft',
    'gateway:list-sessions',
    'gateway:set-session-relay',
    'gateway:resync-session'
  ])
  assert.deepEqual(states, [{ phase: 'connected' }])
  assert.equal(listeners.has('gateway:state'), false)
})

test('renderer IPC delegates the complete narrow Gateway surface', async () => {
  const { ipc, calls } = loadRendererIpc()
  await ipc.getGatewayState()
  await ipc.setGatewayDesiredEnabled(true)
  await ipc.getGatewayConfiguration()
  await ipc.testGatewayDraft({ config: {} })
  await ipc.applyGatewayDraft('test_1')
  await ipc.listGatewaySessions()
  await ipc.setSessionRelayEnabled('session-1', true)
  await ipc.resyncGatewaySession('session-1')
  await ipc.onGatewayState(() => {})

  assert.deepEqual(calls.map(([name]) => name), [
    'getState',
    'setEnabled',
    'getConfig',
    'testDraft',
    'applyDraft',
    'listSessions',
    'setRelay',
    'resync',
    'onState'
  ])
})
