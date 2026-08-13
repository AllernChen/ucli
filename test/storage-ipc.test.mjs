import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const {
  registerStorageIpc,
  validateStorageClear
} = await import(`../electron/orchestrator.js?storage-ipc=${Date.now()}`)

function loadPreloadApi(invoke) {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    { invoke, on: () => {}, removeListener: () => {} }
  )
  return api
}

function loadRendererIpc(ucli) {
  const source = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
    .replace('export const ipc =', 'const ipc =')
    .replace('export default ipc', '')
  return new Function('window', `${source}\nreturn ipc`)({ ucli })
}

function registry() {
  const handlers = new Map()
  return {
    handlers,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler) } }
  }
}

const unsafeSnapshot = {
  revision: 3,
  scannedAt: 1786554000000,
  totalBytes: 4096,
  reclaimableBytes: 2048,
  pendingRestart: ['browser-cache'],
  path: 'C:\\private',
  categories: [{
    id: 'browser-cache',
    bytes: 2048,
    itemCount: 12,
    reclaimableBytes: 2048,
    status: 'scheduled',
    clearMode: 'restart',
    name: 'Cache',
    path: 'C:\\private\\Cache',
    error: 'access token'
  }]
}

test('storage IPC registers only the two narrow channels', () => {
  const { handlers, ipcMain } = registry()
  registerStorageIpc({ ipcMain, service: { getUsage() {}, clear() {} } })
  assert.deepEqual([...handlers.keys()].sort(), ['storage:clear', 'storage:get-usage'])
})

test('storage:get-usage accepts no renderer input and returns an exact safe snapshot', async () => {
  const { handlers, ipcMain } = registry()
  registerStorageIpc({ ipcMain, service: { getUsage: () => unsafeSnapshot, clear() {} } })

  const value = await handlers.get('storage:get-usage')({})
  assert.deepEqual(value, {
    revision: 3,
    scannedAt: 1786554000000,
    totalBytes: 4096,
    reclaimableBytes: 2048,
    pendingRestart: ['browser-cache'],
    categories: [{
      id: 'browser-cache', bytes: 2048, itemCount: 12,
      reclaimableBytes: 2048, status: 'scheduled', clearMode: 'restart'
    }]
  })
  await assert.rejects(
    handlers.get('storage:get-usage')({}, { path: 'C:\\private' }),
    error => error.code === 'INVALID_STORAGE_REQUEST'
  )
})

test('storage:clear accepts exactly one fixed category id and strips service metadata', async () => {
  const { handlers, ipcMain } = registry()
  const calls = []
  registerStorageIpc({
    ipcMain,
    service: {
      getUsage() {},
      clear(request) {
        calls.push(request)
        return {
          categoryId: request.categoryId,
          pendingRestart: false,
          removed: 2,
          bytes: 1024,
          remainingBytes: 4,
          partial: true,
          path: 'C:\\private',
          error: 'locked C:\\private\\secret'
        }
      }
    }
  })

  const value = await handlers.get('storage:clear')({}, { categoryId: 'summary-cache' })
  assert.deepEqual(calls, [{ categoryId: 'summary-cache' }])
  assert.deepEqual(value, {
    categoryId: 'summary-cache', pendingRestart: false,
    removed: 2, bytes: 1024, remainingBytes: 4, partial: true
  })

  for (const request of [
    { categoryId: 'summary-cache', path: 'C:\\' },
    { categoryId: '../summary-cache' },
    { categoryId: 'unknown' },
    {},
    null
  ]) {
    assert.throws(
      () => validateStorageClear(request),
      error => error.code === 'INVALID_STORAGE_REQUEST'
    )
  }
})

test('storage IPC replaces unexpected filesystem failures with a stable error', async () => {
  const { handlers, ipcMain } = registry()
  registerStorageIpc({
    ipcMain,
    service: {
      getUsage() {
        throw Object.assign(new Error('EACCES C:\\private\\Cache token=secret'), {
          code: 'EACCES', path: 'C:\\private\\Cache'
        })
      },
      clear() {}
    }
  })

  await assert.rejects(
    handlers.get('storage:get-usage')({}),
    error => error.code === 'STORAGE_OPERATION_FAILED' &&
      error.message === 'Storage operation failed' &&
      !JSON.stringify(error).includes('private') &&
      !JSON.stringify(error).includes('secret')
  )
})

test('logger cleanup truncates only the UCLI-owned current log', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ucli-storage-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  process.env.UCLI_TEST_USER_DATA = directory
  const logPath = join(directory, 'ucli.log')
  const otherPath = join(directory, 'other.log')
  await writeFile(logPath, 'current log')
  await writeFile(otherPath, 'keep this')

  const { truncateLog } = await import('../electron/logger.js')
  truncateLog()

  assert.equal(await readFile(logPath, 'utf8'), '')
  assert.equal(await readFile(otherPath, 'utf8'), 'keep this')
})

test('renderer storage bridge forwards only named category methods', async () => {
  const calls = []
  const api = loadPreloadApi((channel, ...args) => {
    calls.push([channel, ...args])
    return channel
  })
  const ipc = loadRendererIpc(api)
  assert.equal(ipc.getStorageUsage(), 'storage:get-usage')
  assert.equal(ipc.clearStorageCategory('summary-cache'), 'storage:clear')
  assert.deepEqual(calls, [
    ['storage:get-usage'],
    ['storage:clear', { categoryId: 'summary-cache' }]
  ])
})
