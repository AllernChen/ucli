import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getBinding,
  matchesBinding,
  formatKeys,
  getAllBindings,
  eventToKeys
} from '../src/keybindings.js'

test('getBinding returns the default binding for a known id', () => {
  const b = getBinding('pane.switchNext')
  assert.equal(b.id, 'pane.switchNext')
  assert.equal(b.keys.key, 'Tab')
  assert.equal(b.keys.ctrl, false)
  assert.equal(b.keys.shift, false)
})

test('getBinding returns null for an unknown id', () => {
  assert.equal(getBinding('does.not.exist'), null)
})

test('getBinding merges overrides with defaults', () => {
  const overrides = { 'pane.switchNext': { key: 'F2' } }
  const b = getBinding('pane.switchNext', overrides)
  assert.equal(b.keys.key, 'F2')
  assert.equal(b.keys.ctrl, false) // preserved from default
})

test('getBinding returns default when override id is missing', () => {
  const overrides = { 'pane.switchNext': { key: 'F2' } }
  const b = getBinding('terminal.copy', overrides)
  assert.equal(b.keys.key, 'C')
  assert.equal(b.keys.ctrl, true)
  assert.equal(b.keys.shift, true)
})

test('matchesBinding returns true for matching key event', () => {
  const event = { key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesBinding('pane.switchNext', event), true)
})

test('matchesBinding returns false for non-matching key event', () => {
  const event = { key: 'Tab', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }
  assert.equal(matchesBinding('pane.switchNext', event), false)
})

test('a cleared shortcut is disabled instead of becoming a modifier wildcard', () => {
  const overrides = { 'pane.switchNext': { disabled: true } }
  const event = { key: 'a', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }

  assert.equal(getBinding('pane.switchNext', overrides), null)
  assert.equal(matchesBinding('pane.switchNext', event, overrides), false)
})

test('a legacy cleared keyboard shortcut stays disabled after upgrade', () => {
  const overrides = {
    'pane.switchNext': { key: null, ctrl: false, shift: false, alt: false, meta: false }
  }

  assert.equal(getBinding('pane.switchNext', overrides), null)
})

test('session add-pane bindings remain modifier-only when an old override includes a key', () => {
  const overrides = { 'session.addPane': { key: 'C', ctrl: true } }
  const click = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }

  assert.equal(getBinding('session.addPane', overrides).keys.key, null)
  assert.equal(matchesBinding('session.addPane', click, overrides), true)
})

test('matchesBinding safely rejects a keyboard binding without a key value', () => {
  const event = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesBinding('pane.switchNext', event), false)
})

test('matchesBinding is case-insensitive for key matching', () => {
  const event = { key: 'c', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }
  assert.equal(matchesBinding('terminal.copy', event), true)
})

test('matchesBinding matches with overrides', () => {
  const overrides = { 'pane.switchNext': { key: 'F2' } }
  const event = { key: 'F2', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesBinding('pane.switchNext', event, overrides), true)
})

test('matchesBinding returns false when overrides change key', () => {
  const overrides = { 'pane.switchNext': { key: 'F2' } }
  const event = { key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesBinding('pane.switchNext', event, overrides), false)
})

test('matchesBinding on session.addPane matches only modifiers for click events', () => {
  // Click events have ctrlKey but no key property
  const event = { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.equal(matchesBinding('session.addPane', event), true)
})

test('formatKeys formats Ctrl+Shift+C correctly', () => {
  assert.equal(formatKeys({ key: 'C', ctrl: true, shift: true, alt: false, meta: false }), 'Ctrl+Shift+C')
})

test('formatKeys formats single key correctly', () => {
  assert.equal(formatKeys({ key: 'Tab', ctrl: false, shift: false, alt: false, meta: false }), 'Tab')
})

test('formatKeys formats Tab key correctly', () => {
  assert.equal(formatKeys({ key: 'Tab', ctrl: false, shift: true, alt: false, meta: false }), 'Shift+Tab')
})

test('getAllBindings returns all default bindings', () => {
  const all = getAllBindings()
  assert.ok(all.length >= 6)
  const ids = all.map(b => b.id)
  assert.ok(ids.includes('pane.switchNext'))
  assert.ok(ids.includes('pane.switchPrev'))
  assert.ok(ids.includes('terminal.copy'))
  assert.ok(ids.includes('terminal.copyAlt'))
  assert.ok(ids.includes('terminal.paste'))
  assert.ok(ids.includes('session.addPane'))
})

test('eventToKeys extracts modifier keys and key from KeyboardEvent', () => {
  const event = { key: 'V', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.deepEqual(eventToKeys(event), { key: 'V', ctrl: true, shift: false, alt: false, meta: false })
})

test('eventToKeys sets key to null for modifier-only keys', () => {
  const event = { key: 'Control', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
  assert.deepEqual(eventToKeys(event), { key: null, ctrl: true, shift: false, alt: false, meta: false })
})

test('session.addPane binding has key: null to match any key', () => {
  const b = getBinding('session.addPane')
  assert.equal(b.keys.key, null)
  assert.equal(b.keys.ctrl, true)
})

test('terminal.paste binding has Ctrl+V', () => {
  const b = getBinding('terminal.paste')
  assert.equal(b.keys.key, 'V')
  assert.equal(b.keys.ctrl, true)
  assert.equal(b.keys.shift, false)
})
