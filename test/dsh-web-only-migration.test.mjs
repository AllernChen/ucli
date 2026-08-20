import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { listAdapterDescriptors } from '../electron/adapterRegistry.js'
import {
  normalizeDshCreateConfig,
  normalizePersistedDshConfig
} from '../electron/adapters/adapterSessionConfig.js'
import { getDb, openDb } from '../electron/persistence/db.js'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

test('new DSH sessions accept only the Web surface and discard profile data', () => {
  assert.deepEqual(normalizeDshCreateConfig({
    surfacePreference: 'web',
    profileName: 'TUI',
    token: 'must-not-leak'
  }), { surfacePreference: 'web' })
})

test('new DSH sessions reject the retired TUI surface with a stable code', () => {
  assert.throws(
    () => normalizeDshCreateConfig({ surfacePreference: 'tui', profileName: 'TUI' }),
    { code: 'DSH_SURFACE_UNSUPPORTED' }
  )
})

test('persisted TUI sessions migrate to a bounded legacy-unavailable config', () => {
  assert.deepEqual(normalizePersistedDshConfig({
    surfacePreference: 'tui',
    profileName: 'TUI',
    endpoint: '\\\\.\\pipe\\secret',
    token: 'must-not-leak'
  }), {
    surfacePreference: 'legacy-tui',
    profileName: 'TUI'
  })
})

test('the registered DSH descriptor separates Web creation from legacy restoration', () => {
  const descriptor = listAdapterDescriptors().find(({ id }) => id === 'deepseek-harness')
  assert.deepEqual(descriptor.normalizeSessionConfig({ surfacePreference: 'web' }), {
    surfacePreference: 'web'
  })
  assert.throws(
    () => descriptor.normalizeSessionConfig({ surfacePreference: 'tui', profileName: 'TUI' }),
    { code: 'DSH_SURFACE_UNSUPPORTED' }
  )
  assert.deepEqual(descriptor.normalizePersistedSessionConfig({
    surfacePreference: 'tui', profileName: 'TUI'
  }), {
    surfacePreference: 'legacy-tui', profileName: 'TUI'
  })
  assert.equal(descriptor.capabilities.surface, 'web')
  assert.equal(
    descriptor.capabilitiesForConfig({ surfacePreference: 'legacy-tui' }).surface,
    'unavailable'
  )
})

test('renderer restoration maps missing, malformed, and legacy DSH capabilities to unavailable', async () => {
  globalThis.window = { ucli: {} }
  const { useSessionsStore } = await import('../src/stores/sessions.js?dsh-web-only-migration')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.adapters = [
    listAdapterDescriptors().find(({ id }) => id === 'deepseek-harness'),
    {
      id: 'claude',
      capabilities: {
        surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
        statsOwner: 'ucli', gateway: true, bridge: false
      }
    }
  ]

  const base = {
    adapterId: 'deepseek-harness', cwd: 'C:/project', status: 'offline',
    adapterConfig: { surfacePreference: 'legacy-tui', profileName: 'TUI' },
    stats: { tokens: { input: 0, output: 0 }, turns: 0, costUsd: 0 }
  }
  store._upsertSummary({ ...base, id: 'missing-capabilities' })
  store._upsertSummary({
    ...base,
    id: 'malformed-capabilities',
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: true
    }
  })
  store._upsertSummary({
    ...base,
    id: 'legacy-capabilities',
    capabilities: {
      surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    }
  })

  for (const id of ['missing-capabilities', 'malformed-capabilities', 'legacy-capabilities']) {
    assert.deepEqual(store.byId(id).capabilities, {
      surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    })
  }
  store._upsertSummary({
    ...base,
    id: 'ordinary-cli',
    adapterId: 'claude',
    adapterConfig: {},
    capabilities: undefined
  })
  assert.deepEqual(store.byId('ordinary-cli').capabilities, {
    surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
    statsOwner: 'ucli', gateway: true, bridge: false
  })
})

