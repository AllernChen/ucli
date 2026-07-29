import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { registerSessionHistoryIpc } from '../electron/sessionHistoryService.js'

function loadPreloadApi() {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const calls = []
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: (channel, ...args) => {
        calls.push({ channel, args })
        return Promise.resolve(channel)
      },
      on: () => {},
      removeListener: () => {}
    }
  )
  return { api, calls }
}

function loadRendererIpc() {
  const source = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
    .replace('export const ipc =', 'const ipc =')
    .replace('export default ipc', '')
  const calls = []
  const ipc = new Function('window', `${source}\nreturn ipc`)({
    ucli: {
      getSessionHistory: (...args) => {
        calls.push(args)
        return Promise.resolve('history')
      }
    }
  })
  return { ipc, calls }
}

test('main history IPC forwards only session ID and pagination options to the service', async () => {
  const handlers = new Map()
  const calls = []
  registerSessionHistoryIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    }
  }, {
    getPage: async (...args) => {
      calls.push(args)
      return { source: 'claude', items: [], nextBefore: null, complete: true }
    }
  })

  const result = await handlers.get('session:get-history')(
    {},
    'ucli-session',
    { before: 20, limit: 10 }
  )

  assert.deepEqual(calls, [['ucli-session', { before: 20, limit: 10 }]])
  assert.deepEqual(result, {
    source: 'claude',
    items: [],
    nextBefore: null,
    complete: true
  })
})

test('preload history method invokes the named main-process channel', async () => {
  const { api, calls } = loadPreloadApi()

  assert.equal(typeof api.getSessionHistory, 'function')
  await api.getSessionHistory('ucli-session', { before: 20, limit: 10 })

  assert.deepEqual(calls, [{
    channel: 'session:get-history',
    args: ['ucli-session', { before: 20, limit: 10 }]
  }])
})

test('renderer IPC delegates session history calls to the preload bridge', async () => {
  const { ipc, calls } = loadRendererIpc()

  assert.equal(await ipc.getSessionHistory('ucli-session', { limit: 100 }), 'history')
  assert.deepEqual(calls, [['ucli-session', { limit: 100 }]])
})
