const DAY_MS = 24 * 60 * 60 * 1000
const THRESHOLDS = Object.freeze([7, 3, 1, 0])

function dateMs(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Tracks authorization-expiry reminders. Link expiry intentionally never
 * enters this component: it is only meaningful while registering. */
export class ExpiryReminder {
  constructor({ notify = () => {}, now = Date.now } = {}) {
    this.notify = notify
    this.now = now
  }

  evaluate({ authorizationExpiresAt, serverTime, receivedLocalTime, reminderState = {} } = {}) {
    if (!authorizationExpiresAt) return {}
    const expiresAt = dateMs(authorizationExpiresAt)
    const serverNowAtReceipt = dateMs(serverTime)
    if (expiresAt === null || serverNowAtReceipt === null || !Number.isFinite(receivedLocalTime)) return reminderState

    // An extension is a new schedule: past thresholds on the prior grant do
    // not suppress notifications for the renewed one.
    const previousExpiry = reminderState.authorizationExpiresAt
    const crossed = previousExpiry === authorizationExpiresAt
      ? new Set(Array.isArray(reminderState.crossedThresholds) ? reminderState.crossedThresholds : [])
      : new Set()
    const estimatedServerNow = this.now() + (serverNowAtReceipt - receivedLocalTime)
    const remaining = expiresAt - estimatedServerNow
    const newlyCrossed = THRESHOLDS.filter(days => remaining <= days * DAY_MS && !crossed.has(days))
    if (newlyCrossed.length) {
      const closest = Math.min(...newlyCrossed)
      this.notify({ thresholdDays: closest, authorizationExpiresAt })
      for (const threshold of newlyCrossed) crossed.add(threshold)
    }
    return { authorizationExpiresAt, crossedThresholds: THRESHOLDS.filter(days => crossed.has(days)) }
  }
}

export { DAY_MS, THRESHOLDS }
