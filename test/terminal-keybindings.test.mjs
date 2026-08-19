import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isClipboardCopyShortcut,
  shouldHandleTerminalPaste,
  shouldBlockDuplicateClipboardPaste,
  shouldSendClipboardPaste
} from '../src/terminalKeybindings.js'

test('clipboard paste shortcut is handled only once on keydown', () => {
  const shortcut = { ctrlKey: true, shiftKey: false, metaKey: false, key: 'v' }

  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keydown' }), true)
  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keypress' }), false)
  assert.equal(shouldSendClipboardPaste({ ...shortcut, type: 'keyup' }), false)
})

test('clipboard paste blocks the later keypress event after forwarding on keydown', () => {
  const shortcut = { ctrlKey: true, shiftKey: false, metaKey: false, key: 'v' }

  assert.equal(shouldBlockDuplicateClipboardPaste({ ...shortcut, type: 'keydown' }), false)
  assert.equal(shouldBlockDuplicateClipboardPaste({ ...shortcut, type: 'keypress' }), true)
  assert.equal(shouldBlockDuplicateClipboardPaste({ ...shortcut, type: 'keyup' }), false)
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

test('Command+V remains a terminal paste shortcut when its configured binding changes', () => {
  assert.equal(shouldHandleTerminalPaste({
    type: 'keydown', ctrlKey: false, shiftKey: false, metaKey: true, key: 'v'
  }, false), true)
})

test('a configured non-default shortcut is handled as terminal paste', () => {
  assert.equal(shouldHandleTerminalPaste({
    type: 'keydown', ctrlKey: false, shiftKey: false, metaKey: false, key: 'F2'
  }, true), true)
})

test('keydown Ctrl/Cmd+V is the exact gate that suppresses the xterm 6.x native paste', () => {
  // xterm 6.0 registers a native `paste` event listener that re-pastes the clipboard
  // when the browser's default Ctrl/Cmd+V action is not prevented. The keydown handler
  // uses shouldSendClipboardPaste as the gate for preventDefault, so it must be true
  // only for the exact clipboard-paste keydown — never for keypress/keyup or bare keys.
  assert.equal(shouldSendClipboardPaste({ ctrlKey: true, metaKey: false, key: 'v', type: 'keydown' }), true)
  assert.equal(shouldSendClipboardPaste({ ctrlKey: false, metaKey: true, key: 'v', type: 'keydown' }), true)
  assert.equal(shouldSendClipboardPaste({ ctrlKey: true, shiftKey: true, metaKey: false, key: 'V', type: 'keydown' }), true)
  assert.equal(shouldSendClipboardPaste({ ctrlKey: true, metaKey: false, key: 'v', type: 'keypress' }), false)
  assert.equal(shouldSendClipboardPaste({ ctrlKey: true, metaKey: false, key: 'v', type: 'keyup' }), false)
  assert.equal(shouldSendClipboardPaste({ ctrlKey: false, metaKey: false, key: 'v', type: 'keydown' }), false)
})

test('Command+C is handled as the macOS clipboard copy shortcut', () => {
  assert.equal(isClipboardCopyShortcut({
    type: 'keydown', ctrlKey: false, altKey: false, metaKey: true, key: 'c'
  }), true)
  assert.equal(isClipboardCopyShortcut({
    type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'c'
  }), false)
})
