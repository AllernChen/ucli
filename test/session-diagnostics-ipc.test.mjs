import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { registerSessionDiagnosticsIpc } from '../electron/sessionDiagnosticsService.js'

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
  const ipc = new Function('window', `${source}\nreturn ipc`)( {
    ucli: {
      getSessionDiagnostics: (...args) => {
        calls.push({ method: 'get', args })
        return Promise.resolve('diagnostic')
      },
      repairSessionBinding: (...args) => {
        calls.push({ method: 'repair', args })
        return Promise.resolve('repair')
      }
    }
  })
  return { ipc, calls }
}

test('main session diagnostics IPC forwards only the selected UCLI session ID', async () => {
  const handlers = new Map()
  const calls = []
  registerSessionDiagnosticsIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    }
  }, {
    get: async (...args) => {
      calls.push({ method: 'get', args })
      return { bindingState: 'current' }
    },
    repair: async (...args) => {
      calls.push({ method: 'repair', args })
      return { changed: false }
    }
  })

  assert.deepEqual(await handlers.get('session:get-diagnostics')({}, 'ucli-session'), {
    bindingState: 'current'
  })
  assert.deepEqual(await handlers.get('session:repair-binding')({}, 'ucli-session'), {
    changed: false
  })
  assert.deepEqual(calls, [
    { method: 'get', args: ['ucli-session'] },
    { method: 'repair', args: ['ucli-session'] }
  ])
})

test('preload invokes the allowlisted session diagnostics channels with the session ID', async () => {
  const { api, calls } = loadPreloadApi()

  assert.equal(typeof api.getSessionDiagnostics, 'function')
  assert.equal(typeof api.repairSessionBinding, 'function')
  await api.getSessionDiagnostics('ucli-session')
  await api.repairSessionBinding('ucli-session')

  assert.deepEqual(calls, [
    { channel: 'session:get-diagnostics', args: ['ucli-session'] },
    { channel: 'session:repair-binding', args: ['ucli-session'] }
  ])
})

test('renderer IPC delegates session diagnostics calls to the preload bridge', async () => {
  const { ipc, calls } = loadRendererIpc()

  assert.equal(await ipc.getSessionDiagnostics('ucli-session'), 'diagnostic')
  assert.equal(await ipc.repairSessionBinding('ucli-session'), 'repair')
  assert.deepEqual(calls, [
    { method: 'get', args: ['ucli-session'] },
    { method: 'repair', args: ['ucli-session'] }
  ])
})
