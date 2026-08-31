import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/SessionConfigModal.vue', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
const rendererIpc = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
const sessionStore = readFileSync(new URL('../src/stores/sessions.js', import.meta.url), 'utf8')
const orchestrator = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')

test('the session configuration modal owns Codex profile and Provider selection', () => {
  assert.match(source, /view\.profileCapable/)
  assert.match(source, /view\.providerEditable/)
  assert.match(source, /view\.explicitProviderVisible/)
  assert.match(source, /setSessionProfile/)
  assert.match(source, /profilesForSession/)
  assert.match(source, /profile\.canStart/)
  assert.match(source, /setCodexProviderPolicy/)
  assert.match(source, /setCodexExplicitProvider/)
})

test('running profile switches require an explicit restart decision and cancellation is inert', () => {
  for (const label of ['下次重启生效', '立即重启', '取消']) assert.match(source, new RegExp(label))
  assert.match(source, /cancelProfileSwitch/)
  assert.match(source, /applyProfileSwitch\(false\)/)
  assert.match(source, /applyProfileSwitch\(true\)/)
  assert.match(source, /sessions\.setProfile/)
})

test('unavailable server profiles are disabled without rewriting their explicit ids to system auth', () => {
  const source = readFileSync(new URL('../src/components/NewSessionDialog.vue', import.meta.url), 'utf8')
  assert.match(source, /profile\.sourceKind === 'server'/)
  assert.match(source, /profile\.canStart/)
  assert.match(source, /return profile\?\.adapterId === adapterId \? \{ profileId \} : \{\}/)
})

test('session profile mutation carries an exact profile/model selection through the bridge and persists it together', () => {
  assert.match(preload, /setSessionProfile: \(sessionId, selection\) =>\s*ipcRenderer\.invoke\('session:set-profile', sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(rendererIpc, /setSessionProfile: \(sessionId, selection\) => u\.setSessionProfile\(sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(sessionStore, /async setProfile\(id, selection\) \{\s*const result = await ipc\.setSessionProfile\(id, selection\)/)
  assert.match(orchestrator, /function setSessionProfile\(sessionId, selection\)/)
  assert.match(orchestrator, /db\.updateSession\(sessionId, \{\s*profile_id: desiredProfileId,\s*model: entry\.session\.model,/)
})

test('the session profile selection rejects scalar calls and never guesses a service model in the renderer store', () => {
  assert.match(preload, /function validateSessionProfileSelection\(selection\)/)
  assert.match(rendererIpc, /function validateSessionProfileSelection\(selection\)/)
  assert.match(orchestrator, /function validateSessionProfileSelection\(selection\)/)
  assert.doesNotMatch(sessionStore, /config\.model \|\| adapter\?\.models\?\.\[0\]/)
})
