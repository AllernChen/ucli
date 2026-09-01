import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { createServerConnectionRegistrationController } from '../src/serverConnectionRegistrationController.js'

let stateListener
let registrationListener
let skillsCatalogListener
let unsubscribed = 0
let confirmationCalls = 0
let cancelled = []
let listedModels = 0
let listedSkills = 0
let profileReloads = 0

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const initialState = {
  revision: 1,
  status: 'connected',
  reason: null,
  serverOrigin: 'https://server.example.test',
  account: { id: 'member-1', displayName: 'Example member' },
  organization: { id: 'org-1', name: 'Example organization' },
  authorizationExpiresAt: '2026-09-01T00:00:00.000Z',
  serverTime: '2026-08-28T00:00:00.000Z',
  lastSyncedAt: '2026-08-28T00:00:00.000Z',
  connection: {
    id: 'connection-1',
    serverOrigin: 'https://server.example.test',
    account: { id: 'member-1', displayName: 'Example member' },
    organization: { id: 'org-1', name: 'Example organization' },
    authorization: { expiresAt: '2026-09-01T00:00:00.000Z', serverTime: '2026-08-28T00:00:00.000Z' },
    connectionRevision: 1
  }
}

globalThis.window = {
  ucli: {
    onServerConnectionState(listener) { stateListener = listener; return () => { unsubscribed += 1 } },
    onServerConnectionRegistrationRequested(listener) { registrationListener = listener; return () => { unsubscribed += 1 } },
    onServerConnectionSkillsCatalogChanged(listener) { skillsCatalogListener = listener; return () => { unsubscribed += 1 } },
    async getServerConnectionState() { return initialState },
    async submitServerConnectionLink() { return { attemptId: 'attempt-1' } },
    async getPendingServerConnectionAttempt() { return null },
    async getServerConnectionAttempt() {
      return {
        attemptId: 'attempt-1', serverOrigin: 'https://server.example.test',
        preview: {
          account: { id: 'member-1', displayName: 'Example member' },
          organization: { id: 'org-1', name: 'Example organization' },
          link: { status: 'AVAILABLE', expiresAt: '2026-08-29T00:00:00.000Z' },
          authorization: { status: 'AVAILABLE', expiresAt: null, serverTime: '2026-08-28T00:00:00.000Z' }
        }
      }
    },
    async confirmServerConnection() { confirmationCalls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return initialState },
    async retryServerConnectionRedeem() { return initialState },
    async cancelServerConnectionAttempt(id) { cancelled.push(id) },
    async retryServerConnection() { return initialState },
    async syncServerConnection() { return initialState },
    async disconnectServerConnection() { return { ...initialState, revision: 2, status: 'disconnected' } },
    async listServerConnectionModels() { listedModels += 1; return [{ id: 'server-profile', sourceKind: 'server' }] },
    async getAiCliProfileState() {
      profileReloads += 1
      return { profiles: [], cliInventory: [], cliConfiguration: [], codexRuntime: null, claudeRuntime: null }
    },
    async listServerConnectionSkills() { listedSkills += 1; return [{ id: 'version-1', lifecycleStatus: 'AVAILABLE' }] },
    async syncServerConnectionSkills() { listedSkills += 1; return [{ id: 'version-1', lifecycleStatus: 'AVAILABLE' }] },
    async getServerConnectionSkillsSyncState() { return { status: 'ready', lastSyncedAt: 1, catalogRevision: 1, error: null } },
    async ensureServerConnectionSkillsFresh() { return { status: 'ready', lastSyncedAt: 1, catalogRevision: 1, error: null } },
    async installServerConnectionSkill() { return { id: 'installed-1' } },
    async updateServerConnectionSkill() { return { id: 'updated-1' } }
  }
}

const { useServerConnectionStore } = await import('../src/stores/serverConnection.js')

function store() {
  setActivePinia(createPinia())
  confirmationCalls = 0
  cancelled = []
  listedModels = 0
  listedSkills = 0
  profileReloads = 0
  unsubscribed = 0
  return useServerConnectionStore()
}

test('initializes subscriptions before its snapshot and ignores stale state', async () => {
  const connection = store()
  const initializing = connection.initialize()
  assert.equal(typeof stateListener, 'function')
  assert.equal(typeof registrationListener, 'function')
  stateListener({ ...initialState, revision: 2, status: 'unreachable' })
  await initializing
  assert.equal(connection.revision, 2)
  assert.equal(connection.status, 'unreachable')
  stateListener({ ...initialState, revision: 1, status: 'connected' })
  assert.equal(connection.status, 'unreachable')
  connection.dispose()
  assert.equal(unsubscribed, 3)
})

