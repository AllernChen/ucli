import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  }), {
    surfacePreference: 'web'
  })
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
  assert.equal(descriptor.capabilitiesForConfig({ surfacePreference: 'legacy-tui' }).surface, 'unavailable')
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
    const orchestratorModule = await import(`../electron/orchestrator.js?dsh-web-only-restore=${Date.now()}`)
    orchestrator = orchestratorModule.createOrchestrator()
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
