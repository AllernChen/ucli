import { randomUUID } from 'node:crypto'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function credentialError(code, message) {
  return Object.assign(new Error(message), { code })
}

function persistencePendingError() {
  return credentialError('PERSISTENCE_PENDING', 'Server credential changes are pending persistence')
}

function ensureRefreshToken(refreshToken) {
  const value = Buffer.isBuffer(refreshToken) ? refreshToken.toString('utf8') : String(refreshToken ?? '')
  if (!value.trim()) throw credentialError('INVALID_REFRESH_TOKEN', 'Refresh token is required')
  return value
}

function serverOffsetMs(serverTime, receivedLocalTime) {
  const parsed = Date.parse(serverTime)
  return Number.isFinite(parsed) ? parsed - receivedLocalTime : 0
}

export class ServerCredentialStore {
  constructor({ db, safeStorage, now = Date.now, uuid = randomUUID }) {
    this.db = db
    this.safeStorage = safeStorage
    this.now = now
    this.uuid = uuid
    this.pendingInstallationId = null
    this.pendingCandidateIds = new Set()
    this.pendingPromotionId = null
  }

  isEncryptionAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.())
  }

  assertEncryptionAvailable() {
    if (!this.isEncryptionAvailable()) {
      throw credentialError('SECURE_STORAGE_UNAVAILABLE', 'Secure storage is unavailable')
    }
  }

  async getOrCreateInstallation({ deviceName }) {
    let installation = this.db.getServerInstallation()
    if (installation) {
      if (this.pendingInstallationId === installation.installationId) await this.flushOrThrow()
      this.pendingInstallationId = null
      return installation
    }

    const installationId = this.uuid()
    if (!UUID_V4.test(installationId)) {
      throw credentialError('INVALID_INSTALLATION_ID', 'Installation ID must be a UUID v4')
    }
    installation = {
      installationId,
      deviceName: String(deviceName ?? ''),
      createdAt: this.now()
    }
    await this.db.transaction(() => this.db.createServerInstallation(installation))
    this.pendingInstallationId = installationId
    await this.flushOrThrow()
    this.pendingInstallationId = null
    return installation
  }

  readCurrent() {
    if (this.pendingPromotionId) return null
    return this.db.getServerConnection('current')
  }

  decryptRefreshToken(connection) {
    if (!connection?.refreshTokenCiphertext) return null
    this.assertEncryptionAvailable()
    try {
      return this.safeStorage.decryptString(Buffer.from(connection.refreshTokenCiphertext, 'base64'))
    } catch {
      throw credentialError('SERVER_CREDENTIAL_DECRYPT_FAILED', 'Stored server credential cannot be decrypted')
    }
  }

  async stageCandidate({ serverOrigin, refreshToken, account, organization, authorization }) {
    const ciphertext = this.encryptRefreshToken(refreshToken)
    const receivedLocalTime = this.now()
    const record = {
      id: this.uuid(),
      slot: 'candidate',
      serverOrigin,
      refreshTokenCiphertext: ciphertext,
      accountId: account.id,
      accountDisplayName: account.displayName,
      organizationId: organization.id,
      organizationName: organization.name,
      authorizationExpiresAt: authorization.expiresAt,
      serverTime: authorization.serverTime,
      receivedLocalTime,
      serverOffsetMs: serverOffsetMs(authorization.serverTime, receivedLocalTime),
      lastSyncedAt: receivedLocalTime,
      connectionRevision: 0,
      degradedReason: null,
      reminderState: {}
    }
    this.pendingCandidateIds.add(record.id)
    await this.db.transaction(() => this.db.saveServerConnection(record))
    await this.flushOrThrow()
    this.pendingCandidateIds.delete(record.id)
    return this.db.getServerConnection('candidate')
  }

  async promoteCandidate(candidateId) {
    if (this.pendingCandidateIds.has(candidateId)) throw persistencePendingError()
    if (this.pendingPromotionId === candidateId) {
      await this.flushOrThrow()
      this.pendingPromotionId = null
      return this.db.getServerConnection('current')
    }

    const candidate = this.db.getServerConnection('candidate')
    if (!candidate || candidate.id !== candidateId) {
      throw credentialError('SERVER_CANDIDATE_NOT_FOUND', 'Candidate server connection was not found')
    }
    const current = this.db.getServerConnection('current')
    const nextRevision = (current?.connectionRevision || 0) + 1
    await this.db.transaction(() => this.db.promoteServerConnection({ candidateId, nextRevision }))
    this.pendingPromotionId = candidateId
    await this.flushOrThrow()
    this.pendingPromotionId = null
    return this.db.getServerConnection('current')
  }

  async replaceRefreshToken({ connectionId, refreshToken, authorization }) {
    const ciphertext = this.encryptRefreshToken(refreshToken)
    const receivedLocalTime = this.now()
    await this.db.transaction(() => {
      const updated = this.db.updateServerConnection(connectionId, {
        refreshTokenCiphertext: ciphertext,
        authorizationExpiresAt: authorization.expiresAt,
        serverTime: authorization.serverTime,
        receivedLocalTime,
        serverOffsetMs: serverOffsetMs(authorization.serverTime, receivedLocalTime),
        lastSyncedAt: receivedLocalTime
      })
      if (!updated) throw credentialError('SERVER_CONNECTION_NOT_FOUND', 'Server connection was not found')
    })
    await this.flushOrThrow()
    return this.db.getServerConnection('current')
  }

  async disconnect() {
    await this.db.transaction(() => this.db.clearServerConnections())
    this.pendingCandidateIds.clear()
    this.pendingPromotionId = null
    await this.flushOrThrow()
  }

  encryptRefreshToken(refreshToken) {
    const value = ensureRefreshToken(refreshToken)
    this.assertEncryptionAvailable()
    try {
      return this.safeStorage.encryptString(value).toString('base64')
    } catch {
      throw credentialError('SERVER_CREDENTIAL_ENCRYPT_FAILED', 'Server credential cannot be encrypted')
    }
  }

  async flushOrThrow() {
    try {
      const persisted = await this.db.flush()
      if (persisted !== true) throw persistencePendingError()
    } catch (error) {
      if (error?.code === 'PERSISTENCE_PENDING') throw error
      throw persistencePendingError()
    }
  }
}
