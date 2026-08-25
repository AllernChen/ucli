import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createCodexConfigWatcher } from '../electron/codexConfigWatcher.js'

test('Codex config watcher emits a sanitised snapshot only when provider identity changes', async () => {
  const snapshots = [
    { codexHome: 'C:/codex', configPath: 'C:/codex/config.toml', currentProvider: 'first', availableProviders: ['openai', 'first'], providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'first', displayName: 'First' }], revision: 0, mtimeMs: 1 },
    { codexHome: 'C:/codex', configPath: 'C:/codex/config.toml', currentProvider: 'next', availableProviders: ['openai', 'next'], providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'next', displayName: 'Next' }], revision: 0, mtimeMs: 2 },
    { codexHome: 'C:/codex', configPath: 'C:/codex/config.toml', currentProvider: 'next', availableProviders: ['openai', 'next'], providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'next', displayName: 'Next' }], revision: 0, mtimeMs: 2 }
  ]
  let readCount = 0
  let callback = null
  let closed = false
  const changes = []
  const watcher = createCodexConfigWatcher({
    readSnapshot: () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    resolveWatchDirectory: (directory) => directory,
    watchDirectory: (_directory, onChange) => {
      callback = onChange
      return { close: () => { closed = true } }
    },
    debounceMs: 0,
    onChange: (snapshot) => changes.push(snapshot)
  })

  assert.deepEqual(watcher.start('C:/codex'), { ...snapshots[0], revision: 0 })
  callback('change', 'other.toml')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(changes, [])

  callback('rename', 'config.toml')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(changes, [{
    codexHome: 'C:/codex',
    configPath: 'C:/codex/config.toml',
    currentProvider: 'next',
    availableProviders: ['openai', 'next'],
    providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'next', displayName: 'Next' }],
    revision: 1,
    mtimeMs: 2
  }])

  callback('change', 'ucli-company.config.toml')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(changes.length, 1)

  callback('change', 'ucli-550e8400e29b41d4a716446655440000.config.toml')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(changes.at(-1), { ...snapshots[2], revision: 2 })
  assert.equal(JSON.stringify(changes).includes('content'), false)

  watcher.stop()
  assert.equal(closed, true)
})

test('Codex config watcher stop waits for the underlying watcher to close', async () => {
  const handle = new EventEmitter()
  handle.close = () => {}
  const watcher = createCodexConfigWatcher({
    readSnapshot: () => ({
      codexHome: 'C:/codex',
      configPath: 'C:/codex/config.toml',
      currentProvider: 'openai',
      availableProviders: ['openai'],
      providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }],
      mtimeMs: 1
    }),
    resolveWatchDirectory: (directory) => directory,
    watchDirectory: () => handle
  })

  watcher.start('C:/codex')
  let stopped = false
  const stopping = Promise.resolve(watcher.stop()).then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)

  handle.emit('close')
  await stopping
  assert.equal(stopped, true)
})

test('Codex config watcher watches the canonical directory path', async () => {
  let watchedDirectory = null
  const watcher = createCodexConfigWatcher({
    readSnapshot: () => ({
      codexHome: 'C:/Users/RUNNER~1/.codex',
      configPath: 'C:/Users/RUNNER~1/.codex/config.toml',
      currentProvider: 'openai',
      availableProviders: ['openai'],
      providerCatalog: [{ id: 'openai', displayName: 'OpenAI' }],
      mtimeMs: 1
    }),
    resolveWatchDirectory: () => 'C:/Users/runneradmin/.codex',
    watchDirectory: (directory) => {
      watchedDirectory = directory
      return { close() {} }
    }
  })

  watcher.start('C:/Users/RUNNER~1/.codex')
  assert.equal(watchedDirectory, 'C:/Users/runneradmin/.codex')
  await watcher.stop()
})
