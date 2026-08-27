import { parseConnectionInput, sanitiseServerError, TARGET_CLIENT_VERSION } from './contracts.js'

const LOCAL_ERROR_MESSAGES = Object.freeze({
  SECURE_STORAGE_UNAVAILABLE: 'Secure storage is unavailable',
  PERSISTENCE_PENDING: 'Server credentials could not be saved',
  SERVER_CREDENTIAL_ENCRYPT_FAILED: 'Server credentials could not be encrypted',
  SERVER_CANDIDATE_NOT_FOUND: 'Server registration could not be completed'
})

function publicConnection(connection) {
  if (!connection) return null
  return {
    id: connection.id,
    serverOrigin: connection.serverOrigin,
    account: { id: connection.accountId, displayName: connection.accountDisplayName },
    organization: { id: connection.organizationId, name: connection.organizationName },
    authorization: {
      expiresAt: connection.authorizationExpiresAt,
      serverTime: connection.serverTime
    },
    connectionRevision: connection.connectionRevision
  }
}

function operationError(error) {
  if (LOCAL_ERROR_MESSAGES[error?.code]) {
    return Object.assign(new Error(LOCAL_ERROR_MESSAGES[error.code]), {
      code: error.code,
      retryable: error.code === 'PERSISTENCE_PENDING'
    })
  }
  const safe = sanitiseServerError(error)
  return Object.assign(new Error(safe.message), safe)
}

function canConfirm(preview) {
  return preview?.link?.status === 'AVAILABLE' && preview?.authorization?.status === 'AVAILABLE'
}

/** Registration-only connection owner. Refresh and ongoing Bootstrap lifecycle
 * are intentionally added by the following task. */
export class ConnectionManager {
  constructor({
    attempts,
    client,
    credentials,
    platform,
    deviceName,
    clientVersion = TARGET_CLIENT_VERSION,
    bootstrap = null,
    revokeRuntimeRevision = () => {}
  } = {}) {
    if (!attempts || !client || !credentials) throw new TypeError('Registration dependencies are required')
    this.attempts = attempts
    this.client = client
    this.credentials = credentials
    this.platform = platform
    this.deviceName = deviceName
    this.clientVersion = clientVersion
    this.bootstrap = bootstrap || client.bootstrap
    this.revokeRuntimeRevision = revokeRuntimeRevision
    this.current = credentials.readCurrent?.() || null
    this.status = this.current ? 'connected' : 'disconnected'
    this.listeners = new Set()
    this.registrationListeners = new Set()
    this.redeemFlight = null
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRegistrationRequested(listener) {
    this.registrationListeners.add(listener)
    return () => this.registrationListeners.delete(listener)
  }

  getState() {
    return { status: this.status, connection: publicConnection(this.current) }
  }

  emitState() {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  submitLink(input) {
    return this.submitParsedConnection(parseConnectionInput(input))
  }

  async submitParsedConnection({ serverOrigin, linkSecret }) {
    const attempt = this.attempts.create({ serverOrigin, linkSecret })
    try {
      const preview = await this.client.preview({ serverOrigin, linkSecret })
      const publicAttempt = this.attempts.markPreview(attempt.attemptId, preview)
      if (!publicAttempt) throw Object.assign(new Error('Registration attempt was not found'), { code: 'invalid_link' })
      for (const listener of this.registrationListeners) listener(publicAttempt)
      return publicAttempt
    } catch (error) {
      throw operationError(error)
    }
  }

  getAttempt(attemptId) {
    return this.attempts.getPublic(attemptId)
  }

  confirm(attemptId) {
    if (this.redeemFlight) return this.redeemFlight
    const flight = this.confirmOnce(attemptId)
    this.redeemFlight = flight
    return flight.finally(() => {
      if (this.redeemFlight === flight) this.redeemFlight = null
    })
  }

  retryRedeem(attemptId) {
    return this.confirm(attemptId)
  }

  async confirmOnce(attemptId) {
    const attempt = this.attempts.getPublic(attemptId)
    if (!attempt || !canConfirm(attempt.preview) || !this.attempts.beginRedeem(attemptId)) {
      throw operationError(Object.assign(new Error(), { code: 'invalid_link' }))
    }

    try {
      this.credentials.assertEncryptionAvailable?.()
      const installation = await this.credentials.getOrCreateInstallation({ deviceName: this.deviceName })
      const linkSecret = this.attempts.getSecret(attemptId)
      if (!linkSecret) throw Object.assign(new Error(), { code: 'invalid_link' })
      const redeemed = await this.client.redeem({
        serverOrigin: attempt.serverOrigin,
        linkSecret,
        device: {
          installationId: installation.installationId,
          name: installation.deviceName || this.deviceName,
          platform: this.platform,
          clientVersion: this.clientVersion
        }
      })
      const candidate = await this.credentials.stageCandidate({
        serverOrigin: attempt.serverOrigin,
        refreshToken: redeemed.refreshToken,
        account: redeemed.account,
        organization: redeemed.organization,
        authorization: redeemed.authorization
      })
      const previousRevision = this.current?.connectionRevision ?? null
      const promoted = await this.credentials.promoteCandidate(candidate.id)
      this.current = promoted
      this.status = 'connected'
      this.attempts.finish(attemptId)
      if (previousRevision !== null) this.revokeRuntimeRevision(previousRevision)
      this.emitState()
      await this.bootstrapAfterPromotion(promoted, redeemed.accessToken)
      return this.getState()
    } catch (error) {
      this.attempts.markRedeemAmbiguous(attemptId)
      throw operationError(error)
    }
  }

  async bootstrapAfterPromotion(connection, accessToken) {
    if (typeof this.bootstrap !== 'function') return
    try {
      await this.bootstrap({ serverOrigin: connection.serverOrigin, accessToken })
    } catch {
      this.status = 'unreachable'
      this.emitState()
    }
  }

  cancel(attemptId) {
    return this.attempts.cancel(attemptId)
  }

  async disconnect() {
    const previousRevision = this.current?.connectionRevision ?? null
    try {
      await this.credentials.disconnect()
      this.current = null
      this.status = 'disconnected'
      if (previousRevision !== null) this.revokeRuntimeRevision(previousRevision)
      this.emitState()
    } catch (error) {
      throw operationError(error)
    }
  }

  retry() { return this.getState() }
  sync() { return this.getState() }
  listModels() { return [] }
  listSkills() { return [] }
}
