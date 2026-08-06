import assert from 'node:assert/strict'
import test from 'node:test'

import { ProfileSecretStore } from '../electron/aiCliProfiles/profileSecretStore.js'

function memoryDb() {
  const records = new Map()
  return {
    saveAiCliProfileSecretCiphertext(profileId, ciphertext, updatedAt) {
      records.set(profileId, { profileId, ciphertext, updatedAt })
    },
    getAiCliProfileSecretRecord(profileId) {
      return records.get(profileId) || null
    },
    deleteAiCliProfileSecret(profileId) {
      return records.delete(profileId)
    },
    getGatewaySecretCiphertext() {
      throw new Error('Profile store must not read Gateway secrets')
    },
    records
  }
}

function safeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}

test('ProfileSecretStore refuses empty secrets and plaintext fallback', () => {
  const unavailable = new ProfileSecretStore({
    db: memoryDb(),
    safeStorage: safeStorage(false),
    now: () => 100
  })
  assert.throws(
    () => unavailable.setSecret('profile-1', 'top-secret'),
    { code: 'SECURE_STORAGE_UNAVAILABLE' }
  )

  const available = new ProfileSecretStore({ db: memoryDb(), safeStorage: safeStorage() })
  assert.throws(() => available.setSecret('profile-1', ''), { code: 'INVALID_PROFILE_SECRET' })
  assert.throws(() => available.setSecret('profile-1', '   '), { code: 'INVALID_PROFILE_SECRET' })
})

test('ProfileSecretStore persists only base64 ciphertext and decrypts only on demand', () => {
  const db = memoryDb()
  const store = new ProfileSecretStore({ db, safeStorage: safeStorage(), now: () => 100 })

  store.setSecret('profile-1', 'top-secret-1234')

  assert.deepEqual(db.records.get('profile-1'), {
    profileId: 'profile-1',
    ciphertext: Buffer.from('encrypted:top-secret-1234').toString('base64'),
    updatedAt: 100
  })
  assert.equal(db.records.get('profile-1').ciphertext.includes('top-secret'), false)
  assert.equal(store.getSecret('profile-1'), 'top-secret-1234')
  assert.deepEqual(store.describeSecret('profile-1'), {
    hasSecret: true,
    secretSuffix: '1234',
    encryptionAvailable: true
  })
})

test('ProfileSecretStore describes missing and unavailable secrets without exposing ciphertext', () => {
  const db = memoryDb()
  const available = new ProfileSecretStore({ db, safeStorage: safeStorage() })
  assert.deepEqual(available.describeSecret('missing'), {
    hasSecret: false,
    secretSuffix: null,
    encryptionAvailable: true
  })

  db.records.set('profile-1', {
    profileId: 'profile-1',
    ciphertext: Buffer.from('encrypted:top-secret').toString('base64'),
    updatedAt: 100
  })
  const unavailable = new ProfileSecretStore({ db, safeStorage: safeStorage(false) })
  assert.deepEqual(unavailable.describeSecret('profile-1'), {
    hasSecret: true,
    secretSuffix: null,
    encryptionAvailable: false
  })
})

test('ProfileSecretStore maps decryption failures to a stable public error', () => {
  const db = memoryDb()
  db.records.set('profile-1', {
    profileId: 'profile-1',
    ciphertext: Buffer.from('invalid').toString('base64'),
    updatedAt: 100
  })
  const store = new ProfileSecretStore({
    db,
    safeStorage: {
      ...safeStorage(),
      decryptString() { throw new Error('OS keychain details') }
    }
  })

  assert.throws(
    () => store.getSecret('profile-1'),
    (error) => error.code === 'PROFILE_SECRET_DECRYPT_FAILED' && !error.message.includes('OS keychain')
  )
})

test('ProfileSecretStore deletes profile secrets independently', () => {
  const db = memoryDb()
  const store = new ProfileSecretStore({ db, safeStorage: safeStorage() })
  store.setSecret('profile-1', 'top-secret')

  assert.equal(store.deleteSecret('profile-1'), true)
  assert.equal(store.getSecret('profile-1'), null)
  assert.equal(store.deleteSecret('profile-1'), false)
})
