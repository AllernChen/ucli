import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalSizeChanged } from '../src/terminalResize.js'

test('terminal resize is sent only for valid changed dimensions', () => {
  assert.equal(terminalSizeChanged(null, { cols: 58, rows: 12 }), true)
  assert.equal(
    terminalSizeChanged({ cols: 58, rows: 12 }, { cols: 58, rows: 12 }),
    false
  )
  assert.equal(
    terminalSizeChanged({ cols: 58, rows: 12 }, { cols: 0, rows: 0 }),
    false
  )
})

test('terminal resize rejects fractional, negative, and non-finite dimensions', () => {
  assert.equal(terminalSizeChanged(null, { cols: 58.5, rows: 12 }), false)
  assert.equal(terminalSizeChanged(null, { cols: -1, rows: 12 }), false)
  assert.equal(terminalSizeChanged(null, { cols: 58, rows: Number.NaN }), false)
  assert.equal(terminalSizeChanged(null, null), false)
})
