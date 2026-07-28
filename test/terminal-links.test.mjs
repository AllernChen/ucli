import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldOpenTerminalLink } from '../src/terminalLinks.js'

test('terminal links require Ctrl on Windows and Linux', () => {
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, metaKey: false }, 'Win32'), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: true }, 'Win32'), false)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, metaKey: false }, 'Linux x86_64'), true)
})

test('terminal links require Command on macOS', () => {
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: true }, 'MacIntel'), true)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: true, metaKey: false }, 'MacIntel'), false)
  assert.equal(shouldOpenTerminalLink({ ctrlKey: false, metaKey: false }, 'MacIntel'), false)
})
