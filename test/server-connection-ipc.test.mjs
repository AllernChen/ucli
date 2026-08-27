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
