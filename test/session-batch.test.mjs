import assert from 'node:assert/strict'
import test from 'node:test'
import { createBatchSelection } from '../src/sessionBatch.js'

test('batch selection toggles, selects all, and clears', () => {
  const b = createBatchSelection()
  b.toggle('a'); b.toggle('b')
  assert.deepEqual([...b.selected()], ['a', 'b'])
  b.setAll(['a', 'b', 'c'])
  assert.equal(b.selected().size, 3)
  assert.equal(b.isAllSelected(['a', 'b', 'c']), true)
  b.clear()
  assert.equal(b.selected().size, 0)
})

test('batch selection has mode and reports hasSelection', () => {
  const b = createBatchSelection()
  assert.equal(b.mode(), false)
  b.toggle('a')
  assert.equal(b.mode(), true)
})
