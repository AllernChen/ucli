import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { reconcileActiveProfile } from '../electron/aiCliProfiles/profileResolver.js'
import { openDb } from '../electron/persistence/db.js'

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
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    assert.equal(db.flush(), true)
    db.close()

    db = await openDb(path)
    assert.equal(db.getSession('session-1').profileId, 'profile-1')
    db.updateSession('session-1', { native_session_id: 'native-current' })
    assert.equal(db.getSession('session-1').cliSessionId, 'native-current')
    assert.equal(db.getSession('session-1').profileId, 'profile-1')
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