test('restored non-Web DSH sessions are public unavailable rows and reject every server start path', async () => {
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const root = mkdtempSync(join(tmpdir(), 'ucli-dsh-web-only-restore-'))
  const userData = join(root, 'user-data')
  mkdirSync(userData, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = userData

  const seed = await openDb(join(userData, 'ucli.db'))
  for (const [id, adapterConfig] of [
    ['legacy-dsh', { surfacePreference: 'tui', profileName: 'TUI' }],
    ['malformed-dsh', { surfacePreference: 'headless' }],
    ['web-dsh', { surfacePreference: 'web' }]
  ]) {
    seed.insertSession({
      id,
      project_path: `F:\\projects\\${id}`,
      adapter_id: 'deepseek-harness',
      adapter_config_json: JSON.stringify(adapterConfig),
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
  }
  seed.flush()
  seed.close()

  let orchestrator
  try {
    const module = await import(`../electron/orchestrator.js?dsh-web-only-restore=${Date.now()}`)
    orchestrator = module.createOrchestrator()
    await orchestrator.initPersistence()
    orchestrator.registerIpc()

    const listed = new Map(handlers.get('session:list')().map(session => [session.id, session]))
    const unavailable = {
      surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    }
    assert.deepEqual(listed.get('legacy-dsh').adapterConfig, {
      surfacePreference: 'legacy-tui', profileName: 'TUI'
    })
    assert.deepEqual(listed.get('legacy-dsh').capabilities, unavailable)
    assert.equal(listed.get('legacy-dsh').canStart, false)
    assert.deepEqual(listed.get('malformed-dsh').capabilities, unavailable)
    assert.equal(listed.get('malformed-dsh').canStart, false)
    assert.equal(listed.get('web-dsh').capabilities.surface, 'web')
    assert.equal(listed.get('web-dsh').canStart, true)

    for (const id of ['legacy-dsh', 'malformed-dsh']) {
      await assert.rejects(
        handlers.get('session:start-adapter')({}, id),
        { code: 'DSH_TUI_UNAVAILABLE' }
      )
      await assert.rejects(
        handlers.get('session:restart')({}, id),
        { code: 'DSH_TUI_UNAVAILABLE' }
      )
    }
  } finally {
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

const newDialog = readFileSync(new URL('../src/components/NewSessionDialog.vue', import.meta.url), 'utf8')

test('new DSH sessions are Web-only without profile or TUI controls', () => {
  assert.match(newDialog, /config\.adapterConfig = \{ surfacePreference: 'web' \}/)
  assert.doesNotMatch(newDialog, /surfacePreference:\s*'tui'|value="tui"/)
  assert.doesNotMatch(newDialog, /selectedDshProfileName|dshTuiReady|TUI profile|UCLI bridge/iu)
})

test('generic quick-new and discover blocks exclude DeepSeek Harness', () => {
  // The dedicated Web-only entry is the single DSH create button; the generic
  // quick-new/discover blocks must not surface a second (legacy TUI-looking) one.
  assert.match(newDialog, /discoverableAdapters\s*=\s*computed/)
  assert.match(newDialog, /a\.id !== 'deepseek-harness'/)
  assert.doesNotMatch(newDialog, /v-for="a in sessions\.adapters"/)
  assert.match(newDialog, /v-for="a in discoverableAdapters"/)
  assert.match(newDialog, /for \(const a of discoverableAdapters\.value\)/)
  assert.match(newDialog, /@click="newSession\(dshAdapter\)"/)
})

test('legacy DSH sessions expose only a bounded same-cwd Web migration action', () => {
  const detail = readFileSync(
    new URL('../src/views/SessionDetail.vue', import.meta.url),
    'utf8'
  )
  const newDialog = readFileSync(
    new URL('../src/components/NewSessionDialog.vue', import.meta.url),
    'utf8'
  )

  assert.match(detail, /isLegacyDshSession\(paneSession\(i\)\)/)
  assert.match(detail, /boundedLegacyDshText/)
  assert.match(detail, /新建 DSH Web（同工作目录）/u)
  assert.match(detail, /createDshWeb:\s*'1'/)
  const actionStart = detail.indexOf('function openLegacyDshWeb')
  const actionEnd = detail.indexOf('\n}', actionStart)
  assert.ok(actionStart >= 0 && actionEnd > actionStart)
  const action = detail.slice(actionStart, actionEnd)
  assert.match(action, /router\.push/)
  assert.doesNotMatch(action, /sessions\.(?:restart|resume|createSession)|adapterConfig\s*=/)

  assert.match(newDialog, /useRoute\(\)/)
  assert.match(newDialog, /route\.query\.createDshWeb/)
  const migrationStart = newDialog.indexOf("if (route.query.createDshWeb === '1')")
  const migrationEnd = newDialog.indexOf('\n  }', migrationStart)
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart)
  const migration = newDialog.slice(migrationStart, migrationEnd)
  assert.match(migration, /form\.value\.adapterId\s*=\s*'deepseek-harness'/)
  assert.match(migration, /open\.value\s*=\s*true/)
  assert.doesNotMatch(migration, /newSession|createSession/)
  assert.match(newDialog, /@click="newSession\(dshAdapter\)"/)
  assert.match(newDialog, /config\.adapterConfig\s*=\s*\{\s*surfacePreference:\s*'web'\s*\}/)
})
