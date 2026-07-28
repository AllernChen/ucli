import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWindowBounds } from '../electron/windowState.js'

const displays = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
]

test('restores saved bounds that overlap an available display', () => {
  assert.deepEqual(resolveWindowBounds({ x: 2000, y: 100, width: 1200, height: 800 }, displays), {
    x: 2000, y: 100, width: 1200, height: 800
  })
})

test('falls back to default bounds when saved window is off-screen', () => {
  assert.deepEqual(resolveWindowBounds({ x: -5000, y: 100, width: 1200, height: 800 }, displays), {
    width: 1280, height: 832
  })
})
