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
