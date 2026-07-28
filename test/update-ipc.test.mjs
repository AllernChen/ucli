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
      getUpdateState: () => { calls.push('get'); return Promise.resolve('get') },
      checkForUpdates: () => { calls.push('check'); return Promise.resolve('check') },
      downloadUpdate: () => { calls.push('download'); return Promise.resolve('download') },
      installUpdate: () => { calls.push('install'); return Promise.resolve('install') }
    }
  })
  return { ipc, calls }
}

test('preload update methods invoke only named main-process update channels', async () => {
  const { api, calls } = loadPreloadApi()

  assert.equal(typeof api.getUpdateState, 'function')
  assert.equal(typeof api.checkForUpdates, 'function')
  assert.equal(typeof api.downloadUpdate, 'function')
  assert.equal(typeof api.installUpdate, 'function')
  await api.getUpdateState()
  await api.checkForUpdates()
  await api.downloadUpdate()
  await api.installUpdate()

  assert.deepEqual(calls, ['update:get-state', 'update:check', 'update:download', 'update:install'])
})

test('renderer IPC delegates update calls to the preload bridge', async () => {
  const { ipc, calls } = loadRendererIpc()

  assert.equal(typeof ipc.getUpdateState, 'function')
  assert.equal(typeof ipc.checkForUpdates, 'function')
  assert.equal(typeof ipc.downloadUpdate, 'function')
  assert.equal(typeof ipc.installUpdate, 'function')
  await ipc.getUpdateState()
  await ipc.checkForUpdates()
  await ipc.downloadUpdate()
  await ipc.installUpdate()

  assert.deepEqual(calls, ['get', 'check', 'download', 'install'])
})
