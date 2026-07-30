import assert from 'node:assert/strict'
import test from 'node:test'

import { SecretStore } from '../electron/gateway/secretStore.js'

function memoryDb() {
  const values = new Map()
  return {
    getGatewaySecretCiphertext: (key) => values.get(key) || null,
    saveGatewaySecretCiphertext: (key, value) => values.set(key, value),
    values
  }
}

function safeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}

test('SecretStore refuses plaintext fallback when OS encryption is unavailable', () => {
  const store = new SecretStore({ db: memoryDb(), safeStorage: safeStorage(false) })
  assert.throws(
    () => store.setSecret('gateway.feishu.appSecret', 'top-secret'),
    { code: 'SECURE_STORAGE_UNAVAILABLE' }
  )
})

test('SecretStore persists only base64 ciphertext and decrypts in the main process', () => {
  const db = memoryDb()
  const store = new SecretStore({ db, safeStorage: safeStorage() })

  store.setSecret('gateway.feishu.appSecret', 'top-secret')

  const ciphertext = db.values.get('gateway.feishu.appSecret')
  assert.equal(ciphertext, Buffer.from('encrypted:top-secret').toString('base64'))
  assert.equal(ciphertext.includes('top-secret'), false)
  assert.equal(store.getSecret('gateway.feishu.appSecret'), 'top-secret')
})
