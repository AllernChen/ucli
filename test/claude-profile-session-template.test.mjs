import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workbench = readFileSync(new URL('../src/views/Workbench.vue', import.meta.url), 'utf8')
const sessionDetail = readFileSync(new URL('../src/views/SessionDetail.vue', import.meta.url), 'utf8')

test('new and imported Claude sessions use the shared profile selector', () => {
  assert.match(workbench, /profileCapableAdapter/)
  assert.match(workbench, /\['codex', 'claude'\]/)
  assert.match(workbench, /profilesForAdapter/)
  assert.match(workbench, /保持历史连接/)
  assert.match(workbench, /profileConfigForSelection\(true/)
})

test('Claude panes switch profiles with the shared restart decision and show actual model', () => {
  assert.match(sessionDetail, /isProfileSession/)
  assert.match(sessionDetail, /profilesForSession/)
  assert.match(sessionDetail, /setSessionProfile/)
  assert.match(sessionDetail, /actualModel/)
  assert.match(sessionDetail, /立即重启/)
  assert.match(sessionDetail, /下次重启生效/)
})

test('Claude launch is recompiled immediately before start to avoid stale starting profiles', () => {
  assert.match(sessionDetail, /setSessionProfile/)
  const orchestrator = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  const adapter = readFileSync(new URL('../electron/adapters/claudeAdapter.js', import.meta.url), 'utf8')
  assert.match(orchestrator, /prepareClaudeSessionRuntime\(e\.session/)
  assert.match(orchestrator, /e\.adapter\.setProfileLaunch/)
  assert.match(orchestrator, /adapter\.setProfileLaunch\(prepared\.profileLaunch\)/)
  assert.match(orchestrator, /entry\.status = 'launching'/)
  assert.match(orchestrator, /status = 'launching'/)
  assert.match(adapter, /setProfileLaunch\(profileLaunch\)/)
})
