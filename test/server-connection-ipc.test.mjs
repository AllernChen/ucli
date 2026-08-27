import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectionManager } from '../electron/serverConnection/connectionManager.js'
import { registerServerConnectionIpc } from '../electron/serverConnection/ipc.js'
import { RegistrationAttemptStore } from '../electron/serverConnection/registrationAttempts.js'

const preview = {
  account: { id: 'account-1', displayName: 'Ada' },
  organization: { id: 'org-1', name: 'Example' },
  link: { status: 'AVAILABLE', expiresAt: null },
  authorization: { status: 'AVAILABLE', expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' }
}
const redeemed = {
  refreshToken: 'refresh-token-secret', accessToken: 'access-token-secret', expiresIn: 900,
  account: preview.account, organization: preview.organization,
  authorization: { expiresAt: null, serverTime: '2026-08-27T00:00:00.000Z' }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function setup({ client = {}, credentials = {} } = {}) {
  const handlers = new Map()
  const events = []
  const current = {
    id: 'old', serverOrigin: 'https://old.example.test', refreshTokenCiphertext: 'old-ciphertext',
    accountId: 'old-account', accountDisplayName: 'Old', organizationId: 'old-org', organizationName: 'Old Org',
    authorizationExpiresAt: null, serverTime: '2026-08-01T00:00:00.000Z', connectionRevision: 7
  }
  const credentialStore = {
    readCurrent: () => current,
    getOrCreateInstallation: async () => ({ installationId: '550e8400-e29b-41d4-a716-446655440000', deviceName: 'Workstation' }),
    stageCandidate: async () => ({ id: 'candidate' }),
    promoteCandidate: async () => ({ ...current, id: 'new', serverOrigin: 'https://server.example.test', connectionRevision: 8 }),
    disconnect: async () => {},
    ...credentials
  }
  const manager = new ConnectionManager({
    attempts: new RegistrationAttemptStore(), credentials: credentialStore,
    client: { preview: async () => preview, redeem: async () => redeemed, ...client },
    platform: 'windows', deviceName: 'Workstation', clientVersion: '0.12.0'
  })
  registerServerConnectionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, manager,
    send: (channel, payload) => events.push({ channel, payload })
  })
  return { handlers, manager, current, events }
}

test('IPC returns only a sanitized preview and rejects extra confirm parameters', async () => {
  const { handlers } = setup()
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  assert.equal(attempt.serverOrigin, 'https://server.example.test')
  assert.equal(JSON.stringify(attempt).includes('opaque-secret'), false)
  assert.equal(JSON.stringify(attempt).includes('access-token-secret'), false)

  await assert.rejects(
    handlers.get('server-connection:confirm')({}, attempt.attemptId, 'opaque-secret'),
    error => error.code === 'INVALID_SERVER_CONNECTION_IPC' && error.stack === undefined
  )
})

test('registration failures keep the old current connection and sanitize errors', async () => {
  const { handlers, current } = setup({ client: { preview: async () => { throw Object.assign(new Error('https://server.example.test/connect#link=opaque-secret Authorization: Bearer token'), { code: 'invalid_link' }) } } })
  await assert.rejects(
    handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret'),
    error => error.code === 'invalid_link' && !String(error.message).includes('opaque-secret') &&
      !String(error.stack || '').includes('opaque-secret')
  )
  assert.equal(current.id, 'old')
})

test('candidate promotion revokes the old runtime only after durable promotion and bootstrap failure does not roll back', async () => {
  const revoked = []
  const { manager, handlers } = setup({
    client: { bootstrap: async () => { throw Object.assign(new Error('network body: refresh-token-secret'), { retryable: true }) } },
    credentials: { promoteCandidate: async () => ({ id: 'new', serverOrigin: 'https://server.example.test', accountId: 'account-1', accountDisplayName: 'Ada', organizationId: 'org-1', organizationName: 'Example', authorizationExpiresAt: null, serverTime: '2026-08-27T00:00:00.000Z', connectionRevision: 8 }) }
  })
  manager.revokeRuntimeRevision = revision => revoked.push(revision)
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  await handlers.get('server-connection:confirm')({}, attempt.attemptId)
  assert.deepEqual(revoked, [7])
  assert.equal(manager.getState().connection.connectionRevision, 8)
  assert.equal(manager.getState().status, 'unreachable')
})

