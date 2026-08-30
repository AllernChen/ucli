import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/SessionConfigModal.vue', import.meta.url), 'utf8')

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
