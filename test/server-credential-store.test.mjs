import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { ServerCredentialStore } from '../electron/serverConnection/credentialStore.js'

const tokenCiphertext = value => Buffer.from(`encrypted:${value}`).toString('base64')
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => Buffer.from(value).toString('utf8').replace(/^encrypted:/, '')
}

async function withStore(work) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-credentials-'))
  const path = join(root, 'ucli.db')
  const db = await openDb(path)
  try { await work({ db, path }) } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const credentials = (overrides = {}) => ({
  serverOrigin: 'https://server.example.test',
  refreshToken: 'refresh-token-secret',
  account: { id: 'account-1', displayName: 'Ada Lovelace' },
  organization: { id: 'organization-1', name: 'Example Org' },
  authorization: { expiresAt: '2026-12-01T00:00:00.000Z', serverTime: '2026-08-27T00:00:00.000Z' },
  ...overrides
})

test('installation UUID is created once and survives disconnect, failed candidate persistence, and replacement', async () => {
  await withStore(async ({ db }) => {
    let uuidCalls = 0
    const store = new ServerCredentialStore({
      db, safeStorage, now: () => 100,
      uuid: () => { uuidCalls += 1; return '550e8400-e29b-41d4-a716-446655440000' }
    })
    const installation = await store.getOrCreateInstallation({ deviceName: 'Workstation' })
    assert.deepEqual(installation, { installationId: '550e8400-e29b-41d4-a716-446655440000', deviceName: 'Workstation', createdAt: 100 })
    assert.equal((await store.getOrCreateInstallation({ deviceName: 'Other' })).installationId, installation.installationId)
    assert.equal(uuidCalls, 1)

    const originalFlush = db.flush.bind(db)
    db.flush = () => false
    await assert.rejects(store.stageCandidate(credentials()), { code: 'PERSISTENCE_PENDING' })
    await assert.rejects(store.promoteCandidate(installation.installationId), { code: 'PERSISTENCE_PENDING' })
    db.flush = originalFlush
    const candidate = await store.stageCandidate(credentials())
    await store.promoteCandidate(candidate.id)
    await store.disconnect()
    assert.deepEqual(db.getServerInstallation(), installation)
  })
})

test('creating an installation fails closed when its durable flush fails', async () => {
  await withStore(async ({ db }) => {
    db.flush = () => false
    const store = new ServerCredentialStore({ db, safeStorage, uuid: () => '550e8400-e29b-41d4-a716-446655440000' })
    await assert.rejects(store.getOrCreateInstallation({ deviceName: 'Workstation' }), { code: 'PERSISTENCE_PENDING' })
  })
})

test('concurrent stores create one durable installation record', async () => {
  await withStore(async ({ db }) => {
    let uuidCalls = 0
    const uuid = () => {
      uuidCalls += 1
      return '550e8400-e29b-41d4-a716-446655440000'
    }
    const first = new ServerCredentialStore({ db, safeStorage, now: () => 100, uuid })
    const second = new ServerCredentialStore({ db, safeStorage, now: () => 200, uuid })

    const [fromFirst, fromSecond] = await Promise.all([
      first.getOrCreateInstallation({ deviceName: 'First workstation' }),
      second.getOrCreateInstallation({ deviceName: 'Second workstation' })
    ])

    assert.deepEqual(fromFirst, fromSecond)
    assert.equal(uuidCalls, 1)
    assert.deepEqual(db.getServerInstallation(), fromFirst)
  })
})

test('a second store cannot promote a candidate whose ciphertext flush failed', async () => {
  await withStore(async ({ db }) => {
    const candidateId = '550e8400-e29b-41d4-a716-446655440000'
    const first = new ServerCredentialStore({ db, safeStorage, uuid: () => candidateId })
    db.flush = () => false

    await assert.rejects(first.stageCandidate(credentials()), { code: 'PERSISTENCE_PENDING' })

    const second = new ServerCredentialStore({ db, safeStorage })
    await assert.rejects(second.promoteCandidate(candidateId), { code: 'PERSISTENCE_PENDING' })
    assert.equal(db.getServerConnection('candidate').id, candidateId)
    assert.equal(db.getServerConnection('current'), null)
  })
})

test('a second store hides a current connection whose promotion flush failed', async () => {
  await withStore(async ({ db }) => {
    const candidateId = '550e8400-e29b-41d4-a716-446655440000'
    const first = new ServerCredentialStore({ db, safeStorage, uuid: () => candidateId })
    const candidate = await first.stageCandidate(credentials())
    db.flush = () => false
    await assert.rejects(first.promoteCandidate(candidate.id), { code: 'PERSISTENCE_PENDING' })

    const second = new ServerCredentialStore({ db, safeStorage })
    assert.equal(second.readCurrent(), null)
  })
})

test('a failed promotion flush restores the durable current and leaves the candidate retryable', async () => {
  await withStore(async ({ db }) => {
    const ids = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001']
    const store = new ServerCredentialStore({ db, safeStorage, now: () => 100, uuid: () => ids.shift() })
    const old = await store.stageCandidate(credentials({ refreshToken: 'old-token' }))
    await store.promoteCandidate(old.id)
    const oldCurrent = store.readCurrent()
    const candidate = await store.stageCandidate(credentials({ refreshToken: 'next-token' }))
    const originalFlush = db.flush.bind(db)
    db.flush = () => false

    await assert.rejects(store.promoteCandidate(candidate.id), { code: 'PERSISTENCE_PENDING' })
    assert.deepEqual(store.readCurrent(), oldCurrent)
    assert.deepEqual(db.getServerConnection('candidate'), candidate)

    db.flush = originalFlush
    const promoted = await store.promoteCandidate(candidate.id)
    assert.equal(promoted.id, candidate.id)
    assert.equal(promoted.connectionRevision, 2)
  })
})