test('secure-storage unavailability prevents redeem and preserves the current connection', async () => {
  let redeemedCalled = false
  const { handlers, current } = setup({
    client: { redeem: async () => { redeemedCalled = true; return redeemed } },
    credentials: { assertEncryptionAvailable: () => { throw Object.assign(new Error('keychain unavailable'), { code: 'SECURE_STORAGE_UNAVAILABLE' }) } }
  })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  await assert.rejects(handlers.get('server-connection:confirm')({}, attempt.attemptId), { code: 'SECURE_STORAGE_UNAVAILABLE' })
  assert.equal(redeemedCalled, false)
  assert.equal(current.id, 'old')
})

test('cancelling while redeem is pending prevents later candidate persistence', async () => {
  const redeem = deferred()
  const redeemStarted = deferred()
  let stageCalls = 0
  let promoteCalls = 0
  const { handlers, manager } = setup({
    client: { redeem: async () => { redeemStarted.resolve(); return redeem.promise } },
    credentials: {
      stageCandidate: async () => { stageCalls += 1; return { id: 'candidate' } },
      promoteCandidate: async () => { promoteCalls += 1; return { id: 'new', connectionRevision: 8 } }
    }
  })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  const confirmation = handlers.get('server-connection:confirm')({}, attempt.attemptId)
  await redeemStarted.promise
  assert.equal(manager.cancel(attempt.attemptId), true)
  redeem.resolve(redeemed)
  await assert.rejects(confirmation, { code: 'invalid_link' })
  assert.equal(stageCalls, 0)
  assert.equal(promoteCalls, 0)
  assert.equal(manager.getState().connection.id, 'old')
  assert.equal(manager.invalidatedAttempts.has(attempt.attemptId), false)
})

test('disconnecting while redeem is pending cannot resurrect credentials after the response', async () => {
  const redeem = deferred()
  const redeemStarted = deferred()
  let stageCalls = 0
  const { handlers, manager } = setup({
    client: { redeem: async () => { redeemStarted.resolve(); return redeem.promise } },
    credentials: { stageCandidate: async () => { stageCalls += 1; return { id: 'candidate' } } }
  })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  const confirmation = handlers.get('server-connection:confirm')({}, attempt.attemptId)
  await redeemStarted.promise
  await manager.disconnect()
  redeem.resolve(redeemed)
  await assert.rejects(confirmation, { code: 'invalid_link' })
  assert.equal(stageCalls, 0)
  assert.equal(manager.getState().status, 'disconnected')
  assert.equal(manager.getState().connection, null)
})

test('cancelling after candidate staging begins discards it without promotion', async () => {
  const stage = deferred()
  const stageStarted = deferred()
  const discarded = []
  let promoteCalls = 0
  const { handlers, manager } = setup({
    credentials: {
      stageCandidate: async () => { stageStarted.resolve(); return stage.promise },
      discardCandidate: async (candidateId) => { discarded.push(candidateId); return true },
      promoteCandidate: async () => { promoteCalls += 1; return { id: 'new', connectionRevision: 8 } }
    }
  })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  const confirmation = handlers.get('server-connection:confirm')({}, attempt.attemptId)
  await stageStarted.promise
  assert.equal(manager.cancel(attempt.attemptId), true)
  stage.resolve({ id: 'candidate' })
  await assert.rejects(confirmation, { code: 'invalid_link' })
  assert.deepEqual(discarded, ['candidate'])
  assert.equal(promoteCalls, 0)
  assert.equal(manager.getState().connection.id, 'old')
})

