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
  assert.match(source, /isServiceProfile/)
  assert.match(source, /canSelectProfile/)
  assert.match(source, /model: modelId/)
  assert.match(source, /validateServiceProfileSelection/)
  assert.doesNotMatch(source, /models\[0\]/)
})

test('session profile mutation carries an exact profile/model selection through the bridge and persists it together', () => {
  assert.match(preload, /setSessionProfile: \(sessionId, selection\) =>\s*ipcRenderer\.invoke\('session:set-profile', sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(rendererIpc, /setSessionProfile: \(sessionId, selection\) => u\.setSessionProfile\(sessionId, validateSessionProfileSelection\(selection\)\)/)
  assert.match(sessionStore, /async setProfile\(id, selection\) \{\s*const result = await ipc\.setSessionProfile\(id, selection\)/)
  assert.match(orchestrator, /function setSessionProfile\(sessionId, selection\)/)
  assert.match(orchestrator, /db\.updateSession\(sessionId, \{\s*profile_id: desiredProfileId,\s*profile_source_kind: normalizeProfileSourceKind\(nextSession\.profileSourceKind\),\s*model: nextSession\.model,/)
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

function serverResponse(body, { cacheControl = null } = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheControl === null ? {} : { 'Cache-Control': cacheControl })
    }
  })
}

async function waitUntil(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for orchestrator state')
}

async function settleAdapterEvent() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

function reportedCodexStats(model, turn = 1) {
  return {
    type: 'stats_update',
    usage: { inputTokens: turn, outputTokens: turn },
    costUsd: null,
    costAvailable: false,
    turns: turn,
    model
  }
}

async function withCodexServiceProfile(callback) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-service-profile-'))
  const userData = join(root, 'user-data')
  const codexHome = join(root, 'codex-home')
  mkdirSync(userData, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  const previousCodexHome = process.env.CODEX_HOME
  const previousFetch = globalThis.fetch
  process.env.UCLI_TEST_USER_DATA = userData
  process.env.CODEX_HOME = codexHome

  const electron = await import('electron')
  const previousSafeStorage = { ...electron.safeStorage }
  Object.assign(electron.safeStorage, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => Buffer.from(value).toString('utf8').replace(/^encrypted:/, '')
  })

  const origin = 'http://10.44.100.100'
  const now = Date.now()
  const seed = await openDb(join(userData, 'ucli.db'))
  seed.saveServerConnection({
    id: 'service-connection', slot: 'current', serverOrigin: origin,
    refreshTokenCiphertext: Buffer.from('encrypted:initial-refresh').toString('base64'),
    accountId: 'account-1', accountDisplayName: 'Ada',
    organizationId: 'org-a', organizationName: 'Organization A',
    authorizationExpiresAt: null, serverTime: new Date(now).toISOString(),
    receivedLocalTime: now, serverOffsetMs: 0, lastSyncedAt: now,
    connectionRevision: 1, degradedReason: null, reminderState: {}
  })
  seed.flush()
  seed.close()

  let catalog = {
    organization: { id: 'org-a', name: 'Organization A', timezone: 'UTC' },
    models: [{
      id: 'responses-a', displayName: 'Responses A', contextSize: 128000,
      protocols: ['openai_responses']
    }]
  }
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === '/api/v1/auth/token/refresh') {
      return serverResponse({
        accessToken: 'next-access', refreshToken: 'next-refresh', expiresIn: 900,
        authorization: { expiresAt: null, serverTime: new Date().toISOString() }
      }, { cacheControl: 'no-store' })
    }
    if (pathname === '/api/v1/client/bootstrap') {
      return serverResponse({
        organization: catalog.organization,
        gateway: { baseUrl: `${origin}/gateway` },
        models: catalog.models,
        skillsCatalogUrl: `${origin}/api/v1/skills/catalog`,
        authorization: { expiresAt: null, serverTime: new Date().toISOString() }
      })
    }
    if (pathname === '/api/v1/skills/catalog' || pathname === '/api/v1/skills/revocations') {
      return serverResponse([])
    }
    throw new Error(`Unexpected server request: ${url}`)
  }

  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const originalCreate = codexDescriptor.create
  const adapters = []
  codexDescriptor.create = options => {
    const adapter = new EventEmitter()
    adapter.session = options.session
    adapter.settings = options.settings
    adapter.startCalls = 0
    adapter.start = async () => { adapter.startCalls += 1; return true }
    adapter.dispose = async () => {}
    adapter.setProfileEnvironment = environment => { adapter.settings.profileEnvironment = environment }
    adapters.push(adapter)
    return adapter
  }

  let orchestrator
  const events = []
  let bootRevision = 0
  async function boot() {
    handlers.clear()
    const module = await import(`../electron/orchestrator.js?codex-service-profile=${Date.now()}-${++bootRevision}`)
    orchestrator = module.createOrchestrator({ hookReady: Promise.resolve() })
    orchestrator.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => events.push({ channel, payload }) }
    })
    await orchestrator.initPersistence()
    orchestrator.registerIpc()
  }
  try {
    await boot()
    await handlers.get('server-connection:retry')({})
    const serviceProfile = await waitUntil(async () => {
      const profiles = await handlers.get('server-connection:list-models')({})
      return profiles.find(profile => profile.id === `${origin}::org-a` && profile.canStart)
    })
    await callback({
      handlers, adapters, events, db: getDb(), serviceProfile,
      async replaceServiceProfile() {
        catalog = {
          organization: { id: 'org-b', name: 'Organization B', timezone: 'UTC' },
          models: [{
            id: 'responses-b', displayName: 'Responses B', contextSize: 64000,
            protocols: ['openai_responses']
          }]
        }
        await handlers.get('server-connection:sync')({})
        return waitUntil(async () => {
          const profiles = await handlers.get('server-connection:list-models')({})
          return profiles.find(profile => profile.id === `${origin}::org-b` && profile.canStart)
        })
      },
      async replaceServiceModels(models) {
        catalog = { ...catalog, models }
        await handlers.get('server-connection:sync')({})
        return waitUntil(async () => {
          const profiles = await handlers.get('server-connection:list-models')({})
          return profiles.find(profile => profile.id === `${origin}::org-a` && profile.canStart)
        })
      },
      async restartAfterDisconnect() {
        await handlers.get('server-connection:disconnect')({})
        await waitUntil(() => getDb().listServerServiceProfiles().length === 0)
        await orchestrator.shutdown()
        getDb()?.close()
        await boot()
      }
    })
  } finally {
    codexDescriptor.create = originalCreate
    await orchestrator?.shutdown()
    getDb()?.close()
    globalThis.fetch = previousFetch
    for (const key of Object.keys(electron.safeStorage)) delete electron.safeStorage[key]
    Object.assign(electron.safeStorage, previousSafeStorage)
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    rmSync(root, { recursive: true, force: true })
  }
}

