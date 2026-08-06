function secureStorageError() {
  return Object.assign(new Error('Secure storage is unavailable'), {
    code: 'SECURE_STORAGE_UNAVAILABLE'
  })
}

function invalidSecretError() {
  return Object.assign(new TypeError('Profile secret is required'), {
    code: 'INVALID_PROFILE_SECRET'
  })
}

function decryptionError() {
  return Object.assign(new Error('Stored profile secret cannot be decrypted'), {
    code: 'PROFILE_SECRET_DECRYPT_FAILED'
  })
}

export class ProfileSecretStore {
  constructor({ db, safeStorage, now = Date.now }) {
    this.db = db
    this.safeStorage = safeStorage
    this.now = now
  }

  isEncryptionAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.())
  }

  assertEncryptionAvailable() {
    if (!this.isEncryptionAvailable()) throw secureStorageError()
  }

  setSecret(profileId, plaintext) {
    const value = Buffer.isBuffer(plaintext)
      ? plaintext.toString('utf8')
      : String(plaintext ?? '')
    if (!value.trim()) throw invalidSecretError()
    this.assertEncryptionAvailable()

    const ciphertext = this.safeStorage.encryptString(value).toString('base64')
    this.db.saveAiCliProfileSecretCiphertext(profileId, ciphertext, this.now())
  }

  getSecret(profileId) {
    const record = this.db.getAiCliProfileSecretRecord(profileId)
    if (!record) return null
    this.assertEncryptionAvailable()
    try {
      return this.safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64'))
    } catch {
      throw decryptionError()
    }
  }

  deleteSecret(profileId) {
    return this.db.deleteAiCliProfileSecret(profileId)
  }

  describeSecret(profileId) {
    const record = this.db.getAiCliProfileSecretRecord(profileId)
    const encryptionAvailable = this.isEncryptionAvailable()
    if (!record) {
      return { hasSecret: false, secretSuffix: null, encryptionAvailable }
    }
    if (!encryptionAvailable) {
      return { hasSecret: true, secretSuffix: null, encryptionAvailable: false }
    }

    const secret = this.getSecret(profileId)
    return {
      hasSecret: true,
      secretSuffix: secret.slice(-4),
      encryptionAvailable: true
    }
  }
}
