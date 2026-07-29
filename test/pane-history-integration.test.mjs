import assert from 'node:assert/strict'
import test from 'node:test'

import {
  historyScrollTopAfterPrepend,
  shouldLoadOlderHistory
} from '../src/historyPresentation.js'

test('prepending older records preserves the current reading position in one pane', () => {
  assert.equal(historyScrollTopAfterPrepend({
    previousScrollTop: 40,
    previousScrollHeight: 600,
    nextScrollHeight: 980
  }), 420)
})

test('each pane requests older history only at its own top boundary', () => {
  const leftPane = { scrollTop: 20, loading: false, complete: false }
  const rightPane = { scrollTop: 240, loading: false, complete: false }

  assert.equal(shouldLoadOlderHistory(leftPane), true)
  assert.equal(shouldLoadOlderHistory(rightPane), false)
  assert.equal(shouldLoadOlderHistory({ ...leftPane, loading: true }), false)
  assert.equal(shouldLoadOlderHistory({ ...leftPane, complete: true }), false)
})
