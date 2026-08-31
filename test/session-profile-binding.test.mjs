import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { reconcileActiveProfile } from '../electron/aiCliProfiles/profileResolver.js'
import { openDb } from '../electron/persistence/db.js'
import {
  isReadyServiceProfileForAdapter,
  sessionProfileDraftFor
} from '../src/sessionConfigPresentation.js'

test('session profile binding survives database restart and native binding repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-profile-'))
  const path = join(root, 'ucli.db')
  let db = await openDb(path)
  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'codex',
      native_session_id: 'native-old',
      profile_id: 'profile-1',
      adapter_config_json: JSON.stringify({
        profileName: 'tui',
        surfacePreference: 'tui'
      }),
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    assert.equal(db.flush(), true)
    db.close()

    db = await openDb(path)
    assert.equal(db.getSession('session-1').profileId, 'profile-1')
    assert.deepEqual(db.getSession('session-1').adapterConfig, {
      profileName: 'tui',
      surfacePreference: 'tui'
    })
    db.updateSession('session-1', { native_session_id: 'native-current' })
    assert.equal(db.getSession('session-1').cliSessionId, 'native-current')
    assert.equal(db.getSession('session-1').profileId, 'profile-1')
    db.updateSession('session-1', { adapter_config_json: '{broken' })
    assert.deepEqual(db.getSession('session-1').adapterConfig, {})
    assert.equal(db.getSession('session-1').profileId, 'profile-1')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude system model survives profile model persistence and database restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-system-model-'))
  const path = join(root, 'ucli.db')
  let db = await openDb(path)
  try {
    db.insertSession({
      id: 'claude-session',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'claude',
      native_session_id: 'native-session',
      model: 'profile-sonnet',
      system_model: 'history-haiku',
      profile_id: 'profile-1',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    assert.equal(db.flush(), true)
    db.close()

    db = await openDb(path)
    assert.equal(db.getSession('claude-session').model, 'profile-sonnet')
    assert.equal(db.getSession('claude-session').systemModel, 'history-haiku')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('active profile switching changes only desired and pending state until restart', () => {
  const adapter = { id: 'existing-adapter' }
  const active = reconcileActiveProfile({
    session: {
      profileId: 'profile-a',
      activeProfileId: 'profile-a',
      profileRuntimeRevision: 'hash-a'
    },
    resolved: {
      profileId: 'profile-b',
      status: 'ready',
      canStart: true,
      runtimeRevision: 'hash-b'
    },
    isActive: true
  })

  assert.equal(active.profileId, 'profile-b')
  assert.equal(active.activeProfileId, 'profile-a')
  assert.equal(active.pendingProfileId, 'profile-b')
  assert.equal(active.restartRequired, true)
  assert.deepEqual(adapter, { id: 'existing-adapter' })

  const restarted = reconcileActiveProfile({
    session: active,
    resolved: {
      profileId: 'profile-b',
      status: 'ready',
      canStart: true,
      runtimeRevision: 'hash-b'
    },
    isActive: false
  })
  assert.equal(restarted.profileId, 'profile-b')
  assert.equal(restarted.activeProfileId, null)
  assert.equal(restarted.pendingProfileId, null)
  assert.equal(restarted.restartRequired, false)
})

test('renderer merges only allowlisted profile runtime fields', async () => {
  globalThis.window = { ucli: {} }
  const { useSessionsStore } = await import('../src/stores/sessions.js?session-profile-binding')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.sessions.push({
    id: 'session-1',
    adapterId: 'claude',
    model: 'sonnet',
    stats: { tokens: { input: 0, output: 0 } }
  })

  store._onEvent({
    sessionId: 'session-1',
    type: 'profile-runtime',
    profileId: 'profile-b',
    activeProfileId: 'profile-a',
    pendingProfileId: 'profile-b',
    profileStatus: 'ready',
    restartRequired: true,
    canStart: true,
    profileEnvironment: { UCLI_CODEX_PROFILE_SECRET: 'must-not-leak' },
    secret: 'must-not-leak'
  })

  const row = store.byId('session-1')
  assert.equal(row.profileId, 'profile-b')
  assert.equal(row.activeProfileId, 'profile-a')
  assert.equal(row.pendingProfileId, 'profile-b')
  assert.equal(row.profileStatus, 'ready')
  assert.equal(row.restartRequired, true)
  assert.equal('profileEnvironment' in row, false)
  assert.equal('secret' in row, false)
  assert.equal(JSON.stringify(row).includes('must-not-leak'), false)

  store._onEvent({
    sessionId: 'session-1',
    type: 'profile-model',
    actualModel: 'claude-sonnet-5-20260801',
    profileWarning: 'model_substituted',
    requestedModel: 'must-not-enter-renderer',
    profileLaunch: { env: { ANTHROPIC_API_KEY: 'must-not-leak' } }
  })
  assert.equal(row.actualModel, 'claude-sonnet-5-20260801')
  assert.equal(row.profileWarning, 'model_substituted')
  assert.equal('requestedModel' in row, false)
  assert.equal('profileLaunch' in row, false)

  store._onEvent({
    sessionId: 'session-1',
    type: 'stats_update',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'claude-sonnet-5-20260801',
    actualModel: 'claude-sonnet-5-20260801',
    profileWarning: 'model_substituted'
  })
  assert.equal(row.model, 'sonnet')
  assert.equal(row.actualModel, 'claude-sonnet-5-20260801')
})

test('renderer preserves only the server profile provenance marker', async () => {
  const bridge = globalThis.window?.ucli || {}
  globalThis.window = { ucli: bridge }
  const { useSessionsStore } = await import('../src/stores/sessions.js?strict-profile-source-kind')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store._upsertSummary({
    id: 'session-1', adapterId: 'codex', cwd: 'F:\\projects\\demo', model: 'local-model',
    tier: 'safety-rules', status: 'offline', stats: {}, profileSourceKind: 'user'
  })
  const row = store.byId('session-1')
  assert.equal(row.profileSourceKind, null)

  store._onEvent({
    sessionId: row.id, type: 'profile-runtime', profileSourceKind: 'local'
  })
  assert.equal(row.profileSourceKind, null)

  store._onEvent({
    sessionId: row.id, type: 'profile-runtime', profileSourceKind: 'server'
  })
  assert.equal(row.profileSourceKind, 'server')
})

test('renderer keeps a Codex service profile requested model when live stats report another model', async () => {
  const bridge = globalThis.window?.ucli || {}
  globalThis.window = { ucli: bridge }
  const { useSessionsStore } = await import('../src/stores/sessions.js?server-model-stats')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.sessions.push({
    id: 'server-codex', adapterId: 'codex', model: 'deepseek-v4-flash',
    profileId: 'http://server.test::org-1', profileSourceKind: 'server',
    capabilities: { statsOwner: 'ucli' },
    stats: { tokens: { input: 0, output: 0 }, turns: 0 }
  })

  store._onEvent({
    sessionId: 'server-codex', type: 'stats_update',
    usage: { inputTokens: 10, outputTokens: 5 }, turns: 1,
    model: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol',
    profileWarning: 'model_substituted', ts: 1
  })

  const row = store.byId('server-codex')
  assert.equal(row.model, 'deepseek-v4-flash')
  assert.equal(row.actualModel, 'gpt-5.6-sol')
  assert.equal(row.profileWarning, 'model_substituted')
})

test('renderer uses the adapter display name for an unnamed persisted native session', async () => {
  const bridge = globalThis.window?.ucli || {}
  globalThis.window = { ucli: bridge }
  const { useSessionsStore } = await import('../src/stores/sessions.js?adapter-display-name')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.adapters = [{ id: 'codex', displayName: 'Codex', icon: 'C' }]

  store._upsertSummary({
    id: 'unnamed-codex', adapterId: 'codex', cwd: 'F:\\projects\\demo',
    cliSessionId: '019fcac6-0c62-7da1-92ff-454e53dab197', name: null,
    model: 'deepseek-v4-flash', tier: 'safety-rules', status: 'offline',
    startedAt: Date.UTC(2026, 7, 31, 14, 2),
    stats: { tokens: { input: 0, output: 0 }, turns: 0 }
  })

  assert.match(store.byId('unnamed-codex').displayName, /^Codex · /)
})

test('session storage persists only the allowlisted server profile source marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-profile-source-'))
  const path = join(root, 'ucli.db')
  let db = await openDb(path)
  try {
    db.insertSession({
      id: 'server-session', project_path: 'F:\\projects\\demo', adapter_id: 'codex',
      profile_id: 'http://server.test::org-1', profile_source_kind: 'server', model: 'responses-b',
      tier: 'safety-rules', status: 'offline', created_at: 1
    })
    db.insertSession({
      id: 'local-session', project_path: 'F:\\projects\\demo', adapter_id: 'codex',
      profile_id: 'local-profile', profile_source_kind: 'local', model: 'local-model',
      tier: 'safety-rules', status: 'offline', created_at: 2
    })
    assert.equal(db.getSession('server-session').profileSourceKind, 'server')
    assert.equal(db.getSession('local-session').profileSourceKind, null)
    assert.equal(db.flush(), true)
    db.close()

    db = await openDb(path)
    assert.equal(db.getSession('server-session').profileSourceKind, 'server')
    db.updateSession('server-session', { profile_source_kind: 'local' })
    assert.equal(db.getSession('server-session').profileSourceKind, null)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('renderer summary waits for an inherited service binding model instead of choosing the first adapter model', async () => {
  const bridge = globalThis.window?.ucli || {}
  bridge.createSession = async () => ({ sessionId: 'inherited-service-session' })
  globalThis.window = { ucli: bridge }
  const { useSessionsStore } = await import('../src/stores/sessions.js?inherited-service-selection')
  setActivePinia(createPinia())
  const store = useSessionsStore()
  store.adapters = [{ id: 'codex', displayName: 'Codex', icon: 'C', models: ['wrong-first'] }]

  await store.createSession({ adapterId: 'codex', cwd: 'F:\\projects\\demo' })
  const row = store.byId('inherited-service-session')
  assert.equal(row.model, null)

  store._upsertSummary({
    id: row.id, adapterId: 'codex', cwd: row.cwd, model: 'responses-selected',
    tier: 'safety-rules', status: 'starting', stats: row.stats,
    profileId: 'http://server.test::org-1', profileSourceKind: 'server'
  })
  assert.equal(row.model, 'responses-selected')

  store._onEvent({
    sessionId: row.id,
    type: 'profile-runtime',
    profileId: 'http://server.test::org-1',
    profileSourceKind: 'server',
    model: 'responses-runtime',
    canStart: true
  })
  assert.equal(row.model, 'responses-runtime')
})

test('only ready service profiles with a ready compatible model are selectable', () => {
  const profile = {
    source: 'server', availabilityStatus: 'ready',
    models: [{ id: 'responses', protocols: ['openai_responses'], availabilityStatus: 'ready' }]
  }
  assert.equal(isReadyServiceProfileForAdapter(profile, 'codex'), true)
  assert.equal(isReadyServiceProfileForAdapter({ ...profile, availabilityStatus: 'unreachable' }, 'codex'), false)
  assert.equal(isReadyServiceProfileForAdapter({
    ...profile,
    models: [{ id: 'removed', protocols: ['openai_responses'], availabilityStatus: 'removed' }]
  }, 'codex'), false)
})

test('cancelling a profile restart restores the persisted tuple draft', () => {
  assert.deepEqual(sessionProfileDraftFor({ profileId: 'service-profile', model: 'responses-b' }), {
    profileId: 'service-profile', model: 'responses-b'
  })
  assert.deepEqual(sessionProfileDraftFor({ profileId: null, model: 'system-model' }), {
    profileId: 'system', model: null
  })
})
