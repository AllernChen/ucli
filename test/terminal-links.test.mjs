import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldOpenTerminalLink } from '../src/terminalLinks.js'

test('terminal links require Ctrl or Command activation', () => {
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, metaKey: false }), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: true }), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: false }), false)
})
