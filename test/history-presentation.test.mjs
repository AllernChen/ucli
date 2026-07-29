import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatHistoryTimestamp,
  mergeHistoryPage
} from '../src/historyPresentation.js'

test('older history pages prepend without duplicates and preserve provider order', () => {
  const current = [
    { id: '3', timestamp: 3000 },
    { id: '4', timestamp: 4000 }
  ]
  const page = {
    items: [
      { id: '1', timestamp: 1000 },
      { id: '2', timestamp: 2000 },
      { id: '3', timestamp: 3000 }
    ]
  }

  assert.deepEqual(
    mergeHistoryPage(current, page).map((item) => item.id),
    ['1', '2', '3', '4']
  )
})

test('newest history refresh replaces stale text for the same item ID', () => {
  const current = [{ id: 'answer', text: 'partial' }]
  const page = { items: [{ id: 'answer', text: 'complete' }] }

  assert.deepEqual(mergeHistoryPage(current, page), [
    { id: 'answer', text: 'complete' }
  ])
})

test('history timestamps use a compact local label and tolerate missing values', () => {
  assert.equal(formatHistoryTimestamp(null), '')
  assert.equal(formatHistoryTimestamp(Number.NaN), '')
  assert.match(formatHistoryTimestamp(Date.UTC(2026, 6, 29, 3, 4)), /^\d{2}:\d{2}$/)
})
