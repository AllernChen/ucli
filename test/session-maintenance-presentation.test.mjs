import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSessionMaintenanceState } from '../src/sessionMaintenancePresentation.js'

test('active sessions expose interrupt, stop, restart, and remove actions', () => {
  for (const status of ['running', 'idle', 'waiting']) {
    assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status, canStart: true }), {
      canInterrupt: true,
      canStop: true,
      canRestart: true,
      canRemove: true,
      stopBeforeRestart: true
    })
  }
})

test('starting sessions can be stopped or restarted but not interrupted', () => {
  assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status: 'starting', canStart: true }), {
    canInterrupt: false,
    canStop: true,
    canRestart: true,
    canRemove: true,
    stopBeforeRestart: true
  })
})

test('offline, exited, and error sessions expose restart without soft interruption or stop', () => {
  for (const status of ['offline', 'exited', 'error']) {
    assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status, canStart: true }), {
      canInterrupt: false,
      canStop: false,
      canRestart: true,
      canRemove: true,
      stopBeforeRestart: status !== 'offline'
    })
  }
})

test('unavailable or missing sessions do not expose invalid lifecycle actions', () => {
  assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status: 'offline', canStart: false }), {
    canInterrupt: false,
    canStop: false,
    canRestart: false,
    canRemove: true,
    stopBeforeRestart: false
  })
  assert.deepEqual(deriveSessionMaintenanceState(), {
    canInterrupt: false,
    canStop: false,
    canRestart: false,
    canRemove: false,
    stopBeforeRestart: false
  })
})
