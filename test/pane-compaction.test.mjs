import assert from 'node:assert/strict'
import test from 'node:test'

import { compactPaneSessionIds } from '../src/paneCompaction.js'

test('clearing the only pane removes its persisted session ID', () => {
  assert.deepEqual(compactPaneSessionIds(['claude-a'], 0), {
    splitCount: 1,
    paneSessionIds: [null]
  })
})

test('closing one pane compacts remaining sessions without overwriting them', () => {
  assert.deepEqual(compactPaneSessionIds(['a', 'b', 'c', null], 1), {
    splitCount: 2,
    paneSessionIds: ['a', 'c']
  })
})
