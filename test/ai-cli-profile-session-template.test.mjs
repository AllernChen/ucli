import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/views/SessionDetail.vue', import.meta.url), 'utf8')

test('each Codex pane shows its profile and hides legacy provider controls for managed selection', () => {
  assert.match(source, /profileNameForSession/)
  assert.match(source, /由档案管理/)
  assert.match(source, /!sessions\.byId\(pane\.sessionId\)\?\.profileId/)
  assert.match(source, /setSessionProfile/)
  assert.match(source, /isProfileSession/)
  assert.match(source, /profilesForSession/)
  assert.match(source, /profile\.canStart/)
})

test('running profile switches require an explicit restart decision and cancellation is inert', () => {
  for (const label of ['下次重启生效', '立即重启', '取消']) assert.match(source, new RegExp(label))
  assert.match(source, /cancelProfileSwitch/)
  assert.match(source, /applyProfileSwitch\(false\)/)
  assert.match(source, /applyProfileSwitch\(true\)/)
  assert.match(source, /sessions\.setProfile/)
})
