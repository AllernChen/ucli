import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { codexDescriptor } from '../electron/adapters/codexAdapter.js'
import { getDb, openDb } from '../electron/persistence/db.js'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const source = readFileSync(new URL('../src/components/SessionConfigModal.vue', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
const rendererIpc = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
const sessionStore = readFileSync(new URL('../src/stores/sessions.js', import.meta.url), 'utf8')
const orchestrator = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')

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

test('session profile mutation carries an exact profile/model selection through the bridge and persists it together', () => {
  assert.match(preload, /setSessionProfile: \(sessionId, selection\) =>\s*ipcRenderer\.invoke\('session:set-profile', sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(rendererIpc, /setSessionProfile: \(sessionId, selection\) => u\.setSessionProfile\(sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(sessionStore, /async setProfile\(id, selection\) \{\s*const result = await ipc\.setSessionProfile\(id, selection\)/)
  assert.match(orchestrator, /function setSessionProfile\(sessionId, selection\)/)
  assert.match(orchestrator, /db\.updateSession\(sessionId, \{\s*profile_id: desiredProfileId,\s*model: nextSession\.model,/)
})

test('the session profile selection rejects scalar calls and never guesses a service model in the renderer store', () => {
  assert.match(preload, /function validateSessionProfileSelection\(selection\)/)
  assert.match(rendererIpc, /function validateSessionProfileSelection\(selection\)/)
  assert.match(orchestrator, /function validateSessionProfileSelection\(selection\)/)
  assert.doesNotMatch(sessionStore, /config\.model \|\| adapter\?\.models\?\.\[0\]/)
})

async function withPersistedSession(t, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-profile-'))
  const userData = join(root, 'user-data')
  mkdirSync(userData, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = userData
  const seed = await openDb(join(userData, 'ucli.db'))
  seed.insertSession({
    id: 'session-1', project_path: 'F:\\projects\\demo', adapter_id: 'claude',
    tier: 'safety-rules', model: 'system-model', status: 'offline', created_at: 1
  })
  seed.flush()
  seed.close()

  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const module = await import(`../electron/orchestrator.js?session-profile=${Date.now()}`)
  const orchestrator = module.createOrchestrator()
  const events = []
  orchestrator.setMainWindow({
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => events.push({ channel, payload }) }
  })
  await orchestrator.initPersistence()
  orchestrator.registerIpc()
  try {
    await callback({ handlers, events, db: getDb() })
  } finally {
    await orchestrator.shutdown()
    getDb()?.close()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
}

test('a failed tuple persistence leaves the live session and emitted state unchanged', async t => {
  await withPersistedSession(t, async ({ handlers, events, db }) => {
    const profile = await handlers.get('ai-cli-profiles:create')({}, {
      adapterId: 'claude', name: 'Local Claude', connectionMode: 'subscription', model: 'local-model'
    })
    const before = (await handlers.get('session:list')({}))[0]
    const originalUpdate = db.updateSession
    db.updateSession = () => { throw new Error('disk failure') }
    try {
      assert.throws(() => handlers.get('session:set-profile')({}, 'session-1', {
        profileId: profile.id, model: null
      }), /disk failure/)
    } finally {
      db.updateSession = originalUpdate
    }
    assert.deepEqual((await handlers.get('session:list')({}))[0], before)
    assert.equal(db.getSession('session-1').profileId, null)
    assert.equal(db.getSession('session-1').model, 'system-model')
    assert.deepEqual(events.filter(({ channel }) => channel === 'session:event'), [])
  })
})

test('a system profile selection rejects a model before session or database mutation', async t => {
  await withPersistedSession(t, async ({ handlers, events, db }) => {
    const before = (await handlers.get('session:list')({}))[0]
    let writes = 0
    const originalUpdate = db.updateSession
    db.updateSession = (...args) => { writes += 1; return originalUpdate.apply(db, args) }
    try {
      assert.throws(() => handlers.get('session:set-profile')({}, 'session-1', {
        profileId: null, model: 'must-not-be-ignored'
      }), /Invalid session profile selection/)
    } finally {
      db.updateSession = originalUpdate
    }
    assert.equal(writes, 0)
    assert.deepEqual((await handlers.get('session:list')({}))[0], before)
    assert.deepEqual(events.filter(({ channel }) => channel === 'session:event'), [])
  })
})

test('a successful Codex system transition clears a reported model alias', async t => {
  await withPersistedSession(t, async ({ handlers }) => {
    const originalCreate = codexDescriptor.create
    let adapter
    codexDescriptor.create = () => {
      adapter = new EventEmitter()
      adapter.dispose = async () => {}
      return adapter
    }
    try {
      const created = handlers.get('session:create')({}, {
        adapterId: 'codex', cwd: 'F:\\projects\\demo', tier: 'safety-rules'
      })
      adapter.emit('event', { type: 'profile-model', actualModel: 'reported-alias' })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal((await handlers.get('session:list')({})).find(({ id }) => id === created.sessionId).actualModel, 'reported-alias')
      handlers.get('session:set-profile')({}, created.sessionId, { profileId: null, model: null })
      const session = (await handlers.get('session:list')({})).find(({ id }) => id === created.sessionId)
      assert.equal(session.actualModel, null)
      assert.equal(session.profileWarning, null)
    } finally {
      codexDescriptor.create = originalCreate
    }
  })
})
