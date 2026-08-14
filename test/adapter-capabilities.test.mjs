import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRIDGED_DSH_TUI_CAPABILITIES,
  DSH_WEB_CAPABILITIES,
  TERMINAL_ADAPTER_CAPABILITIES,
  normalizeAdapterCapabilities
} from '../electron/adapters/adapterCapabilities.js'

test('existing descriptors receive an isolated terminal capability matrix by default', () => {
  const first = normalizeAdapterCapabilities()
  const second = normalizeAdapterCapabilities()

  assert.deepEqual(first, {
    surface: 'terminal',
    permissionOwner: 'ucli',
    historyOwner: 'ucli',
    statsOwner: 'ucli',
    gateway: true,
    bridge: false
  })
  assert.deepEqual(first, TERMINAL_ADAPTER_CAPABILITIES)
  assert.notEqual(first, second)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(second), true)
})

test('bridged DSH TUI capabilities keep UCLI ownership and enable the bridge', () => {
  assert.deepEqual(normalizeAdapterCapabilities(BRIDGED_DSH_TUI_CAPABILITIES), {
    surface: 'terminal',
    permissionOwner: 'ucli',
    historyOwner: 'ucli',
    statsOwner: 'ucli',
    gateway: true,
    bridge: true
  })
})

test('DSH Web capabilities keep native ownership and fail Gateway closed', () => {
  assert.deepEqual(normalizeAdapterCapabilities(DSH_WEB_CAPABILITIES), {
    surface: 'web',
    permissionOwner: 'native',
    historyOwner: 'native',
    statsOwner: 'native',
    gateway: false,
    bridge: false
  })
})

test('capability normalization drops undeclared transient fields', () => {
  assert.deepEqual(normalizeAdapterCapabilities({
    ...BRIDGED_DSH_TUI_CAPABILITIES,
    endpoint: '\\\\.\\pipe\\secret',
    token: 'must-not-leak'
  }), BRIDGED_DSH_TUI_CAPABILITIES)
})

test('capability normalization rejects malformed explicit descriptor contracts', () => {
  const invalidCapabilities = [
    null,
    {},
    { ...TERMINAL_ADAPTER_CAPABILITIES, surface: 'tui' },
    { ...TERMINAL_ADAPTER_CAPABILITIES, permissionOwner: 'bridge' },
    { ...TERMINAL_ADAPTER_CAPABILITIES, historyOwner: 'bridge' },
    { ...TERMINAL_ADAPTER_CAPABILITIES, statsOwner: 'bridge' },
    { ...TERMINAL_ADAPTER_CAPABILITIES, gateway: 1 },
    { ...TERMINAL_ADAPTER_CAPABILITIES, bridge: 'false' }
  ]

  for (const capabilities of invalidCapabilities) {
    assert.throws(
      () => normalizeAdapterCapabilities(capabilities),
      /invalid adapter capabilities/i
    )
  }
})
