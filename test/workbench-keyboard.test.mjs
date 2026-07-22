import assert from 'node:assert/strict'
import test from 'node:test'

import { nextSessionPaneIndex } from '../src/workbenchKeyboard.js'

const panes = [
  { sessionId: 'claude-a' },
  { sessionId: null },
  { sessionId: 'codex-b' },
  { sessionId: 'claude-c' }
]

test('Tab cycles assigned session panes in layout order and wraps', () => {
  assert.equal(nextSessionPaneIndex(panes, 0), 2)
  assert.equal(nextSessionPaneIndex(panes, 2), 3)
  assert.equal(nextSessionPaneIndex(panes, 3), 0)
})

test('Shift+Tab cycles assigned session panes in reverse', () => {
  assert.equal(nextSessionPaneIndex(panes, 0, -1), 3)
  assert.equal(nextSessionPaneIndex(panes, 3, -1), 2)
})

test('a single already-active session leaves Tab to the CLI', () => {
  assert.equal(nextSessionPaneIndex([{ sessionId: 'claude-a' }], 0), null)
  assert.equal(nextSessionPaneIndex([{ sessionId: null }], 0), null)
})
