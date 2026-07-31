import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldOpenTerminalLink } from '../src/terminalLinks.js'

test('terminal links open on a plain click across platforms', () => {
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: false }, 'Win32'), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: false }, 'Linux x86_64'), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: false }, 'MacIntel'), true)
})
