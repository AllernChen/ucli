import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

test('preload exposes openPath invoking shell:open-path', () => {
  const src = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  assert.match(src, /openPath: \(path\) => ipcRenderer\.invoke\('shell:open-path', path\)/)
})

test('ipc wrapper exposes openPath', () => {
  const src = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
  assert.match(src, /openPath: \(path\) => u\.openPath\(path\)/)
})
