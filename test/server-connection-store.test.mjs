import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

let stateListener
let registrationListener
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
  lastSyncedAt: '2026-08-28T00:00:00.000Z'
}

globalThis.window = {
  ucli: {
    onServerConnectionState(listener) { stateListener = listener; return () => { unsubscribed += 1 } },
    onServerConnectionRegistrationRequested(listener) { registrationListener = listener; return () => { unsubscribed += 1 } },
    async getServerConnectionState() { return initialState },
    async submitServerConnectionLink() { return { attemptId: 'attempt-1' } },
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
  assert.equal(unsubscribed, 2)
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

test('retains only stable public errors and refreshes catalog actions', async () => {
  const connection = store()
  window.ucli.syncServerConnection = async () => { throw Object.assign(new Error('synthetic-secret response'), { code: 'NETWORK_UNREACHABLE', retryable: true, stack: 'sensitive' }) }
  await assert.rejects(connection.syncConnection())
  assert.deepEqual(connection.error, { code: 'NETWORK_UNREACHABLE', message: '服务端连接暂时不可用，请稍后重试', retryable: true })
  assert.equal(JSON.stringify(connection.error).includes('synthetic-secret'), false)
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

test('initialization reads the cached catalog and validates catalog version targets', async () => {
  const connection = store()
  let listCalls = 0
  let installed
  let updated
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

test('unknown server errors never retain attacker-controlled codes or text', async () => {
  const connection = store()
  window.ucli.syncServerConnection = async () => { throw Object.assign(new Error('synthetic-secret'), { code: 'synthetic-secret-code', retryable: true }) }
  await assert.rejects(connection.syncConnection())
  assert.deepEqual(connection.error, { code: 'SERVER_CONNECTION_OPERATION_FAILED', message: '服务端操作失败，请稍后重试', retryable: true })
})
