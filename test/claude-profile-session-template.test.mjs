import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workbench = readFileSync(new URL('../src/views/Workbench.vue', import.meta.url), 'utf8')
const sessionDetail = readFileSync(new URL('../src/views/SessionDetail.vue', import.meta.url), 'utf8')
const sessionConfig = readFileSync(new URL('../src/components/SessionConfigModal.vue', import.meta.url), 'utf8')

test('new and imported Claude sessions use the shared profile selector', () => {
  assert.match(workbench, /profileCapableAdapter/)
  assert.match(workbench, /\['codex', 'claude'\]/)
  assert.match(workbench, /profilesForAdapter/)
  assert.match(workbench, /保持历史连接/)
  assert.match(workbench, /profileConfigForSelection\(true/)
})

test('Claude sessions switch profiles in the shared modal and panes show actual model', () => {
  assert.match(sessionConfig, /view\.profileCapable/)
  assert.match(sessionConfig, /profilesForSession/)
  assert.match(sessionConfig, /setSessionProfile/)
  assert.match(sessionDetail, /actualModel/)
  assert.match(sessionConfig, /立即重启/)
  assert.match(sessionConfig, /下次重启生效/)
})

test('Claude launch is conditionally recompiled immediately before start to avoid stale profiles', () => {
  assert.match(sessionConfig, /setSessionProfile/)
  const orchestrator = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  const adapter = readFileSync(new URL('../electron/adapters/claudeAdapter.js', import.meta.url), 'utf8')
  const coordinator = readFileSync(new URL('../electron/aiCliProfiles/claudeLaunchCoordinator.js', import.meta.url), 'utf8')
  assert.match(orchestrator, /armClaudeSessionLaunch\(e\)/)
  assert.match(orchestrator, /getClaudeProfileLaunchStamp/)
  assert.match(coordinator, /prepareRuntime\(\)/)
  assert.match(coordinator, /entry\.adapter\.setProfileLaunch\(prepared\.profileLaunch\)/)
  assert.match(coordinator, /entry\.status = 'launching'/)
  assert.match(adapter, /setProfileLaunch\(profileLaunch\)/)
})