test('cancellation loses at the promotion commit point and the committed connection succeeds', async () => {
  const promotion = deferred()
  const promotionStarted = deferred()
  const committed = { id: 'new', serverOrigin: 'https://server.example.test', accountId: 'account-1', accountDisplayName: 'Ada', organizationId: 'org-1', organizationName: 'Example', authorizationExpiresAt: null, serverTime: '2026-08-27T00:00:00.000Z', connectionRevision: 8 }
  const { handlers, manager } = setup({
    credentials: { promoteCandidate: async () => { promotionStarted.resolve(); return promotion.promise } }
  })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  const confirmation = handlers.get('server-connection:confirm')({}, attempt.attemptId)
  await promotionStarted.promise
  assert.equal(manager.cancel(attempt.attemptId), false)
  promotion.resolve(committed)
  await confirmation
  assert.equal(manager.getState().connection.id, committed.id)
  assert.equal(manager.getAttempt(attempt.attemptId), null)
})

test('a different attempt is rejected while another attempt is redeeming', async () => {
  const redeem = deferred()
  const redeemStarted = deferred()
  let redeemCalls = 0
  const { handlers } = setup({ client: { redeem: async () => { redeemCalls += 1; redeemStarted.resolve(); return redeem.promise } } })
  const first = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=one')
  const second = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=two')
  const firstConfirmation = handlers.get('server-connection:confirm')({}, first.attemptId)
  await redeemStarted.promise
  await assert.rejects(handlers.get('server-connection:confirm')({}, second.attemptId), { code: 'REGISTRATION_BUSY' })
  assert.equal(redeemCalls, 1)
  redeem.resolve(redeemed)
  await firstConfirmation
})

test('cancelling another open attempt does not invalidate the active redeem', async () => {
  const redeem = deferred()
  const redeemStarted = deferred()
  const { handlers, manager } = setup({ client: { redeem: async () => { redeemStarted.resolve(); return redeem.promise } } })
  const active = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=one')
  const other = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=two')
  const confirmation = handlers.get('server-connection:confirm')({}, active.attemptId)
  await redeemStarted.promise
  assert.equal(manager.cancel(other.attemptId), true)
  redeem.resolve(redeemed)
  await confirmation
  assert.equal(manager.getState().connection.id, 'new')
  assert.equal(manager.invalidatedAttempts.has(other.attemptId), false)
})

test('a stale Bootstrap failure cannot overwrite disconnected state', async () => {
  const bootstrap = deferred()
  const bootstrapStarted = deferred()
  const { handlers, manager } = setup({ client: { bootstrap: async () => { bootstrapStarted.resolve(); return bootstrap.promise } } })
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  const confirmation = handlers.get('server-connection:confirm')({}, attempt.attemptId)
  await bootstrapStarted.promise
  await manager.disconnect()
  bootstrap.reject(Object.assign(new Error('network response body'), { retryable: true }))
  await confirmation
  assert.equal(manager.getState().status, 'disconnected')
  assert.equal(manager.getState().connection, null)
})

test('post-commit listener and revoker failures do not reject confirmation and revocation retries later', async () => {
  let revocationCalls = 0
  const states = []
  const { handlers, manager } = setup()
  manager.revokeRuntimeRevision = () => {
    revocationCalls += 1
    if (revocationCalls === 1) throw new Error('runtime unavailable')
  }
  manager.subscribe(() => { throw new Error('listener unavailable') })
  manager.subscribe(state => states.push(state.status))
  const attempt = await handlers.get('server-connection:submit-link')({}, 'https://server.example.test/connect#link=opaque-secret')
  await handlers.get('server-connection:confirm')({}, attempt.attemptId)
  assert.equal(manager.getState().connection.id, 'new')
  assert.deepEqual(states, ['connected'])
  assert.deepEqual([...manager.pendingRevocations], [7])
  await manager.retry()
  assert.equal(revocationCalls, 2)
  assert.deepEqual([...manager.pendingRevocations], [])
})
