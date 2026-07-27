import assert from 'node:assert/strict'
import test from 'node:test'

import { isClipboardCopyShortcut, shouldSendClipboardPaste } from '../src/terminalKeybindings.js'

test('clipboard paste shortcut is handled only once on keydown', () => {
  const shortcut = { ctrlKey: true, shiftKey: false, metaKey: false, key: 'v' }

  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keydown' }), true)
  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keypress' }), false)
  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keyup' }), false)
})

test('Ctrl+Shift+V is also a single clipboard paste shortcut', () => {
  assert.equal(shouldSendClipboardPaste({
    type: 'keydown', ctrlKey: true, shiftKey: true, metaKey: false, key: 'V'
  }), true)
})

test('Command+V is handled as the macOS clipboard paste shortcut', () => {
  assert.equal(shouldSendClipboardPaste({
    type: 'keydown', ctrlKey: false, shiftKey: false, metaKey: true, key: 'v'
  }), true)
})

test('Command+C is handled as the macOS clipboard copy shortcut', () => {
  assert.equal(isClipboardCopyShortcut({
    type: 'keydown', ctrlKey: false, altKey: false, metaKey: true, key: 'c'
  }), true)
  assert.equal(isClipboardCopyShortcut({
    type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'c'
  }), false)
})
