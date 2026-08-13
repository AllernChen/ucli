import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function loadPreloadApi() {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  const calls = []
  const listeners = new Map()
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    {
      invoke: channel => { calls.push(channel); return Promise.resolve(channel) },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      }
    }
  )
  return { api, calls, listeners }
}

function loadRendererIpc(ucli) {
  const source = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
    .replace('export const ipc =', 'const ipc =')
    .replace('export default ipc', '')
  return new Function('window', `${source}\nreturn ipc`)({ ucli })
}

test('preload exposes named update calls and a removable update-state subscription', async () => {
  const { api, calls, listeners } = loadPreloadApi()
  const snapshots = []
  const unsubscribe = api.onUpdateState(snapshot => snapshots.push(snapshot))

  listeners.get('update:state')({}, { revision: 2, status: 'available' })
  await api.getUpdateState()
  await api.checkForUpdates()
  await api.downloadUpdate()
  await api.installUpdate()
  unsubscribe()

  assert.deepEqual(snapshots, [{ revision: 2, status: 'available' }])
  assert.equal(listeners.has('update:state'), false)
  assert.deepEqual(calls, ['update:get-state', 'update:check', 'update:download', 'update:install'])
})

test('renderer IPC delegates the named update subscription without generic channels', () => {
  const calls = []
  const unsubscribe = () => {}
  const ipc = loadRendererIpc({
    getUpdateState: () => 'get',
    checkForUpdates: () => 'check',
    downloadUpdate: () => 'download',
    installUpdate: () => 'install',
    onUpdateState: handler => { calls.push(handler); return unsubscribe }
  })
  const handler = () => {}

  assert.equal(ipc.onUpdateState(handler), unsubscribe)
  assert.deepEqual(calls, [handler])
})