test('discarding a candidate preserves current and installation, and a failed discard remains gated until retried', async () => {
  await withStore(async ({ db }) => {
    const ids = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002']
    const store = new ServerCredentialStore({ db, safeStorage, now: () => 100, uuid: () => ids.shift() })
    const installation = await store.getOrCreateInstallation({ deviceName: 'Workstation' })
    const old = await store.stageCandidate(credentials({ refreshToken: 'old-token' }))
    await store.promoteCandidate(old.id)
    const oldCurrent = store.readCurrent()
    const candidate = await store.stageCandidate(credentials({ refreshToken: 'next-token' }))
    const originalFlush = db.flush.bind(db)
    db.flush = () => false

    await assert.rejects(store.discardCandidate(candidate.id), { code: 'PERSISTENCE_PENDING' })
    assert.deepEqual(store.readCurrent(), oldCurrent)
    assert.deepEqual(db.getServerConnection('candidate'), candidate)
    await assert.rejects(store.promoteCandidate(candidate.id), { code: 'PERSISTENCE_PENDING' })

    db.flush = originalFlush
    assert.equal(await store.discardCandidate(candidate.id), true)
    assert.equal(db.getServerConnection('candidate'), null)
    assert.deepEqual(store.readCurrent(), oldCurrent)
    assert.deepEqual(db.getServerInstallation(), installation)
    assert.equal(await store.discardCandidate(candidate.id), false)
  })
})

test('discarding after disconnect is an idempotent no-op', async () => {
  await withStore(async ({ db }) => {
    const ids = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001']
    const store = new ServerCredentialStore({ db, safeStorage, uuid: () => ids.shift() })
    const candidate = await store.stageCandidate(credentials())
    await store.disconnect()
    assert.equal(await store.discardCandidate(candidate.id), false)
    assert.equal(db.getServerConnection('candidate'), null)
  })
})

test('candidate remains runtime-invisible until ciphertext flushes and promotion replaces current atomically', async () => {
  await withStore(async ({ db }) => {
    const ids = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001']
    const store = new ServerCredentialStore({ db, safeStorage, now: () => 100, uuid: () => ids.shift() })
    const old = await store.stageCandidate(credentials({ refreshToken: 'old-token' }))
    await store.promoteCandidate(old.id)
    const next = await store.stageCandidate(credentials({ refreshToken: 'next-token' }))

    assert.equal(store.readCurrent().id, old.id)
    assert.equal(db.getServerConnection('candidate').id, next.id)
    await store.promoteCandidate(next.id)
    assert.equal(store.readCurrent().id, next.id)
    assert.equal(store.readCurrent().connectionRevision, 2)
    assert.equal(db.getServerConnection('candidate'), null)
  })
})

test('refresh rotation never restores the old token when the new ciphertext cannot flush', async () => {
  await withStore(async ({ db }) => {
    const store = new ServerCredentialStore({ db, safeStorage, now: () => 100, uuid: () => '550e8400-e29b-41d4-a716-446655440000' })
    const candidate = await store.stageCandidate(credentials({ refreshToken: 'old-token' }))
    await store.promoteCandidate(candidate.id)
    db.flush = () => false

    await assert.rejects(store.replaceRefreshToken({
      connectionId: candidate.id, refreshToken: 'new-token', authorization: credentials().authorization
    }), { code: 'PERSISTENCE_PENDING' })
    assert.equal(store.decryptRefreshToken(store.readCurrent()), 'new-token')
    assert.equal(store.readCurrent().refreshTokenCiphertext, tokenCiphertext('new-token'))
  })
})

test('safe storage failures never persist plaintext tokens', async () => {
  await withStore(async ({ db, path }) => {
    const unavailable = new ServerCredentialStore({ db, safeStorage: { isEncryptionAvailable: () => false } })
    await assert.rejects(unavailable.stageCandidate(credentials()), { code: 'SECURE_STORAGE_UNAVAILABLE' })

    const encryptionFailure = new ServerCredentialStore({
      db,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('keychain failed') } }
    })
    await assert.rejects(encryptionFailure.stageCandidate(credentials()), { code: 'SERVER_CREDENTIAL_ENCRYPT_FAILED' })

    const store = new ServerCredentialStore({ db, safeStorage, uuid: () => '550e8400-e29b-41d4-a716-446655440000' })
    const candidate = await store.stageCandidate(credentials())
    assert.equal(JSON.stringify(db.sql.exec('SELECT * FROM server_connections')).includes('refresh-token-secret'), false)
    assert.equal(readFileSync(path).includes(Buffer.from('refresh-token-secret')), false)
    assert.throws(
      () => new ServerCredentialStore({
        db,
        safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('keychain failed') } }
      }).decryptRefreshToken(candidate),
      { code: 'SERVER_CREDENTIAL_DECRYPT_FAILED' }
    )
  })
})