function createdCodexSession(handlers, overrides = {}) {
  return handlers.get('session:create')({}, {
    adapterId: 'codex', cwd: 'F:\\projects\\demo', tier: 'safety-rules', ...overrides
  })
}

test('a selected service profile exposes its source kind for historical session presentation', async () => {
  await withCodexServiceProfile(async ({ handlers, serviceProfile }) => {
    const created = createdCodexSession(handlers)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })

    const session = (await handlers.get('session:list')({}))
      .find(candidate => candidate.id === created.sessionId)
    assert.equal(session.profileSourceKind, 'server')
  })
})

test('a selected service tuple remains marked historical after disconnect and reopen', async () => {
  await withCodexServiceProfile(async ({ handlers, events, db, serviceProfile, restartAfterDisconnect }) => {
    const created = createdCodexSession(handlers)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })
    assert.equal(db.getSession(created.sessionId).profileSourceKind, 'server')
    assert.equal((await handlers.get('session:list')({})).find(session => session.id === created.sessionId).profileSourceKind, 'server')
    assert.equal(events.filter(event => event.payload?.type === 'profile-runtime').at(-1)?.payload.profileSourceKind, 'server')

    await restartAfterDisconnect()

    const restored = (await handlers.get('session:list')({}))
      .find(candidate => candidate.id === created.sessionId)
    assert.deepEqual({
      profileId: restored.profileId,
      model: restored.model,
      profileSourceKind: restored.profileSourceKind,
      canStart: restored.canStart
    }, {
      profileId: serviceProfile.id,
      model: 'responses-a',
      profileSourceKind: 'server',
      canStart: false
    })
  })
})

