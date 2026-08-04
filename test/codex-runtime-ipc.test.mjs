import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadPreloadApi() {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const invocations = []
  const listeners = new Map()
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: (channel) => { invocations.push(channel); return Promise.resolve(channel) },
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
  const ipc = new Function('window', `${source}\nreturn ipc`)({
    ucli: {
      getCodexRuntime: () => { calls.push('get') },
      onCodexRuntime: () => { calls.push('on') }
    }
  })
  return { ipc, calls }
}

test('preload exposes the named Codex runtime channel and removable listener', async () => {
  const { api, invocations, listeners } = loadPreloadApi()
  assert.equal(typeof api.getCodexRuntime, 'function')
  assert.equal(typeof api.onCodexRuntime, 'function')

  await api.getCodexRuntime()
  const unsubscribe = api.onCodexRuntime(() => {})
  unsubscribe()

  assert.deepEqual(invocations, ['codex:runtime:get'])
  assert.equal(listeners.has('codex:runtime'), false)
})

test('renderer IPC delegates Codex runtime calls to the preload bridge', () => {
  const { ipc, calls } = loadRendererIpc()
  assert.equal(typeof ipc.getCodexRuntime, 'function')
  assert.equal(typeof ipc.onCodexRuntime, 'function')

  ipc.getCodexRuntime()
  ipc.onCodexRuntime(() => {})

  assert.deepEqual(calls, ['get', 'on'])
})