test('initializes cached Skills before a non-blocking refresh and reloads only matching catalog events', async () => {
  const connection = store()
  const refreshing = deferred()
  const calls = []
  let catalogReads = 0
  window.ucli.onServerConnectionState = listener => { stateListener = listener; calls.push('state-listener'); return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = listener => { registrationListener = listener; calls.push('registration-listener'); return () => {} }
  window.ucli.onServerConnectionSkillsCatalogChanged = listener => { skillsCatalogListener = listener; calls.push('skills-listener'); return () => {} }
  window.ucli.getServerConnectionState = async () => { calls.push('state-snapshot'); return initialState }
  window.ucli.getPendingServerConnectionAttempt = async () => null
  window.ucli.listServerConnectionSkills = async () => [{ versionId: catalogReads++ ? 'fresh-version' : 'cached-version' }]
  window.ucli.ensureServerConnectionSkillsFresh = async () => { calls.push('ensure'); return refreshing.promise }

  await connection.initialize()
  assert.deepEqual(connection.skills, [{ versionId: 'cached-version' }])
  assert.equal(calls.indexOf('skills-listener') < calls.indexOf('state-snapshot'), true)
  assert.equal(calls.includes('ensure'), true)

  skillsCatalogListener({
    connectionId: 'connection-1', connectionRevision: 1, catalogRevision: 2,
    lastSyncedAt: 2, status: 'ready'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(connection.skills, [{ versionId: 'fresh-version' }])

  skillsCatalogListener({
    connectionId: 'connection-old', connectionRevision: 1, catalogRevision: 3,
    lastSyncedAt: 3, status: 'ready'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(connection.skills, [{ versionId: 'fresh-version' }])
  refreshing.resolve({ status: 'ready', lastSyncedAt: 4, catalogRevision: 4, error: null })
})

test('a transient unreachable state retains cached organization Skills but explicit disconnect clears them', () => {
  const connection = store()
  connection.applyState(initialState)
  connection.skills = [{ versionId: 'cached-version' }]

  connection.applyState({ ...initialState, revision: 2, status: 'unreachable' })
  assert.deepEqual(connection.skills, [{ versionId: 'cached-version' }])

  connection.applyState({ revision: 3, status: 'disconnected', connection: null })
  assert.deepEqual(connection.skills, [])
})

test('catalog refresh failure retains cached Skills in its own sync state without changing global busy', async () => {
  const connection = store()
  const previousEnsure = window.ucli.ensureServerConnectionSkillsFresh
  connection.applyState(initialState)
  connection.skills = [{ versionId: 'cached-version' }]
  connection.busy = true
  window.ucli.ensureServerConnectionSkillsFresh = async () => ({
    status: 'error', lastSyncedAt: 10, catalogRevision: 1,
    error: { code: 'raw-secret', message: 'Authorization: Bearer secret', retryable: true }
  })

  try {
    await connection.ensureSkillsFresh()
    assert.deepEqual(connection.skills, [{ versionId: 'cached-version' }])
    assert.equal(connection.busy, true)
    assert.equal(connection.skillsSyncState.status, 'error')
    assert.equal(JSON.stringify(connection.skillsSyncState).includes('secret'), false)
    assert.equal(connection.modelCatalogError, null)
  } finally {
    window.ucli.ensureServerConnectionSkillsFresh = previousEnsure
  }
})

test('initialization replays a Preview completed before renderer subscription', async () => {
  const connection = store()
  window.ucli.getPendingServerConnectionAttempt = async () => ({
    attemptId: 'attempt-cold-start', serverOrigin: 'https://server.example.test', preview: {
      link: { status: 'AVAILABLE' }, authorization: { status: 'AVAILABLE' }
    }
  })
  window.ucli.getServerConnectionAttempt = async id => ({
    attemptId: id, serverOrigin: 'https://server.example.test', preview: {
      link: { status: 'AVAILABLE' }, authorization: { status: 'AVAILABLE' }
    }
  })

  await connection.initialize()

  assert.equal(connection.attempt?.attemptId, 'attempt-cold-start')
  assert.equal(connection.canConfirm, true)
})

test('a registration event during pending-attempt snapshot wins over the older replay', async () => {
  const connection = store()
  const pending = deferred()
  const previousPending = window.ucli.getPendingServerConnectionAttempt
  const previousState = window.ucli.getServerConnectionState
  const previousAttempt = window.ucli.getServerConnectionAttempt
  window.ucli.getPendingServerConnectionAttempt = async () => pending.promise
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.getServerConnectionAttempt = async id => ({ attemptId: id, preview: {} })
  try {
    const initializing = connection.initialize()
    registrationListener({ attemptId: 'attempt-newer' })
    await new Promise(resolve => setImmediate(resolve))
    pending.resolve({ attemptId: 'attempt-older', preview: {} })
    await initializing
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(connection.attempt?.attemptId, 'attempt-newer')
  } finally {
    window.ucli.getPendingServerConnectionAttempt = previousPending
    window.ucli.getServerConnectionState = previousState
    window.ucli.getServerConnectionAttempt = previousAttempt
  }
})

test('reinitialization still replays a pending attempt after an earlier registration event', async () => {
  const connection = store()
  const previousPending = window.ucli.getPendingServerConnectionAttempt
  const previousState = window.ucli.getServerConnectionState
  const previousAttempt = window.ucli.getServerConnectionAttempt
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.getPendingServerConnectionAttempt = async () => null
  window.ucli.getServerConnectionAttempt = async id => ({ attemptId: id, preview: {} })
  try {
    await connection.initialize()
    registrationListener({ attemptId: 'attempt-earlier' })
    await new Promise(resolve => setImmediate(resolve))
    connection.dispose()
    window.ucli.getPendingServerConnectionAttempt = async () => ({ attemptId: 'attempt-replayed', preview: {} })

    await connection.initialize()

    assert.equal(connection.attempt?.attemptId, 'attempt-replayed')
  } finally {
    window.ucli.getPendingServerConnectionAttempt = previousPending
    window.ucli.getServerConnectionState = previousState
    window.ucli.getServerConnectionAttempt = previousAttempt
  }
})

test('loads registration attempts by id without retaining submitted input and cancels them', async () => {
  const connection = store()
  await connection.initialize()
  await connection.submitLink('https://server.example.test/connect#link=synthetic-secret')
  assert.equal(connection.attempt.attemptId, 'attempt-1')
  assert.equal(JSON.stringify(connection.$state).includes('synthetic-secret'), false)
  registrationListener({ attemptId: 'attempt-1', serverOrigin: 'https://server.example.test', preview: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connection.attempt.preview.link.status, 'AVAILABLE')
  await connection.cancelAttempt()
  assert.deepEqual(cancelled, ['attempt-1'])
  assert.equal(connection.attempt, null)
})

test('confirms only dual-available previews with one concurrent IPC call and refreshes public catalogs', async () => {
  const connection = store()
  await connection.loadAttempt('attempt-1')
  await Promise.all([connection.confirmAttempt(), connection.confirmAttempt()])
  assert.equal(confirmationCalls, 1)
  assert.equal(connection.attempt, null)
  assert.equal(listedModels, 1)
  assert.equal(profileReloads, 1)
  assert.equal(listedSkills, 1)

  connection.attempt = { ...connection.attempt, attemptId: 'attempt-1', preview: { link: { status: 'EXPIRED' }, authorization: { status: 'AVAILABLE' } } }
  await assert.rejects(connection.confirmAttempt(), { code: 'REGISTRATION_NOT_CONFIRMABLE' })
})

test('startup model synchronization is independently fenced from connection state and recovers on retry', async () => {
  const connection = store()
  const previousModels = window.ucli.listServerConnectionModels
  const previousSkills = window.ucli.listServerConnectionSkills
  let calls = 0
  window.ucli.listServerConnectionModels = async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('synthetic-secret projection failure'), { code: 'projection-failed', retryable: true })
    return [{ id: 'server-profile-b', sourceKind: 'server' }]
  }
  window.ucli.listServerConnectionSkills = async () => [{ id: 'skill-1' }]

  try {
    await connection.initialize()
    assert.equal(connection.status, 'connected')
    assert.equal(connection.connectionError, null)
    assert.deepEqual(connection.modelCatalogError, { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true })
    assert.equal(JSON.stringify(connection.modelCatalogError).includes('synthetic-secret'), false)

    await connection.syncModels()
    assert.deepEqual(connection.models, [{ id: 'server-profile-b', sourceKind: 'server' }])
    assert.equal(connection.connectionError, null)
    assert.equal(connection.modelCatalogError, null)
  } finally {
    window.ucli.listServerConnectionModels = previousModels
    window.ucli.listServerConnectionSkills = previousSkills
  }
})

test('an automatic startup projection failure cannot surface under a replacement connection identity', async () => {
  const connection = store()
  const previousState = window.ucli.getServerConnectionState
  const previousModels = window.ucli.listServerConnectionModels
  const previousSkills = window.ucli.listServerConnectionSkills
  const failureA = deferred()
  const stateA = { ...initialState, organization: { id: 'org-a', name: 'Organization A' } }
  const stateB = {
    ...initialState,
    revision: 2,
    serverOrigin: 'https://replacement.example.test',
    organization: { id: 'org-b', name: 'Organization B' },
    connection: {
      ...initialState.connection,
      id: 'connection-b', serverOrigin: 'https://replacement.example.test',
      organization: { id: 'org-b', name: 'Organization B' }, connectionRevision: 2
    }
  }
  let calls = 0
  window.ucli.getServerConnectionState = async () => stateA
  window.ucli.listServerConnectionModels = async () => (++calls === 1 ? failureA.promise : [{ id: 'profile-b', sourceKind: 'server' }])
  window.ucli.listServerConnectionSkills = async () => []
  try {
    const initializing = connection.initialize()
    await new Promise(resolve => setImmediate(resolve))
    stateListener(stateB)
    failureA.reject(Object.assign(new Error('synthetic-secret old startup failure'), { code: 'projection-failed', retryable: true }))
    await initializing
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(connection.models, [{ id: 'profile-b', sourceKind: 'server' }])
    assert.equal(connection.connectionError, null)
    assert.equal(connection.modelCatalogError, null)
  } finally {
    window.ucli.getServerConnectionState = previousState
    window.ucli.listServerConnectionModels = previousModels
    window.ucli.listServerConnectionSkills = previousSkills
  }
})

test('confirmation remains successful when model catalog synchronization fails', async () => {
  const connection = store()
  await connection.loadAttempt('attempt-1')
  const previousModels = window.ucli.listServerConnectionModels
  const previousSkills = window.ucli.syncServerConnectionSkills
  window.ucli.listServerConnectionModels = async () => {
    throw Object.assign(new Error('synthetic-secret model response'), { code: 'synthetic-model-error', retryable: true })
  }
  window.ucli.syncServerConnectionSkills = async () => [{ id: 'version-1', lifecycleStatus: 'AVAILABLE' }]

  try {
    const state = await connection.confirmAttempt()

    assert.equal(state, initialState)
    assert.equal(connection.status, 'connected')
    assert.equal(connection.connectionError, null)
    assert.deepEqual(connection.modelCatalogError, { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true })
    assert.equal(connection.skillsCatalogError, null)
    assert.equal(JSON.stringify(connection.modelCatalogError).includes('synthetic-secret'), false)
  } finally {
    window.ucli.listServerConnectionModels = previousModels
    window.ucli.syncServerConnectionSkills = previousSkills
  }
})

test('redeem remains successful when Skills catalog synchronization fails', async () => {
  const connection = store()
  await connection.loadAttempt('attempt-1')
  const previousModels = window.ucli.listServerConnectionModels
  const previousSkills = window.ucli.syncServerConnectionSkills
  window.ucli.listServerConnectionModels = async () => [{ id: 'server-profile', sourceKind: 'server' }]
  window.ucli.syncServerConnectionSkills = async () => {
    throw Object.assign(new Error('synthetic-secret Skills response'), { code: 'synthetic-skills-error', retryable: true })
  }

  try {
    const state = await connection.retryRedeem()

    assert.equal(state, initialState)
    assert.equal(connection.status, 'connected')
    assert.equal(connection.connectionError, null)
    assert.equal(connection.modelCatalogError, null)
    assert.deepEqual(connection.skillsCatalogError, { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true })
    assert.equal(JSON.stringify(connection.skillsCatalogError).includes('synthetic-secret'), false)
  } finally {
    window.ucli.listServerConnectionModels = previousModels
    window.ucli.syncServerConnectionSkills = previousSkills
  }
})

test('catalog actions clear only their own error domain', async () => {
  const connection = store()
  const connectionError = { code: 'NETWORK_UNREACHABLE', message: '服务端连接暂时不可用，请稍后重试', retryable: true }
  const skillsCatalogError = { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: false }
  connection.connectionError = connectionError
  connection.modelCatalogError = { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true }
  connection.skillsCatalogError = skillsCatalogError

  await connection.syncModels()

  assert.deepEqual(connection.connectionError, connectionError)
  assert.equal(connection.modelCatalogError, null)
  assert.deepEqual(connection.skillsCatalogError, skillsCatalogError)
})

test('late organization-A Skill installation failure cannot overwrite organization-B catalog state', async () => {
  const connection = store()
  const installation = deferred()
  const orgA = { ...initialState, revision: 1, organization: { id: 'org-a', name: 'A' }, connection: { ...initialState.connection, id: 'connection-a' } }
  const disconnected = { revision: 2, status: 'disconnected', connection: null }
  const orgB = { ...initialState, revision: 3, organization: { id: 'org-b', name: 'B' }, connection: { ...initialState.connection, id: 'connection-b' } }
  const previousInstall = window.ucli.installServerConnectionSkill
  window.ucli.installServerConnectionSkill = async () => installation.promise
  connection.applyState(orgA)

  try {
    const installing = connection.installSkill('version-a', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
    connection.applyState(disconnected)
    connection.applyState(orgB)
    installation.reject(Object.assign(new Error('synthetic-secret org-A install failure'), { code: 'synthetic-install-error' }))

    await assert.rejects(installing)
    assert.equal(connection.organization.id, 'org-b')
    assert.equal(connection.skillsCatalogError, null)
  } finally {
    window.ucli.installServerConnectionSkill = previousInstall
  }
})

test('late organization-A Skill update failure cannot overwrite organization-B catalog state', async () => {
  const connection = store()
  const update = deferred()
  const orgA = { ...initialState, revision: 1, organization: { id: 'org-a', name: 'A' }, connection: { ...initialState.connection, id: 'connection-a' } }
  const disconnected = { revision: 2, status: 'disconnected', connection: null }
  const orgB = { ...initialState, revision: 3, organization: { id: 'org-b', name: 'B' }, connection: { ...initialState.connection, id: 'connection-b' } }
  const previousUpdate = window.ucli.updateServerConnectionSkill
  window.ucli.updateServerConnectionSkill = async () => update.promise
  connection.applyState(orgA)

  try {
    const updating = connection.updateSkill('version-a', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
    connection.applyState(disconnected)
    connection.applyState(orgB)
    update.reject(Object.assign(new Error('synthetic-secret org-A update failure'), { code: 'synthetic-update-error' }))

    await assert.rejects(updating)
    assert.equal(connection.organization.id, 'org-b')
    assert.equal(connection.skillsCatalogError, null)
  } finally {
    window.ucli.updateServerConnectionSkill = previousUpdate
  }
})

test('late organization-A model response cannot overwrite organization-B models', async () => {
  const connection = store()
  const oldModels = deferred()
  const orgA = { ...initialState, revision: 1, organization: { id: 'org-a', name: 'A' }, connection: { ...initialState.connection, id: 'connection-a' } }
  const disconnected = { revision: 2, status: 'disconnected', connection: null }
  const orgB = { ...initialState, revision: 3, organization: { id: 'org-b', name: 'B' }, connection: { ...initialState.connection, id: 'connection-b' } }
  const previousModels = window.ucli.listServerConnectionModels
  let calls = 0
  window.ucli.listServerConnectionModels = async () => (++calls === 1 ? oldModels.promise : [{ id: 'model-b' }])
  connection.applyState(orgA)

  try {
    const loadingA = connection.syncModels()
    connection.applyState(disconnected)
    connection.applyState(orgB)
    await connection.syncModels()
    oldModels.resolve([{ id: 'model-a' }])

    await loadingA
    assert.deepEqual(connection.models, [{ id: 'model-b' }])
    assert.equal(connection.modelCatalogError, null)
  } finally {
    window.ucli.listServerConnectionModels = previousModels
  }
})

test('late organization-A model failure cannot overwrite organization-B catalog state', async () => {
  const connection = store()
  const oldModels = deferred()
  const orgA = { ...initialState, revision: 1, organization: { id: 'org-a', name: 'A' }, connection: { ...initialState.connection, id: 'connection-a' } }
  const disconnected = { revision: 2, status: 'disconnected', connection: null }
  const orgB = { ...initialState, revision: 3, organization: { id: 'org-b', name: 'B' }, connection: { ...initialState.connection, id: 'connection-b' } }
  const previousModels = window.ucli.listServerConnectionModels
  let calls = 0
  window.ucli.listServerConnectionModels = async () => (++calls === 1 ? oldModels.promise : [{ id: 'model-b' }])
  connection.applyState(orgA)

  try {
    const loadingA = connection.syncModels()
    connection.applyState(disconnected)
    connection.applyState(orgB)
    await connection.syncModels()
    oldModels.reject(Object.assign(new Error('synthetic-secret org-A model failure'), { code: 'synthetic-model-error' }))

    await assert.rejects(loadingA)
    assert.deepEqual(connection.models, [{ id: 'model-b' }])
    assert.equal(connection.modelCatalogError, null)
  } finally {
    window.ucli.listServerConnectionModels = previousModels
  }
})

test('retains only stable public connection errors and refreshes catalog actions', async () => {
  const connection = store()
  window.ucli.syncServerConnection = async () => { throw Object.assign(new Error('synthetic-secret response'), { code: 'NETWORK_UNREACHABLE', retryable: true, stack: 'sensitive' }) }
  await assert.rejects(connection.syncConnection())
  assert.deepEqual(connection.connectionError, { code: 'NETWORK_UNREACHABLE', message: '服务端连接暂时不可用，请稍后重试', retryable: true })
  assert.equal(JSON.stringify(connection.connectionError).includes('synthetic-secret'), false)
  await connection.syncSkills()
  await connection.installSkill('version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
  await connection.updateSkill('version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
  assert.equal(listedSkills >= 3, true)
})

test('retry redeem is single-flight and invokes IPC only once', async () => {
  const connection = store()
  await connection.loadAttempt('attempt-1')
  const pending = deferred()
  let calls = 0
  window.ucli.retryServerConnectionRedeem = async () => { calls += 1; return pending.promise }
  window.ucli.syncServerConnection = async () => initialState
  window.ucli.listServerConnectionModels = async () => []
  window.ucli.syncServerConnectionSkills = async () => []
  window.ucli.getAiCliProfileState = async () => ({ profiles: [], cliInventory: [], cliConfiguration: [] })
  const first = connection.retryRedeem()
  const second = connection.retryRedeem()
  assert.equal(calls, 1)
  pending.resolve(initialState)
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('late attempt loads cannot overwrite a newer attempt or resurrect a cancelled one', async () => {
  const connection = store()
  const first = deferred()
  const second = deferred()
  window.ucli.getServerConnectionAttempt = async (attemptId) => attemptId === 'attempt-old' ? first.promise : second.promise
  const oldLoad = connection.loadAttempt('attempt-old')
  const newLoad = connection.loadAttempt('attempt-new')
  second.resolve({ attemptId: 'attempt-new', preview: {} })
  await newLoad
  first.resolve({ attemptId: 'attempt-old', preview: {} })
  await oldLoad
  assert.equal(connection.attempt.attemptId, 'attempt-new')
  const cancelled = deferred()
  window.ucli.getServerConnectionAttempt = async () => cancelled.promise
  const cancelledLoad = connection.loadAttempt('attempt-cancelled')
  await connection.cancelAttempt()
  cancelled.resolve({ attemptId: 'attempt-cancelled', preview: {} })
  await cancelledLoad
  assert.equal(connection.attempt, null)
})

test('cancelling an event attempt before it loads still cancels the known attempt id', async () => {
  const connection = store()
  const pending = deferred()
  window.ucli.getServerConnectionAttempt = async () => pending.promise
  const loading = connection.loadAttempt('attempt-event')
  await connection.cancelAttempt()
  assert.deepEqual(cancelled, ['attempt-event'])
  pending.resolve({ attemptId: 'attempt-event', preview: {} })
  await loading
  assert.equal(connection.attempt, null)
})

test('an external registration event opens the root dialog and navigates without putting attempt data in the route', async () => {
  const connection = store()
  let visible = false
  let navigation = null
  window.ucli.onServerConnectionState = (listener) => { stateListener = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { registrationListener = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => ({ ...initialState, status: 'disconnected' })
  window.ucli.getServerConnectionAttempt = async () => ({ attemptId: 'attempt-external', serverOrigin: 'https://server.example.test', preview: {} })
  const controller = createServerConnectionRegistrationController({
    getAttempt: () => connection.attempt,
    setVisible: (value) => { visible = value },
    navigate: (target) => { navigation = target }
  })
  await connection.initialize()
  registrationListener({ attemptId: 'attempt-external', serverOrigin: 'https://server.example.test' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.presentCurrentAttempt(), true)
  assert.equal(visible, true)
  assert.deepEqual(navigation, { name: 'settings', query: { section: 'server' } })
  assert.equal(JSON.stringify(navigation).includes('attempt-external'), false)
  assert.equal(JSON.stringify(navigation).includes('server.example.test'), false)
})

test('initialize cleans up a failed subscription and ignores a late snapshot after dispose', async () => {
  const failed = store()
  let failedUnsubscribes = 0
  window.ucli.onServerConnectionState = () => () => { failedUnsubscribes += 1 }
  window.ucli.onServerConnectionRegistrationRequested = () => () => { failedUnsubscribes += 1 }
  window.ucli.getServerConnectionState = async () => { throw Object.assign(new Error(), { code: 'NETWORK_UNREACHABLE' }) }
  await assert.rejects(failed.initialize())
  assert.equal(failedUnsubscribes, 2)
  window.ucli.getServerConnectionState = async () => initialState
  await failed.initialize()
  assert.equal(failed.initialized, true)

  const late = store()
  const snapshot = deferred()
  window.ucli.getServerConnectionState = async () => snapshot.promise
  const initializing = late.initialize()
  late.dispose()
  snapshot.resolve(initialState)
  await initializing
  assert.equal(late.initialized, false)
})

test('initialization releases an already-registered listener when the next subscription fails', async () => {
  const connection = store()
  let stateUnsubscribes = 0
  window.ucli.onServerConnectionState = () => () => { stateUnsubscribes += 1 }
  window.ucli.onServerConnectionRegistrationRequested = () => { throw Object.assign(new Error(), { code: 'NETWORK_UNREACHABLE' }) }
  await assert.rejects(connection.initialize())
  assert.equal(stateUnsubscribes, 1)
  assert.equal(connection.initialized, false)
})

test('initialization reads the cached catalog and validates catalog version targets', async () => {
  const connection = store()
  let listCalls = 0
  let installed
  let updated
  window.ucli.onServerConnectionState = (listener) => { stateListener = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { registrationListener = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.listServerConnectionSkills = async () => { listCalls += 1; return [{ versionId: 'catalog-version-1', lifecycleStatus: 'AVAILABLE' }] }
  window.ucli.installServerConnectionSkill = async (...args) => { installed = args; return {} }
  window.ucli.updateServerConnectionSkill = async (...args) => { updated = args; return {} }
  window.ucli.syncServerConnectionSkills = async () => []
  await connection.initialize()
  assert.equal(listCalls, 1)
  assert.equal(connection.skills[0].versionId, 'catalog-version-1')
  await connection.installSkill('catalog-version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
  await connection.updateSkill('catalog-version-1', { targetAdapterIds: ['claude'], scopeType: 'project', projectPath: 'F:/project' })
  assert.deepEqual(installed, ['catalog-version-1', { targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' }])
  assert.deepEqual(updated, ['catalog-version-1', { targetAdapterIds: ['claude'], scopeType: 'project', projectPath: 'F:/project' }])
  await assert.rejects(connection.installSkill('catalog-version-1', { targetAdapterIds: [], scopeType: 'user', projectPath: '' }), { code: 'INVALID_SKILL_TARGETS' })
  await assert.rejects(connection.installSkill('catalog-version-1', { targetAdapterIds: ['codex'], scopeType: 'project', projectPath: '' }), { code: 'INVALID_SKILL_TARGETS' })
})

test('a cached catalog failure preserves initialized subscriptions for later events', async () => {
  const connection = store()
  let eventState
  let eventRegistration
  window.ucli.onServerConnectionState = (listener) => { eventState = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { eventRegistration = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.listServerConnectionSkills = async () => { throw Object.assign(new Error(), { code: 'NETWORK_UNREACHABLE' }) }
  window.ucli.getServerConnectionAttempt = async () => ({ attemptId: 'attempt-later', preview: {} })
  await connection.initialize()
  assert.equal(connection.initialized, true)
  eventState({ ...initialState, revision: 2, status: 'unreachable' })
  eventRegistration({ attemptId: 'attempt-later' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connection.status, 'unreachable')
  assert.equal(connection.attempt.attemptId, 'attempt-later')
})

test('catalog identity fences clear disconnected and stale organization results', async () => {
  const connection = store()
  const orgA = { ...initialState, revision: 1, organization: { id: 'org-a', name: 'A' } }
  const orgB = { ...initialState, revision: 3, organization: { id: 'org-b', name: 'B' } }
  const lateA = deferred()
  const freshB = deferred()
  let calls = 0
  window.ucli.onServerConnectionState = (listener) => { stateListener = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { registrationListener = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => orgA
  window.ucli.listServerConnectionSkills = async () => (++calls === 1 ? lateA.promise : freshB.promise)
  const initialize = connection.initialize()
  await new Promise(resolve => setImmediate(resolve))
  stateListener({ ...orgA, revision: 2, status: 'disconnected' })
  assert.deepEqual(connection.skills, [])
  stateListener(orgB)
  freshB.resolve([{ versionId: 'org-b-version' }])
  lateA.resolve([{ versionId: 'org-a-version' }])
  await initialize
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(connection.skills, [{ versionId: 'org-b-version' }])
  assert.equal(connection.organization.id, 'org-b')
})

test('expiring authorization keeps the connected catalog available for cached and explicit sync results', async () => {
  const connection = store()
  let calls = 0
  window.ucli.onServerConnectionState = (listener) => { stateListener = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { registrationListener = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.listServerConnectionSkills = async () => [{ versionId: `cached-${++calls}` }]
  window.ucli.syncServerConnectionSkills = async () => [{ versionId: 'synced-expiring' }]
  await connection.initialize()
  stateListener({ ...initialState, revision: 2, status: 'expiring' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(connection.skills, [{ versionId: 'cached-1' }])
  await connection.syncSkills()
  assert.deepEqual(connection.skills, [{ versionId: 'synced-expiring' }])
  await connection.loadCachedSkills()
  assert.deepEqual(connection.skills, [{ versionId: 'cached-2' }])
})

test('a connection revision replacement fences a late catalog load for the same origin and organization', async () => {
  const connection = store()
  const oldCatalog = deferred()
  const replacementCatalog = deferred()
  const replacement = {
    ...initialState,
    revision: 2,
    connection: { ...initialState.connection, connectionRevision: 2 }
  }
  let calls = 0
  window.ucli.onServerConnectionState = (listener) => { stateListener = listener; return () => {} }
  window.ucli.onServerConnectionRegistrationRequested = (listener) => { registrationListener = listener; return () => {} }
  window.ucli.getServerConnectionState = async () => initialState
  window.ucli.listServerConnectionSkills = async () => (++calls === 1 ? oldCatalog.promise : replacementCatalog.promise)
  const initializing = connection.initialize()
  await new Promise(resolve => setImmediate(resolve))
  stateListener(replacement)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.deepEqual(connection.skills, [])
  replacementCatalog.resolve([{ versionId: 'replacement-version' }])
  oldCatalog.resolve([{ versionId: 'old-version' }])
  await initializing
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(connection.skills, [{ versionId: 'replacement-version' }])
})

test('unknown server errors never retain attacker-controlled codes or text', async () => {
  const connection = store()
  window.ucli.syncServerConnection = async () => { throw Object.assign(new Error('synthetic-secret'), { code: 'synthetic-secret-code', retryable: true }) }
  await assert.rejects(connection.syncConnection())
  assert.deepEqual(connection.connectionError, { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true })
})

test('stable terminal grant errors retain reauthorization guidance', async () => {
  const connection = store()
  const previousSync = window.ucli.syncServerConnection
  try {
    for (const [code, message] of [
      ['invalid_grant', '服务端授权无效，请重新连接'],
      ['invalid_device', '设备注册无效，请重新连接']
    ]) {
      window.ucli.syncServerConnection = async () => { throw Object.assign(new Error('opaque server detail'), { code }) }
      await assert.rejects(connection.syncConnection(), { code })
      assert.deepEqual(connection.connectionError, { code, message, retryable: false })
    }
  } finally {
    window.ucli.syncServerConnection = previousSync
  }
})