test('an inherited service binding keeps its explicit non-first model', async () => {
  await withCodexServiceProfile(async ({ handlers, replaceServiceModels }) => {
    const profile = await replaceServiceModels([
      { id: 'responses-first', displayName: 'Responses First', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'responses-bound', displayName: 'Responses Bound', contextSize: 128000, protocols: ['openai_responses'] }
    ])
    await handlers.get('ai-cli-profiles:set-binding')({}, {
      scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: profile.id, model: 'responses-bound'
    })

    const created = createdCodexSession(handlers)
    const session = (await handlers.get('session:list')({}))
      .find(candidate => candidate.id === created.sessionId)
    assert.deepEqual({ profileId: session.profileId, model: session.model }, {
      profileId: profile.id, model: 'responses-bound'
    })
  })
})

test('local profile creation never exposes user provenance in session DTOs', async () => {
  await withCodexServiceProfile(async ({ handlers, db, serviceProfile, replaceServiceProfile }) => {
    const serviceSession = createdCodexSession(handlers)
    handlers.get('session:set-profile')({}, serviceSession.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })
    await replaceServiceProfile()
    const local = await handlers.get('ai-cli-profiles:create')({}, {
      adapterId: 'codex', name: 'Local Codex', kind: 'reference',
      providerId: 'openai', model: 'gpt-5.4'
    })
    const created = createdCodexSession(handlers, { profileId: local.id })
    const session = (await handlers.get('session:list')({}))
      .find(candidate => candidate.id === created.sessionId)
    assert.equal(session.profileSourceKind, null)
    assert.equal(db.getSession(created.sessionId).profileSourceKind, null)
  })
})

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

test('a late Codex stats report preserves the requested service model after catalog removal', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, db, serviceProfile }) => {
    const created = createdCodexSession(handlers)
    const adapter = adapters.at(-1)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })

    await handlers.get('server-connection:disconnect')({})
    await waitUntil(() => db.listServerServiceProfiles().length === 0)
    adapter.emit('event', reportedCodexStats('responses-a-alias'))
    await settleAdapterEvent()

    const live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, serviceProfile.id)
    assert.equal(live.model, 'responses-a')
    assert.equal(db.getSession(created.sessionId).profileId, serviceProfile.id)
    assert.equal(db.getSession(created.sessionId).model, 'responses-a')
    assert.equal(live.actualModel, 'responses-a-alias')
    assert.equal(live.profileWarning, 'model_substituted')
  })
})

test('Codex service, local, and system profile transitions clear a reported model alias', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, db, events, serviceProfile, replaceServiceProfile }) => {
    const created = createdCodexSession(handlers)
    const adapter = adapters.at(-1)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })
    assert.equal(db.getSession(created.sessionId).profileSourceKind, 'server')
    assert.equal((await handlers.get('session:list')({})).find(session => session.id === created.sessionId).profileSourceKind, 'server')
    assert.equal(events.filter(event => event.payload?.type === 'profile-runtime').at(-1)?.payload.profileSourceKind, 'server')
    adapter.emit('event', reportedCodexStats('responses-a-alias'))
    await settleAdapterEvent()

    const replacement = await replaceServiceProfile()
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: replacement.id, model: 'responses-b'
    })
    let live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, replacement.id)
    assert.equal(live.model, 'responses-b')
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)

    adapter.emit('event', reportedCodexStats('responses-b-alias', 2))
    await settleAdapterEvent()
    const local = await handlers.get('ai-cli-profiles:create')({}, {
      adapterId: 'codex', name: 'Local Codex', kind: 'reference',
      providerId: 'openai', model: 'gpt-5.4'
    })
    handlers.get('session:set-profile')({}, created.sessionId, { profileId: local.id, model: null })
    live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, local.id)
    assert.equal(live.model, 'gpt-5.4')
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(db.getSession(created.sessionId).profileSourceKind, null)
    assert.equal(live.profileSourceKind, null)
    assert.equal(events.filter(event => event.payload?.type === 'profile-runtime').at(-1)?.payload.profileSourceKind, null)

    handlers.get('session:set-profile')({}, created.sessionId, { profileId: null, model: null })
    live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, null)
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(db.getSession(created.sessionId).profileSourceKind, null)
    assert.equal(live.profileSourceKind, null)
    assert.equal(events.filter(event => event.payload?.type === 'profile-runtime').at(-1)?.payload.profileSourceKind, null)
  })
})

