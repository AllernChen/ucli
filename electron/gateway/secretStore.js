function secureStorageError() {
  return Object.assign(new Error('Secure storage is unavailable'), {
    code: 'SECURE_STORAGE_UNAVAILABLE'
  })
}

export class SecretStore {
  constructor({ db, safeStorage }) {
    this.db = db
    this.safeStorage = safeStorage
  }

  _assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw secureStorageError()
    }
  }

  encryptSecret(plaintext) {
    this._assertAvailable()
    const value = Buffer.isBuffer(plaintext)
      ? plaintext.toString('utf8')
      : String(plaintext || '')
    if (!value) {
      throw Object.assign(new TypeError('Secret is required'), {
        code: 'INVALID_GATEWAY_SECRET'
      })
    }
    return this.safeStorage.encryptString(value).toString('base64')
  }

  decryptCiphertext(ciphertext) {
    this._assertAvailable()
    if (typeof ciphertext !== 'string' || !ciphertext) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch {
      throw Object.assign(new Error('Stored secret cannot be decrypted'), {
        code: 'GATEWAY_SECRET_DECRYPT_FAILED'
      })
    }
  }

  setSecret(key, plaintext) {
    const ciphertext = this.encryptSecret(plaintext)
    this.db.saveGatewaySecretCiphertext(key, ciphertext)
  }

  getSecret(key) {
    const ciphertext = this.db.getGatewaySecretCiphertext(key)
    return ciphertext ? this.decryptCiphertext(ciphertext) : null
  }

  hasSecret(key) {
    return Boolean(this.db.getGatewaySecretCiphertext(key))
  }
}
