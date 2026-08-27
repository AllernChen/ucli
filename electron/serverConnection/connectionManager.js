import { parseConnectionInput, sanitiseServerError, TARGET_CLIENT_VERSION } from './contracts.js'
import { DAY_MS, ExpiryReminder, THRESHOLDS } from './expiryReminder.js'

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

function runtimeConnectionIdentity(connection) {
  if (!connection) return null
  return Object.freeze({ connectionId: connection.id, connectionRevision: connection.connectionRevision })
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
    revokeRuntimeRevision = () => {},
    reminder = new ExpiryReminder(),
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    jitter = delay => delay
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
    this.reminder = reminder
    this.timers = timers
    this.now = now
    this.jitter = jitter
    this.current = credentials.readCurrent?.() || null
    this.status = this.current ? 'connected' : 'disconnected'
    this.reason = null
    this.stateRevision = 0
    this.listeners = new Set()
    this.registrationListeners = new Set()
    this.redeemFlights = new Map()
    this.previewFlights = new Map()
    this.committingAttempts = new Set()
    this.operationEpoch = 0
    this.currentOperationEpoch = this.operationEpoch
    this.invalidatedAttempts = new Set()
    this.pendingRevocations = new Set()
    this.connectionEpoch = 0
    this.credentialMutation = Promise.resolve()
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    this.refreshFlight = null
    this.bootstrapCache = null
    this.bootstrapFlight = null
    this.persistencePending = null
    this.pendingDisconnect = null
    this.retryTimer = null
    this.accessRefreshTimer = null
    this.expiryTimer = null
    this.retryIndex = 0
    this.shuttingDown = false
    if (credentials.isPersistencePending?.()) {
      this.persistencePending = { connection: this.current, connectionEpoch: this.connectionEpoch, shared: true }
      this.status = 'unreachable'
      this.reason = 'PERSISTENCE_PENDING'
    }
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
    const connection = publicConnection(this.current)
    return {
      revision: this.stateRevision,
      status: this.status,
      reason: this.reason,
      serverOrigin: connection?.serverOrigin || null,
      account: connection?.account || null,
      organization: connection?.organization || null,
      authorizationExpiresAt: connection?.authorization?.expiresAt || null,
      lastSyncedAt: this.current?.lastSyncedAt || null,
      retryable: this.status === 'unreachable' || this.status === 'connecting',
      // Kept for the Task 4 IPC bridge; it contains only sanitized metadata.
      connection
    }
  }

  emitState() {
    this.stateRevision += 1
    const state = this.getState()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* state subscribers are isolated */ }
    }
  }

  submitLink(input) {
    this.assertNotShuttingDown()
    return this.submitParsedConnection(parseConnectionInput(input))
  }

  async submitParsedConnection({ serverOrigin, linkSecret }) {
    this.assertNotShuttingDown()
    const attempt = this.attempts.create({ serverOrigin, linkSecret })
    const generation = this.operationEpoch
    const flight = this.previewOnce(attempt, generation)
    this.previewFlights.set(attempt.attemptId, flight)
    try { return await flight } finally { this.previewFlights.delete(attempt.attemptId) }
  }

  async previewOnce(attempt, generation) {
    try {
      const preview = await this.client.preview({ serverOrigin: attempt.serverOrigin, linkSecret: this.attempts.getSecret(attempt.attemptId) })
      this.assertActiveAttempt(attempt.attemptId, generation)
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
    this.assertNotShuttingDown()
    const existing = this.redeemFlights.get(attemptId)
    if (existing) return existing
    if (this.redeemFlights.size) {
      return Promise.reject(operationError(Object.assign(new Error(), { code: 'REGISTRATION_BUSY' })))
    }
    const flight = this.confirmOnce(attemptId).finally(() => {
      this.redeemFlights.delete(attemptId)
      this.invalidatedAttempts.delete(attemptId)
      this.committingAttempts.delete(attemptId)
    })
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
      this.assertLifecycleAvailable()
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
      this.assertLifecycleAvailable()
      const promotion = await this.runCredentialMutation(async () => {
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
        const previousRuntimeIdentity = runtimeConnectionIdentity(this.current)
        this.assertActiveAttempt(attemptId, operationEpoch)
        this.committingAttempts.add(attemptId)
        let connection
        try {
          connection = await this.credentials.promoteCandidate(candidate.id)
        } finally {
          this.committingAttempts.delete(attemptId)
        }
        // Promotion is the Task 4 non-cancellable commit point. A shutdown or
        // cancellation observed after it must not roll back durable current.
        this.current = connection
        this.currentOperationEpoch = operationEpoch
        this.status = 'connected'
        this.connectionEpoch += 1
        this.attempts.finish(attemptId)
        return { connection, previousRuntimeIdentity, connectionEpoch: this.connectionEpoch }
      })
      if (promotion.previousRuntimeIdentity && this.operationEpoch === operationEpoch) {
        await this.revokeRevision(promotion.previousRuntimeIdentity)
      }
      this.emitState()
      await this.bootstrapAfterPromotion(promotion.connection, redeemed, promotion.connectionEpoch)
      return this.getState()
    } catch (error) {
      this.attempts.markRedeemAmbiguous(attemptId)
      throw operationError(error)
    }
  }

  async bootstrapAfterPromotion(connection, redeemed, connectionEpoch) {
    if (!this.isCurrentConnection(connection, connectionEpoch)) return
    this.installAccessToken(redeemed.accessToken, redeemed.expiresIn)
    try { await this.bootstrapWithAccessToken({ connection, connectionEpoch }) }
    catch (error) {
      if (!this.isCurrentConnection(connection, connectionEpoch)) return
      await this.handleLifecycleError(error)
    }
  }

  async start() {
    if (this.shuttingDown || !this.current) return this.getState()
    if (this.persistencePending || this.credentials.isPersistencePending?.()) {
      if (!this.persistencePending) this.enterPersistencePending({ connection: this.current, connectionEpoch: this.connectionEpoch, shared: true })
      try { return await this.retry() } catch { return this.getState() }
    }
    try {
      await this.refreshAndBootstrap()
    } catch { /* state and retry policy are established by lifecycle handling */ }
    return this.getState()
  }

  async getAccessToken({ minValidityMs = 60_000 } = {}) {
    this.assertLifecycleAvailable()
    if (this.accessToken && this.accessTokenExpiresAt - this.now() >= minValidityMs) return this.accessToken
    return this.refreshAccessToken()
  }

  getRuntimeConnectionIdentity() {
    if (this.shuttingDown || !['connected', 'expiring'].includes(this.status)) return null
    return runtimeConnectionIdentity(this.current)
  }

  async getBootstrap({ force = false } = {}) {
    this.assertLifecycleAvailable()
    const connection = this.current
    if (!connection) throw Object.assign(new Error('Server connection is unavailable'), { code: 'invalid_grant' })
    if (!force && this.bootstrapCache && this.bootstrapCache.connectionId === connection.id &&
      this.bootstrapCache.connectionRevision === connection.connectionRevision &&
      this.bootstrapCache.connectionEpoch === this.connectionEpoch) return this.bootstrapCache.value
    const accessToken = await this.getAccessToken()
    return this.bootstrapWithAccessToken({ connection, connectionEpoch: this.connectionEpoch, accessToken })
  }

  async refreshAndBootstrap() {
    await this.getAccessToken({ minValidityMs: Number.MAX_SAFE_INTEGER })
    return this.getBootstrap()
  }

  refreshAccessToken() {
    const connection = this.current
    const connectionEpoch = this.connectionEpoch
    const key = this.lifecycleKey(connection, connectionEpoch)
    if (this.refreshFlight?.key === key) return this.refreshFlight.promise
    const flight = this.refreshAccessTokenOnce().finally(() => {
      if (this.refreshFlight?.promise === flight) this.refreshFlight = null
    })
    this.refreshFlight = { key, promise: flight }
    return flight
  }

  async refreshAccessTokenOnce() {
    this.assertLifecycleAvailable()
    const connection = this.current
    const connectionEpoch = this.connectionEpoch
    if (!connection) throw Object.assign(new Error('Server connection is unavailable'), { code: 'invalid_grant' })
    this.setRuntimeStatus('connecting', null)
    try {
      const refreshToken = this.credentials.decryptRefreshToken(connection)
      if (!refreshToken) throw Object.assign(new Error('Stored server credential is unavailable'), { code: 'invalid_grant' })
      const refreshed = await this.client.refresh({ serverOrigin: connection.serverOrigin, refreshToken })
      this.assertLifecycleAvailable()
      if (!this.isCurrentConnection(connection, connectionEpoch)) throw Object.assign(new Error(), { code: 'STALE_CONNECTION_OPERATION' })
      // From this point the old token is single-use and must never be sent.
      this.persistencePending = {
        connection, connectionEpoch, refreshed,
        accessTokenExpiresAt: this.now() + refreshed.expiresIn * 1000
      }
      let updated
      try {
        updated = await this.runCredentialMutation(() => this.credentials.replaceRefreshToken({
          connectionId: connection.id,
          refreshToken: refreshed.refreshToken,
          authorization: refreshed.authorization
        }))
      } catch (error) {
        if (error?.code === 'PERSISTENCE_PENDING') {
          this.enterPersistencePending(this.persistencePending)
          throw error
        }
        throw error
      }
      if (!this.isCurrentConnection(connection, connectionEpoch)) throw Object.assign(new Error(), { code: 'STALE_CONNECTION_OPERATION' })
      this.persistencePending = null
      this.current = updated || this.current
      this.installAccessToken(refreshed.accessToken, refreshed.expiresIn)
      await this.updateAuthorizationState(refreshed.authorization, { connection: this.current, connectionEpoch })
      this.retryIndex = 0
      return this.accessToken
    } catch (error) {
      if (!this.isCurrentConnection(connection, connectionEpoch) && this.persistencePending?.connection === connection) {
        this.persistencePending = null
      }
      if (error?.code !== 'STALE_CONNECTION_OPERATION') await this.handleLifecycleError(error)
      throw operationError(error)
    }
  }

  async bootstrapWithAccessToken({ connection = this.current, connectionEpoch = this.connectionEpoch, accessToken = this.accessToken } = {}) {
    const key = this.lifecycleKey(connection, connectionEpoch)
    if (this.bootstrapFlight?.key === key) return this.bootstrapFlight.promise
    if (typeof this.bootstrap !== 'function') return null
    const flight = (async () => {
      this.assertLifecycleAvailable()
      this.setRuntimeStatus('connecting', null)
      try {
        const value = await this.bootstrap({ serverOrigin: connection.serverOrigin, accessToken })
        this.assertLifecycleAvailable()
        if (!this.isCurrentConnection(connection, connectionEpoch)) return null
        this.bootstrapCache = { value, connectionId: connection.id, connectionRevision: connection.connectionRevision, connectionEpoch }
        await this.updateAuthorizationState(value.authorization, { connection, connectionEpoch })
        this.retryIndex = 0
        return value
      } catch (error) {
        if (!this.isCurrentConnection(connection, connectionEpoch)) return null
        await this.handleLifecycleError(error)
        throw operationError(error)
      }
    })().finally(() => {
      if (this.bootstrapFlight?.promise === flight) this.bootstrapFlight = null
    })
    this.bootstrapFlight = { key, promise: flight }
    return flight
  }

  installAccessToken(accessToken, expiresInSeconds, accessTokenExpiresAt = null) {
    this.accessToken = accessToken
    this.accessTokenExpiresAt = accessTokenExpiresAt ?? (this.now() + expiresInSeconds * 1000)
    if (this.accessRefreshTimer) this.timers.clearTimeout(this.accessRefreshTimer)
    const delay = Math.max(0, this.accessTokenExpiresAt - this.now() - 60_000 + 1)
    this.accessRefreshTimer = this.timers.setTimeout(async () => {
      this.accessRefreshTimer = null
      try { await this.getAccessToken() } catch { /* normal lifecycle error handling owns recovery */ }
    }, delay)
    this.accessRefreshTimer?.unref?.()
  }

  async updateAuthorizationState(authorization, { connection = this.current, connectionEpoch = this.connectionEpoch } = {}) {
    if (!connection || !authorization || !this.isCurrentConnection(connection, connectionEpoch)) return false
    const receivedLocalTime = this.now()
    const reminderState = this.reminder.evaluate({
      authorizationExpiresAt: authorization.expiresAt,
      serverTime: authorization.serverTime,
      receivedLocalTime,
      reminderState: connection.reminderState || {}
    })
    const nextConnection = {
      ...connection,
      authorizationExpiresAt: authorization.expiresAt,
      serverTime: authorization.serverTime,
      serverOffsetMs: Date.parse(authorization.serverTime) - receivedLocalTime,
      receivedLocalTime,
      lastSyncedAt: receivedLocalTime,
      reminderState
    }
    if (!this.isCurrentConnection(connection, connectionEpoch)) return false
    this.current = nextConnection
    if (this.credentials.updateConnectionMetadata) {
      let persisted
      try {
        persisted = await this.runCredentialMutation(async () => {
          if (!this.isCurrentConnection(connection, connectionEpoch) || this.shuttingDown) return null
          return this.credentials.updateConnectionMetadata({ connectionId: connection.id, authorization, reminderState })
        })
      } catch (error) {
        if (error?.code === 'PERSISTENCE_PENDING') {
          this.enterPersistencePending({ connection, connectionEpoch, authorization, accessToken: this.accessToken, accessTokenExpiresAt: this.accessTokenExpiresAt })
        }
        throw error
      }
      if (!this.isCurrentConnection(connection, connectionEpoch)) return false
      this.current = persisted || this.current
    }
    const remaining = authorization.expiresAt === null ? Infinity : Date.parse(authorization.expiresAt) - (this.now() + this.current.serverOffsetMs)
    this.setRuntimeStatus(remaining <= 7 * 24 * 60 * 60 * 1000 ? 'expiring' : 'connected', null)
    this.scheduleExpiryReminder(authorization, connection, connectionEpoch)
    return true
  }

  scheduleExpiryReminder(authorization, connection, connectionEpoch) {
    if (this.expiryTimer) this.timers.clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    if (!authorization.expiresAt || !this.isCurrentConnection(connection, connectionEpoch)) return
    const remaining = Date.parse(authorization.expiresAt) - (this.now() + this.current.serverOffsetMs)
    const crossed = new Set(this.current.reminderState?.crossedThresholds || [])
    const next = THRESHOLDS.find(days => remaining > days * DAY_MS && !crossed.has(days))
    if (next === undefined) return
    this.expiryTimer = this.timers.setTimeout(async () => {
      this.expiryTimer = null
      await this.reevaluateReminder({ connection: this.current, connectionEpoch }).catch(() => {})
    }, Math.max(0, remaining - next * DAY_MS + 1))
    this.expiryTimer?.unref?.()
  }

  async reevaluateReminder({ connection = this.current, connectionEpoch = this.connectionEpoch } = {}) {
    if (!connection || !this.isCurrentConnection(connection, connectionEpoch)) return false
    const authorization = {
      expiresAt: connection.authorizationExpiresAt,
      serverTime: connection.serverTime
    }
    const reminderState = this.reminder.evaluate({
      authorizationExpiresAt: authorization.expiresAt,
      serverTime: authorization.serverTime,
      receivedLocalTime: connection.receivedLocalTime,
      reminderState: connection.reminderState || {}
    })
    const nextConnection = { ...connection, reminderState }
    this.current = nextConnection
    if (this.credentials.updateConnectionMetadata) {
      const persisted = await this.runCredentialMutation(() => {
        if (!this.isCurrentConnection(connection, connectionEpoch) || this.shuttingDown) return null
        return this.credentials.updateConnectionMetadata({
          connectionId: connection.id,
          reminderState,
          reminderOnly: true
        })
      })
      if (!this.isCurrentConnection(connection, connectionEpoch)) return false
      this.current = persisted || this.current
    }
    const remaining = authorization.expiresAt === null ? Infinity : Date.parse(authorization.expiresAt) - (this.now() + this.current.serverOffsetMs)
    this.setRuntimeStatus(remaining <= 7 * DAY_MS ? 'expiring' : 'connected', null)
    this.scheduleExpiryReminder(authorization, this.current, connectionEpoch)
    return true
  }

  async handleLifecycleError(error) {
    const code = error?.code
    if (['invalid_grant', 'grant_deleted', 'invalid_device'].includes(code)) {
      const previousRuntimeIdentity = this.invalidateRuntimeConnection()
      if (previousRuntimeIdentity) await this.revokeRevision(previousRuntimeIdentity)
      try {
        await this.runCredentialMutation(() => this.credentials.disconnect())
      } catch (disconnectError) {
        if (disconnectError?.code === 'PERSISTENCE_PENDING') {
          this.pendingDisconnect = true
          this.scheduleRetry()
        }
        throw disconnectError
      }
      return
    }
    const disabledStatus = {
      grant_disabled: 'disabled', grant_expired: 'expired', account_inactive: 'account_inactive', organization_inactive: 'org_inactive'
    }[code]
    if (disabledStatus) {
      this.accessToken = null
      this.accessTokenExpiresAt = 0
      this.bootstrapCache = null
      this.setRuntimeStatus(disabledStatus, code)
      this.scheduleRetry(15 * 60_000)
      return
    }
    if (code === 'PERSISTENCE_PENDING') return
    this.setRuntimeStatus('unreachable', null)
    if (error?.retryable) this.scheduleRetry()
  }

  setRuntimeStatus(status, reason) {
    if (this.status === status && this.reason === reason) return
    this.status = status
    this.reason = reason
    this.emitState()
  }

  scheduleRetry(delay) {
    if (this.shuttingDown || this.retryTimer) return
    const backoff = delay ?? [30_000, 60_000, 120_000, 300_000, 900_000][Math.min(this.retryIndex++, 4)]
    this.retryTimer = this.timers.setTimeout(async () => {
      this.retryTimer = null
      try { await this.retry() } catch { /* retry scheduling happens in lifecycle handling */ }
    }, Math.max(0, this.jitter(backoff)))
    this.retryTimer?.unref?.()
  }

  rescheduleRetry() {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.scheduleRetry()
  }

  clearOwnedTimers() {
    for (const key of ['retryTimer', 'accessRefreshTimer', 'expiryTimer']) {
      if (this[key]) this.timers.clearTimeout(this[key])
      this[key] = null
    }
  }

  invalidateRuntimeConnection() {
    const identity = runtimeConnectionIdentity(this.current)
    this.current = null
    this.connectionEpoch += 1
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    if (this.accessRefreshTimer) this.timers.clearTimeout(this.accessRefreshTimer)
    if (this.expiryTimer) this.timers.clearTimeout(this.expiryTimer)
    this.accessRefreshTimer = null
    this.expiryTimer = null
    this.bootstrapCache = null
    this.persistencePending = null
    this.status = 'disconnected'
    this.reason = null
    this.emitState()
    return identity
  }

  async finalizeDisconnect(disconnectEpoch) {
    if (!this.current || this.currentOperationEpoch >= disconnectEpoch) return false
    const lateRuntimeIdentity = this.invalidateRuntimeConnection()
    if (lateRuntimeIdentity) await this.revokeRevision(lateRuntimeIdentity)
    return true
  }

  assertLifecycleAvailable() {
    if (this.shuttingDown) throw Object.assign(new Error('Server connection is shutting down'), { code: 'SERVER_CONNECTION_SHUTDOWN' })
    if (this.credentials.isPersistencePending?.() && !this.persistencePending) {
      this.enterPersistencePending({ connection: this.current, connectionEpoch: this.connectionEpoch, shared: true })
    }
    if (this.persistencePending) throw Object.assign(new Error('Server credentials could not be saved'), { code: 'PERSISTENCE_PENDING' })
  }

  assertNotShuttingDown() {
    if (this.shuttingDown) throw Object.assign(new Error('Server connection is shutting down'), { code: 'SERVER_CONNECTION_SHUTDOWN' })
  }

  enterPersistencePending(pending) {
    this.persistencePending = pending
    if (this.accessRefreshTimer) this.timers.clearTimeout(this.accessRefreshTimer)
    this.accessRefreshTimer = null
    this.setRuntimeStatus('unreachable', 'PERSISTENCE_PENDING')
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.scheduleRetry()
  }

  lifecycleKey(connection, connectionEpoch) {
    return connection ? `${connection.id}:${connection.connectionRevision}:${connectionEpoch}` : `none:${connectionEpoch}`
  }

  cancel(attemptId) {
    if (this.committingAttempts.has(attemptId)) return false
    const cancelled = this.attempts.cancel(attemptId)
    if (cancelled && this.redeemFlights.has(attemptId)) this.invalidatedAttempts.add(attemptId)
    return cancelled
  }

  async disconnect() {
    this.operationEpoch += 1
    const disconnectEpoch = this.operationEpoch
    const previousRuntimeIdentity = this.invalidateRuntimeConnection()
    if (previousRuntimeIdentity) await this.revokeRevision(previousRuntimeIdentity)
    try {
      await this.runCredentialMutation(() => this.credentials.disconnect())
      await this.finalizeDisconnect(disconnectEpoch)
      this.pendingDisconnect = null
    } catch (error) {
      if (error?.code === 'PERSISTENCE_PENDING') {
        this.pendingDisconnect = { disconnectEpoch }
        this.scheduleRetry()
      }
      await this.finalizeDisconnect(disconnectEpoch)
      throw operationError(error)
    }
  }

  async retry() {
    if (this.shuttingDown) throw Object.assign(new Error('Server connection is shutting down'), { code: 'SERVER_CONNECTION_SHUTDOWN' })
    await this.retryPendingRevocations()
    if (this.pendingDisconnect) {
      try {
        const pendingDisconnect = this.pendingDisconnect
        await this.runCredentialMutation(async () => {
          if (this.credentials.isPersistencePending?.()) {
            await (this.credentials.retryPendingPersistence?.() || this.credentials.retryPendingRefreshPersistence?.())
          }
          await this.credentials.disconnect()
        })
        await this.finalizeDisconnect(pendingDisconnect.disconnectEpoch)
        if (this.pendingDisconnect === pendingDisconnect) this.pendingDisconnect = null
      } catch (error) {
        this.scheduleRetry()
        throw operationError(error)
      }
      return this.getState()
    }
    if (this.persistencePending) {
      try {
        const pending = this.persistencePending
        this.current = await this.runCredentialMutation(() => this.credentials.retryPendingPersistence?.() || this.credentials.retryPendingRefreshPersistence()) || this.current
        this.persistencePending = null
        if (!this.isCurrentConnection(pending.connection, pending.connectionEpoch)) return this.getState()
        if (pending.accessTokenExpiresAt - this.now() >= 60_000) {
          if (pending.refreshed) this.installAccessToken(pending.refreshed.accessToken, pending.refreshed.expiresIn, pending.accessTokenExpiresAt)
          await this.updateAuthorizationState(pending.authorization || pending.refreshed.authorization, pending)
          await this.getBootstrap({ force: true })
        } else {
          await this.refreshAndBootstrap()
        }
      } catch (error) {
        this.setRuntimeStatus('unreachable', 'PERSISTENCE_PENDING')
        this.rescheduleRetry()
        throw operationError(error)
      }
      return this.getState()
    }
    if (this.current && typeof this.client.refresh === 'function') await this.refreshAndBootstrap()
    return this.getState()
  }

  async sync() {
    await this.retryPendingRevocations()
    if (this.persistencePending) throw operationError(Object.assign(new Error(), { code: 'PERSISTENCE_PENDING' }))
    if (this.current && typeof this.bootstrap === 'function') await this.getBootstrap({ force: true })
    return this.getState()
  }
  listModels() { return [] }
  listSkills() { return [] }

  isActiveAttempt(attemptId, epoch) {
    return !this.shuttingDown && this.operationEpoch === epoch && !this.invalidatedAttempts.has(attemptId) &&
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

  async revokeRevision(identity) {
    try {
      await this.revokeRuntimeRevision(identity)
    } catch {
      this.pendingRevocations.add(identity)
    }
  }

  async retryPendingRevocations() {
    for (const identity of [...this.pendingRevocations]) {
      try {
        await this.revokeRuntimeRevision(identity)
        this.pendingRevocations.delete(identity)
      } catch { /* keep pending until a later safe retry */ }
    }
  }

  async shutdown() {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.operationEpoch += 1
    for (const attemptId of this.previewFlights.keys()) this.attempts.cancel(attemptId)
    for (const attemptId of this.redeemFlights.keys()) {
      if (!this.committingAttempts.has(attemptId)) {
        this.invalidatedAttempts.add(attemptId)
        this.attempts.cancel(attemptId)
      }
    }
    this.clearOwnedTimers()
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    this.bootstrapCache = null
    await Promise.allSettled([
      ...this.previewFlights.values(), ...this.redeemFlights.values(),
      this.refreshFlight?.promise, this.bootstrapFlight?.promise, this.credentialMutation
    ].filter(Boolean))
    if (this.pendingDisconnect) {
      await this.runCredentialMutation(async () => {
        if (this.credentials.isPersistencePending?.()) {
          await (this.credentials.retryPendingPersistence?.() || this.credentials.retryPendingRefreshPersistence?.())
        }
        await this.credentials.disconnect()
      }).catch(() => {})
    } else if (this.persistencePending) {
      await this.runCredentialMutation(() => this.credentials.retryPendingPersistence?.() || this.credentials.retryPendingRefreshPersistence?.()).catch(() => {})
    }
    // In-flight work may have completed while shutdown awaited it; scrub again.
    this.clearOwnedTimers()
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    this.bootstrapCache = null
    this.persistencePending = null
    this.pendingDisconnect = null
    this.refreshFlight = null
    this.bootstrapFlight = null
    this.previewFlights.clear()
    this.redeemFlights.clear()
  }
}

export function createConnectionManager(options) {
  return new ConnectionManager(options)
}