test('a successful Codex restart does not republish a reported model alias', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, events, serviceProfile }) => {
    const created = createdCodexSession(handlers)
    const adapter = adapters.at(-1)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })
    adapter.emit('event', reportedCodexStats('responses-a-alias'))
    await settleAdapterEvent()
    await handlers.get('session:stop')({}, created.sessionId)
    events.length = 0

    await handlers.get('session:restart')({}, created.sessionId)

    const live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    const published = events.filter(({ payload }) => payload.type === 'profile-runtime').at(-1)?.payload
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(published.actualModel, null)
    assert.equal(published.profileWarning, null)
  })
})

test('interactive Codex reprepare does not republish a reported model alias', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, events, serviceProfile }) => {
    const created = createdCodexSession(handlers)
    const adapter = adapters.at(-1)
    handlers.get('session:set-profile')({}, created.sessionId, {
      profileId: serviceProfile.id, model: 'responses-a'
    })
    adapter.emit('event', reportedCodexStats('responses-a-alias'))
    await settleAdapterEvent()
    events.length = 0

    await handlers.get('session:start-adapter')({}, created.sessionId)

    const live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    const published = events.filter(({ payload }) => payload.type === 'profile-runtime').at(-1)?.payload
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(published.actualModel, null)
    assert.equal(published.profileWarning, null)
  })
})

test('a successful system Codex restart clears a reported model alias', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, events }) => {
    const created = createdCodexSession(handlers, {
      model: 'system-model', profileSelection: 'system'
    })
    const adapter = adapters.at(-1)
    adapter.emit('event', { type: 'profile-model', actualModel: 'system-model-alias' })
    await settleAdapterEvent()

    let live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, null)
    assert.equal(live.actualModel, 'system-model-alias')
    assert.equal(live.profileWarning, 'model_substituted')
    await handlers.get('session:stop')({}, created.sessionId)
    events.length = 0

    await handlers.get('session:restart')({}, created.sessionId)

    live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    const published = events.filter(({ payload }) => payload.type === 'profile-runtime').at(-1)?.payload
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(published.actualModel, null)
    assert.equal(published.profileWarning, null)
  })
})

test('system interactive Codex reprepare clears a reported model alias', async () => {
  await withCodexServiceProfile(async ({ handlers, adapters, events }) => {
    const created = createdCodexSession(handlers, {
      model: 'system-model', profileSelection: 'system'
    })
    const adapter = adapters.at(-1)
    adapter.emit('event', { type: 'profile-model', actualModel: 'system-model-alias' })
    await settleAdapterEvent()

    let live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    assert.equal(live.profileId, null)
    assert.equal(live.actualModel, 'system-model-alias')
    assert.equal(live.profileWarning, 'model_substituted')
    events.length = 0

    await handlers.get('session:start-adapter')({}, created.sessionId)

    live = (await handlers.get('session:list')({})).find(session => session.id === created.sessionId)
    const published = events.filter(({ payload }) => payload.type === 'profile-runtime').at(-1)?.payload
    assert.equal(live.actualModel, null)
    assert.equal(live.profileWarning, null)
    assert.equal(published.actualModel, null)
    assert.equal(published.profileWarning, null)
  })
})
