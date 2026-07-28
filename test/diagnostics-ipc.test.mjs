import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadPreloadApi() {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const calls = []
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    { invoke: (channel) => { calls.push(channel); return Promise.resolve(channel) }, on: () => {}, removeListener: () => {} }
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
      getDiagnostics: () => { calls.push('get'); return Promise.resolve('get') },
      exportDiagnostics: () => { calls.push('export'); return Promise.resolve('export') }
    }
  })
  return { ipc, calls }
}

test('preload diagnostics methods invoke only the main-process diagnostic channels', async () => {
  const { api, calls } = loadPreloadApi()

  assert.equal(typeof api.getDiagnostics, 'function')
  assert.equal(typeof api.exportDiagnostics, 'function')
  await api.getDiagnostics()
  await api.exportDiagnostics()

  assert.deepEqual(calls, ['diagnostics:get', 'diagnostics:export'])
})

test('renderer IPC delegates diagnostics calls to the preload bridge', async () => {
  const { ipc, calls } = loadRendererIpc()

  assert.equal(typeof ipc.getDiagnostics, 'function')
  assert.equal(typeof ipc.exportDiagnostics, 'function')
  await ipc.getDiagnostics()
  await ipc.exportDiagnostics()

  assert.deepEqual(calls, ['get', 'export'])
})
