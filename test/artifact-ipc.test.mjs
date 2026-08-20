import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('preload exposes session artifact IPC methods', () => {
  const src = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  assert.match(src, /listArtifacts:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\('session:list-artifacts', sessionId\)/)
  assert.match(src, /readArtifact:\s*\(sessionId, absolutePath, options\)\s*=>/)
  assert.match(src, /ipcRenderer\.invoke\('session:read-artifact', sessionId, absolutePath, options\)/)
  assert.match(src, /openArtifactWindow:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\('artifact:open-window', sessionId\)/)
})

test('ipc wrapper forwards artifact methods to the bridge', () => {
  const src = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
  assert.match(src, /listArtifacts:\s*\(sessionId\)\s*=>\s*u\.listArtifacts\(sessionId\)/)
  assert.match(src, /readArtifact:\s*\(sessionId, absolutePath, options\)\s*=>\s*u\.readArtifact\(sessionId, absolutePath, options\)/)
  assert.match(src, /openArtifactWindow:\s*\(sessionId\)\s*=>\s*u\.openArtifactWindow\(sessionId\)/)
})

test('orchestrator wires the artifacts service and registers its IPC', () => {
  const src = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  assert.match(src, /createSessionArtifactsService/)
  assert.match(src, /registerSessionArtifactsIpc\(ipcMain, artifactsService\)/)
})
