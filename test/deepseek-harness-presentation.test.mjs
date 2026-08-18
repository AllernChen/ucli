import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, compileTemplate, parse as parseSfc } from '@vue/compiler-sfc'
import { createPinia, setActivePinia } from 'pinia'
import {
  activatePaneSession,
  createPaneAssignmentGuard
} from '../src/workbenchLayout.js'

function loadSfc(relativePath) {
  const url = new URL(relativePath, import.meta.url)
  const source = readFileSync(url, 'utf8')
  const { descriptor, errors } = parseSfc(source, { filename: url.pathname })
  assert.deepEqual(errors, [])
  if (descriptor.scriptSetup) compileScript(descriptor, { id: relativePath })
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: url.pathname,
    id: relativePath
  })
  assert.deepEqual(compiled.errors, [])
  return source
}

test('Settings summarizes pinned DSH runtime state and routes profile management to Profile Center', () => {
  const source = loadSfc('../src/views/Settings.vue')

  assert.match(source, /class="dsh-profile-management"/)
  assert.match(source, /0\.1\.0-rc\.6/)
  assert.match(source, /ipc\.getDshState\(\)/)
  assert.match(source, /router\.push\([^\n]*profiles[^\n]*deepseek-harness/)
  assert.doesNotMatch(source, /ipc\.enableDshBridge\(/)
  assert.match(source, /dshRuntimeView\.rows/)
  assert.match(source, /前往档案管理/)
  assert.match(source, /Web/)
})

test('Profile Center manages bounded DSH runtime actions, profiles and legacy bridge removal', () => {
  const source = loadSfc('../src/views/ProfileCenter.vue')

  assert.match(source, /deepseek-harness/)
  assert.match(source, /createDshManagementController/)
  assert.match(source, /ipc\.getDshState\(\)/)
  assert.match(source, /ipc\.listDshProfiles\(\)/)
  assert.match(source, /ipc\.initializeDshProfile\(newDshProfileName\.value\)/)
  assert.match(source, /ipc\.removeDshLegacyBridge\(profile\.profileName\)/)
  assert.match(source, /ipc\.installDshRuntime\(\)/)
  assert.match(source, /ipc\.upgradeDshRuntime\(\)/)
  assert.match(source, /ipc\.repairDshRuntime\(\)/)
  assert.match(source, /ipc\.removeDshRuntime\(\)/)
  assert.match(source, /Modal\.confirm\(/)
  assert.match(source, /dshRuntimeView\.rows/)
  assert.match(source, /受支持版本/)
  assert.match(source, /初始化基础 profile/)
  assert.match(source, /移除旧 bridge/)
  assert.doesNotMatch(source, /ipc\.enableDshBridge\(|启用 UCLI bridge|更新 UCLI bridge/)
  assert.doesNotMatch(source, /TUI|终端模式|turtle-ui|启用 UCLI 集成/)
})

test('Workbench creates only DSH Web from a selected managed or system runtime', () => {
  const source = loadSfc('../src/views/Workbench.vue')

  assert.match(source, /ipc\.getDshState\(\)/)
  assert.match(source, /\['managed', 'system'\]\.includes\(fresh\?\.selected\)/)
  assert.match(source, />新建 DSH Web<\/a-button>/u)
  assert.match(source, /adapterConfig\s*=\s*\{\s*surfacePreference:\s*'web'\s*\}/)
  assert.doesNotMatch(source, /dshSurfacePreference|selectedDshProfile|ipc\.listDshProfiles\(\)/)
  assert.doesNotMatch(source, /surfacePreference:\s*'tui'|profileReady|bridgeCompatible/)
  assert.doesNotMatch(source, /adapterConfig\s*=\s*\{[^}]*profileName/)
  assert.doesNotMatch(source, /TUI|终端模式|turtle-ui|启用 UCLI 集成/)
  assert.match(source, /前往档案管理/)
})

test('renderer sessions fail closed for missing DSH capabilities and ignore native Web stats events', async () => {
  globalThis.window = { ucli: {} }
  const { useSessionsStore } = await import('../src/stores/sessions.js?dsh-capability-presentation')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.adapters = [{
    id: 'deepseek-harness',
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: true
    }
  }]

  store._upsertSummary({
    id: 'unknown-dsh', adapterId: 'deepseek-harness', cwd: 'C:/project', status: 'offline',
    stats: { tokens: { input: 0, output: 0 }, turns: 0, costUsd: 0 }
  })
  assert.deepEqual(store.byId('unknown-dsh').capabilities, {
    surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
    statsOwner: 'native', gateway: false, bridge: false
  })
  store._upsertSummary({
    id: 'mixed-dsh', adapterId: 'deepseek-harness', cwd: 'C:/project', status: 'offline',
    stats: { tokens: { input: 0, output: 0 }, turns: 0, costUsd: 0 },
    capabilities: {
      surface: 'web', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'ucli', gateway: true, bridge: true
    }
  })
  assert.deepEqual(store.byId('mixed-dsh').capabilities, {
    surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
    statsOwner: 'native', gateway: false, bridge: false
  })

  const web = {
    id: 'web-dsh', adapterId: 'deepseek-harness', cwd: 'C:/project', status: 'running',
    stats: { tokens: { input: 0, output: 0 }, turns: 0, costUsd: 0 },
    capabilities: {
      surface: 'web', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    }
  }
  store._upsertSummary(web)
  store._onEvent({
    sessionId: web.id, type: 'stats_update',
    usage: { inputTokens: 99, outputTokens: 42 }, turns: 3, costUsd: 1, ts: 1
  })
  assert.deepEqual(store.byId(web.id).stats, web.stats)

  store._onApprovalRequest({ sessionId: web.id, requestId: 'late-native-request' })
  assert.equal(store.pendingApprovals[web.id]?.length || 0, 0)
  assert.equal(store.byId(web.id).status, 'running')
})

test('session cards hide UCLI-owned permission and usage controls for native Web', () => {
  const source = loadSfc('../src/components/SessionCard.vue')

  assert.match(source, /deriveSessionCapabilityState/)
  assert.match(source, /v-if="capabilities\.ucliPermission"/)
  assert.match(source, /v-if="capabilities\.ucliPermission && isWaiting"/)
  assert.match(source, /v-if="capabilities\.ucliStats" class="card-footer"/)
  assert.match(source, /DSH 原生管理权限、历史与统计/)
})

test('native Web pane activation starts and restarts without attaching a terminal', async () => {
  const calls = []
  const operations = {
    restartSession: async id => calls.push(`restart:${id}`),
    startSession: async id => calls.push(`start:${id}`),
    attachSession: async id => calls.push(`attach:${id}`)
  }
  const webCapabilities = {
    surface: 'web', permissionOwner: 'native', historyOwner: 'native',
    statsOwner: 'native', gateway: false, bridge: false
  }

  await activatePaneSession({ id: 'web-running', status: 'running', capabilities: webCapabilities }, 0, operations)
  await activatePaneSession({ id: 'web-starting', status: 'starting', capabilities: webCapabilities }, 1, operations)
  await activatePaneSession({ id: 'web-offline', status: 'offline', capabilities: webCapabilities }, 2, operations)
  await activatePaneSession({
    id: 'terminal', status: 'running',
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: false
    }
  }, 3, operations)

  assert.deepEqual(calls, ['start:web-starting', 'restart:web-offline', 'attach:terminal'])
})

test('pane activation fails closed before any lifecycle call when capabilities are unknown', async () => {
  const calls = []
  const operations = {
    restartSession: async id => calls.push(`restart:${id}`),
    startSession: async id => calls.push(`start:${id}`),
    attachSession: async id => calls.push(`attach:${id}`)
  }

  assert.equal(await activatePaneSession({ id: 'unknown-starting', status: 'starting' }, 0, operations), false)
  assert.equal(await activatePaneSession({ id: 'unknown-offline', status: 'offline', capabilities: null }, 1, operations), false)
  assert.deepEqual(calls, [])
})

test('session detail mounts exactly one capability-owned surface and no Web terminal controls', () => {
  const source = loadSfc('../src/views/SessionDetail.vue')

  assert.match(source, /import HostedWebSurface/)
  assert.match(source, /<HostedWebSurface[\s\S]*:state="paneSession\(i\)\?\.surfaceState \|\|/)
  assert.match(source, /v-if="paneCapabilityState\(i\)\.terminal"[\s\S]*class="pane-terminal"/)
  assert.match(source, /v-if="paneCapabilityState\(i\)\.web"/)
  assert.match(source, /v-if="paneCapabilityState\(i\)\.ucliHistory"[\s\S]*togglePaneHistory/)
  assert.match(source, /v-if="paneCapabilityState\(i\)\.ucliStats" class="pane-info"/)
  assert.match(source, /activatePaneSession/)
  assert.match(source, /if \(!capabilities\.terminal\)\s*{[\s\S]*destroyPaneTerminal/)
  assert.match(source, /releaseChangedPaneTerminalBinding\(oldSid, sessionId,[\s\S]*unsubscribePane/)
  assert.match(source, /panes\.value\[i\]\?\.sessionId === sessionId && evt\.sessionId === sessionId/)
})

test('rapid pane reassignment invalidates every callback owned by the old session', () => {
  const guard = createPaneAssignmentGuard()
  const panes = [{ sessionId: 'A' }]
  const a = guard.begin(0, 'A')
  panes[0].sessionId = 'B'
  const b = guard.begin(0, 'B')

  assert.equal(guard.isCurrent(a, panes), false)
  assert.equal(guard.isCurrent(b, panes), true)
  guard.invalidate(0)
  assert.equal(guard.isCurrent(b, panes), false)
})

test('session configuration hides UCLI permission and Gateway controls from native Web', () => {
  const source = loadSfc('../src/components/SessionConfigModal.vue')

  assert.match(source, /deriveSessionCapabilityState/)
  assert.match(source, /v-if="capabilities\.ucliHistory" label="CLI /)
  assert.match(source, /v-if="capabilities\.ucliPermission" label="权限模式"/)
  assert.match(source, /v-if="capabilities\.gateway" class="control-row"/)
  assert.match(source, /v-if="capabilities\.web"[\s\S]*权限、历史与审批由 DSH 原生界面管理；token 统计由 UCLI 拉取展示/)
})

test('usage trends identify DeepSeek Harness without a native-stats exclusion note', () => {
  const source = loadSfc('../src/components/stats/UsageTrendsPanel.vue')

  assert.match(source, /'deepseek-harness': 'DeepSeek Harness'/)
  assert.doesNotMatch(source, /DSH Web 使用原生统计|不计入 UCLI 使用趋势/)
})
