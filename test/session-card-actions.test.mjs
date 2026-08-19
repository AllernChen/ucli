import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionCardActionItems } from '../src/sessionCardActions.js'

test('session card actions expose stop/restart/rename/configure/delete', () => {
  const items = sessionCardActionItems({ running: true })
  const keys = items.map(i => i.key)
  assert.deepEqual(keys, ['stop', 'restart', 'rename', 'configure', 'delete'])
  assert.equal(items.find(i => i.key === 'delete').danger, true)
})

test('stop action is hidden for non-running sessions', () => {
  const items = sessionCardActionItems({ running: false })
  assert.equal(items.some(i => i.key === 'stop'), false)
})
