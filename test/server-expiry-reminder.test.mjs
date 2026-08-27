import assert from 'node:assert/strict'
import test from 'node:test'

import { ExpiryReminder } from '../electron/serverConnection/expiryReminder.js'

const day = 24 * 60 * 60 * 1000

test('uses server-adjusted time and sends only the closest crossed authorization threshold', () => {
  const notices = []
  const reminder = new ExpiryReminder({ notify: notice => notices.push(notice), now: () => 1_000 })
  const expiry = 10_000

  const state = reminder.evaluate({
    authorizationExpiresAt: new Date(expiry).toISOString(),
    serverTime: new Date(11_000).toISOString(),
    receivedLocalTime: 1_000,
    reminderState: {}
  })

  assert.deepEqual(notices, [{ thresholdDays: 0, authorizationExpiresAt: new Date(expiry).toISOString() }])
  assert.deepEqual(state.crossedThresholds, [7, 3, 1, 0])
})

test('rebuilds reminder state after authorization extension and clears permanent authorization', () => {
  const reminder = new ExpiryReminder({ now: () => 0 })
  const expiresAt = new Date(3 * day).toISOString()
  const initial = reminder.evaluate({ authorizationExpiresAt: expiresAt, serverTime: new Date(0).toISOString(), receivedLocalTime: 0, reminderState: {} })
  const extended = reminder.evaluate({ authorizationExpiresAt: new Date(14 * day).toISOString(), serverTime: new Date(0).toISOString(), receivedLocalTime: 0, reminderState: initial })

  assert.deepEqual(extended.crossedThresholds, [])
  assert.deepEqual(reminder.evaluate({ authorizationExpiresAt: null, serverTime: new Date(0).toISOString(), receivedLocalTime: 0, reminderState: extended }), {})
})
