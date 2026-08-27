import { randomUUID } from 'node:crypto'

function publicAttempt(attempt) {
  if (!attempt) return null
  return {
    attemptId: attempt.attemptId,
    serverOrigin: attempt.serverOrigin,
    preview: attempt.preview === null ? null : structuredClone(attempt.preview)
  }
}

export class RegistrationAttemptStore {
  constructor({
    now = Date.now,
    ttlMs = 15 * 60_000,
    recoveryMs = 10 * 60_000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.recoveryMs = recoveryMs
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.attempts = new Map()
  }

  create({ serverOrigin, linkSecret }) {
    this.sweep()
    const createdAt = this.now()
    const attempt = {
      attemptId: randomUUID(),
      serverOrigin,
      linkSecret,
      preview: null,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      phase: 'open',
      recoveryExpiresAt: null,
      recoveryUsed: false,
      expiryTimer: null
    }
    this.attempts.set(attempt.attemptId, attempt)
    this.scheduleExpiry(attempt)
    return publicAttempt(attempt)
  }

  getPublic(attemptId) {
    this.sweep()
    return publicAttempt(this.attempts.get(attemptId))
  }

  getSecret(attemptId) {
    this.sweep()
    return this.attempts.get(attemptId)?.linkSecret ?? null
  }

  markPreview(attemptId, preview) {
    this.sweep()
    const attempt = this.attempts.get(attemptId)
    if (!attempt || attempt.phase !== 'open') return null
    attempt.preview = structuredClone(preview)
    return publicAttempt(attempt)
  }

  beginRedeem(attemptId) {
    this.sweep()
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return false
    if (attempt.phase === 'recoverable') {
      if (this.now() >= attempt.recoveryExpiresAt) {
        this.remove(attemptId)
        return false
      }
      attempt.recoveryUsed = true
    } else if (attempt.phase !== 'open') {
      return false
    }
    attempt.phase = 'redeeming'
    attempt.recoveryExpiresAt = null
    return true
  }

  markRedeemAmbiguous(attemptId) {
    this.sweep()
    const attempt = this.attempts.get(attemptId)
    if (!attempt || attempt.phase !== 'redeeming') return false
    if (attempt.recoveryUsed) {
      this.remove(attemptId)
      return false
    }
    attempt.phase = 'recoverable'
    attempt.recoveryExpiresAt = Math.min(attempt.expiresAt, this.now() + this.recoveryMs)
    return true
  }

  finish(attemptId) {
    return this.remove(attemptId)
  }

  cancel(attemptId) {
    return this.remove(attemptId)
  }

  sweep() {
    const now = this.now()
    for (const [attemptId, attempt] of this.attempts) {
      if (now >= attempt.expiresAt || (attempt.phase === 'recoverable' && now >= attempt.recoveryExpiresAt)) {
        this.remove(attemptId)
      }
    }
  }

  remove(attemptId) {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return false
    if (attempt.expiryTimer !== null) {
      this.clearTimeoutFn(attempt.expiryTimer)
      attempt.expiryTimer = null
    }
    attempt.linkSecret = null
    attempt.preview = null
    this.attempts.delete(attemptId)
    return true
  }

  scheduleExpiry(attempt) {
    const delay = Math.max(0, attempt.expiresAt - this.now())
    const timer = this.setTimeoutFn(() => this.remove(attempt.attemptId), delay)
    attempt.expiryTimer = timer
    timer?.unref?.()
  }
}
