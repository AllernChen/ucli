import test from 'node:test'
import assert from 'node:assert/strict'

import { createCodexConfigWatcher } from '../electron/codexConfigWatcher.js'

test('Codex config watcher emits a sanitised snapshot only when provider identity changes', async () => {
  const snapshots = [
    { codexHome: 'C:/codex', configPath: 'C:/codex/config.toml', currentProvider: 'first', availableProviders: ['openai', 'first'], mtimeMs: 1 },
    { codexHome: 'C:/codex', configPath: 'C:/codex/config.toml', currentProvider: 'next', availableProviders: ['openai', 'next'], mtimeMs: 2 }
  ]
  let readCount = 0
  let callback = null
  let closed = false
  const changes = []
  const watcher = createCodexConfigWatcher({
    readSnapshot: () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    watchDirectory: (_directory, onChange) => {
      callback = onChange
      return { close: () => { closed = true } }
    },
    debounceMs: 0,
    onChange: (snapshot) => changes.push(snapshot)
  })

  assert.equal(watcher.start('C:/codex').currentProvider, 'first')
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
    mtimeMs: 2
  }])
  assert.equal(JSON.stringify(changes).includes('content'), false)

  watcher.stop()
  assert.equal(closed, true)
})
