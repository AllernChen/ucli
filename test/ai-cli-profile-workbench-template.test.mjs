import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/NewSessionDialog.vue', import.meta.url), 'utf8')

test('new Codex sessions can choose project, app, system, or a concrete profile', () => {
  for (const label of ['按项目默认', '按应用默认', '跟随当前', '具体档案']) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /profileSelection/)
  assert.match(source, /config\.profileId/)
  assert.match(source, /profileCapableAdapter\(group\.id\)/)
})

test('Codex imports preserve history unless the user explicitly selects a profile', () => {
  assert.match(source, /保持历史连接/)
  assert.match(source, /profileConfigForSelection\(true, group\.id\)/)
  assert.match(source, /profileCapableAdapter\(adapter\.id\)/)
})
