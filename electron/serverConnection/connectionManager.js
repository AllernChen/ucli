import { parseConnectionInput, sanitiseServerError, TARGET_CLIENT_VERSION } from './contracts.js'

const LOCAL_ERROR_MESSAGES = Object.freeze({
  SECURE_STORAGE_UNAVAILABLE: 'Secure storage is unavailable',
  PERSISTENCE_PENDING: 'Server credentials could not be saved',
  SERVER_CREDENTIAL_ENCRYPT_FAILED: 'Server credentials could not be encrypted',
  SERVER_CANDIDATE_NOT_FOUND: 'Server registration could not be completed',
  REGISTRATION_BUSY: 'Another registration is already in progress'
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
    this.redeemFlights = new Map()
    this.operationEpoch = 0
    this.invalidatedAttempts = new Set()
    this.connectionEpoch = 0
    this.credentialMutation = Promise.resolve()
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
    const existing = this.redeemFlights.get(attemptId)
    if (existing) return existing
    if (this.redeemFlights.size) {
      return Promise.reject(operationError(Object.assign(new Error(), { code: 'REGISTRATION_BUSY' })))
    }
    const flight = this.confirmOnce(attemptId).finally(() => this.redeemFlights.delete(attemptId))
    this.redeemFlights.set(attemptId, flight)
    return flight
  }

  retryRedeem(attemptId) {
    return this.confirm(attemptId)
  }

  async confirmOnce(attemptId) {
    const attempt = this.attempts.getPublic(attemptId)
    if (!attempt || !canConfirm(attempt.preview) || !this.attempts.beginRedeem(attemptId)) {
      throw operationError(Object.assign(new Error(), { code: 'invalid_link' }))
    }
    const operationEpoch = this.operationEpoch

    try {
      this.credentials.assertEncryptionAvailable?.()
      const installation = await this.credentials.getOrCreateInstallation({ deviceName: this.deviceName })
      this.assertActiveAttempt(attemptId, operationEpoch)
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
      const promoted = await this.runCredentialMutation(async () => {
        this.assertActiveAttempt(attemptId, operationEpoch)
        const candidate = await this.credentials.stageCandidate({
          serverOrigin: attempt.serverOrigin,
          refreshToken: redeemed.refreshToken,
          account: redeemed.account,
          organization: redeemed.organization,
          authorization: redeemed.authorization
        })
        if (!this.isActiveAttempt(attemptId, operationEpoch)) {
          await this.credentials.discardCandidate?.(candidate.id)
          this.assertActiveAttempt(attemptId, operationEpoch)
        }
        const previousRevision = this.current?.connectionRevision ?? null
        this.assertActiveAttempt(attemptId, operationEpoch)
        const connection = await this.credentials.promoteCandidate(candidate.id)
        this.assertActiveAttempt(attemptId, operationEpoch)
        this.current = connection
        this.status = 'connected'
        this.connectionEpoch += 1
        this.attempts.finish(attemptId)
        if (previousRevision !== null) this.revokeRuntimeRevision(previousRevision)
        this.emitState()
        return connection
      })
      await this.bootstrapAfterPromotion(promoted, redeemed.accessToken, this.connectionEpoch)
      return this.getState()
    } catch (error) {
      this.attempts.markRedeemAmbiguous(attemptId)
      throw operationError(error)
    }
  }

  async bootstrapAfterPromotion(connection, accessToken, connectionEpoch) {
    if (typeof this.bootstrap !== 'function') return
    try {
      await this.bootstrap({ serverOrigin: connection.serverOrigin, accessToken })
    } catch {
      if (!this.isCurrentConnection(connection, connectionEpoch)) return
      this.status = 'unreachable'
      this.emitState()
    }
  }

  cancel(attemptId) {
    const cancelled = this.attempts.cancel(attemptId)
    if (cancelled) this.invalidatedAttempts.add(attemptId)
    return cancelled
  }

  async disconnect() {
    this.operationEpoch += 1
    try {
      await this.runCredentialMutation(async () => {
        const previousRevision = this.current?.connectionRevision ?? null
        await this.credentials.disconnect()
        this.current = null
        this.status = 'disconnected'
        this.connectionEpoch += 1
        if (previousRevision !== null) this.revokeRuntimeRevision(previousRevision)
        this.emitState()
      })
    } catch (error) {
      throw operationError(error)
    }
  }

  retry() { return this.getState() }
  sync() { return this.getState() }
  listModels() { return [] }
  listSkills() { return [] }

  isActiveAttempt(attemptId, epoch) {
    return this.operationEpoch === epoch && !this.invalidatedAttempts.has(attemptId) &&
      this.attempts.getSecret(attemptId) !== null
  }

  assertActiveAttempt(attemptId, epoch) {
    if (!this.isActiveAttempt(attemptId, epoch)) {
      throw Object.assign(new Error(), { code: 'invalid_link' })
    }
  }

  isCurrentConnection(connection, epoch) {
    return this.connectionEpoch === epoch &&
      this.current?.id === connection.id &&
      this.current?.connectionRevision === connection.connectionRevision
  }

  runCredentialMutation(work) {
    const mutation = this.credentialMutation.then(work, work)
    this.credentialMutation = mutation.catch(() => {})
    return mutation
  }
}
