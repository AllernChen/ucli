import assert from 'node:assert/strict'
import test from 'node:test'

import * as openCodeAdapter from '../electron/adapters/openCodeAdapter.js'
import { extractOpenCodeResultSnapshot } from '../electron/adapters/openCodeGatewayParser.js'

let ucodeAdapter = {}
try {
  ucodeAdapter = await import('../electron/adapters/ucodeAdapter.js')
} catch {}

let adapterRegistry = {}
try {
  adapterRegistry = await import('../electron/adapterRegistry.js')
} catch {}

test('adapter registry exposes U-Code with isolated compatible runtime hooks', () => {
  assert.equal(typeof adapterRegistry.listAdapterDescriptors, 'function')
  const descriptors = adapterRegistry.listAdapterDescriptors()
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    'claude', 'codex', 'opencode', 'ucode', 'deepseek-harness'
  ])

  const openCode = descriptors.find((descriptor) => descriptor.id === 'opencode')
  const ucode = descriptors.find((descriptor) => descriptor.id === 'ucode')
  assert.equal(openCode.costAvailable, false)
  assert.equal(ucode.costAvailable, false)
  assert.equal(typeof openCode.listNativeSessions, 'function')
  assert.equal(typeof ucode.listNativeSessions, 'function')
  assert.notEqual(openCode.resolveLaunch, ucode.resolveLaunch)
})

test('U-Code runtime exposes a first-class adapter and safe Windows npm launcher', () => {
  assert.equal(typeof ucodeAdapter.resolveUCodeCmdShim, 'function')
  assert.equal(ucodeAdapter.ucodeDescriptor?.id, 'ucode')
  assert.equal(ucodeAdapter.ucodeDescriptor?.displayName, 'U-Code')

  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'endLocal & goto #_undefined_# 2>NUL || "%_prog%" "%~dp0node_modules\\@allenchen77\\ucode-cli\\bin\\ucode" %*'
  ].join('\r\n')
  const existing = new Set([
    'F:\\tools\\node.exe',
    'F:\\tools\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode'
  ])

  assert.deepEqual(ucodeAdapter.resolveUCodeCmdShim(
    'F:\\tools\\ucode.cmd',
    shim,
    (path) => existing.has(path)
  ), {
    file: 'F:\\tools\\node.exe',
    prefixArgs: ['F:\\tools\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode']
  })
})

test('U-Code launcher resolves the system Node executable for a global npm shim', () => {
  const shim = '"%_prog%" "%~dp0node_modules\\@allenchen77\\ucode-cli\\bin\\ucode" %*'
  const existing = new Set([
    'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode',
    'C:\\Program Files\\nodejs\\node.exe'
  ])

  assert.deepEqual(ucodeAdapter.resolveUCodeCmdShim(
    'C:\\Users\\Ada\\AppData\\Roaming\\npm\\ucode.cmd',
    shim,
    (path) => existing.has(path),
    ['C:\\Program Files\\nodejs\\node.exe']
  ), {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: [
      'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode'
    ]
  })
})

test('U-Code launcher prefers the npm executable over a legacy macOS release install', () => {
  const npmExecutable = '/opt/homebrew/bin/ucode'
  const legacyExecutable = '/Users/Ada/.ucode/bin/ucode'

  assert.deepEqual(ucodeAdapter.resolveUCodeLaunch(
    null,
    (path) => [npmExecutable, legacyExecutable].includes(path),
    'darwin',
    undefined,
    '/Users/Ada',
    () => [legacyExecutable],
    () => [npmExecutable]
  ), {
    file: npmExecutable,
    prefixArgs: []
  })
})

test('U-Code launcher prefers the npm shim over a legacy Windows release install', () => {
  const shimPath = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\ucode.cmd'
  const entry = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode'
  const node = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node.exe'
  const legacyExecutable = 'C:\\Users\\Ada\\.ucode\\bin\\ucode.exe'
  const existing = new Set([entry, node, legacyExecutable])
  const shim = '"%_prog%" "%~dp0node_modules\\@allenchen77\\ucode-cli\\bin\\ucode" %*'

  assert.deepEqual(ucodeAdapter.resolveUCodeLaunch(
    [legacyExecutable, shimPath],
    (path) => existing.has(path),
    'win32',
    () => shim,
    'C:\\Users\\Ada'
  ), {
    file: node,
    prefixArgs: [entry]
  })
})

test('U-Code launcher finds the npm shim even when it is absent from process PATH', () => {
  const shimPath = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\ucode.cmd'
  const entry = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@allenchen77\\ucode-cli\\bin\\ucode'
  const node = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node.exe'
  const legacyExecutable = 'C:\\Users\\Ada\\.ucode\\bin\\ucode.exe'
  const existing = new Set([entry, node, legacyExecutable])
  const shim = '"%_prog%" "%~dp0node_modules\\@allenchen77\\ucode-cli\\bin\\ucode" %*'

  assert.deepEqual(ucodeAdapter.resolveUCodeLaunch(
    null,
    (path) => existing.has(path),
    'win32',
    () => shim,
    'C:\\Users\\Ada',
    () => [legacyExecutable],
    () => [shimPath]
  ), {
    file: node,
    prefixArgs: [entry]
  })
})

test('U-Code launcher finds the persistent UCLI install after a macOS app restart', () => {
  const installed = '/Users/Ada/.ucode/bin/ucode'

  assert.deepEqual(ucodeAdapter.resolveUCodeLaunch(
    [],
    (path) => path === installed,
    'darwin',
    undefined,
    '/Users/Ada'
  ), {
    file: installed,
    prefixArgs: []
  })
})

test('U-Code launcher finds the persistent UCLI install after a Windows app restart', () => {
  const installed = 'C:\\Users\\Ada\\.ucode\\bin\\ucode.exe'

  assert.deepEqual(ucodeAdapter.resolveUCodeLaunch(
    [],
    (path) => path === installed,
    'win32',
    undefined,
    'C:\\Users\\Ada'
  ), {
    file: installed,
    prefixArgs: []
  })
})

test('missing U-Code does not block discovery for the other adapters', async () => {
  const runtime = ucodeAdapter.createUCodeRuntime({
    resolveLaunch() {
      throw new Error('safe U-Code executable not found')
    }
  })

  assert.deepEqual(await runtime.listSessions('F:\\project'), [])
})

test('U-Code runtime uses its own client and inline permission environment', () => {
  assert.equal(typeof openCodeAdapter.buildOpenCodeEnvironment, 'function')
  assert.equal(typeof ucodeAdapter.createUCodeRuntime, 'function')

  const env = openCodeAdapter.buildOpenCodeEnvironment({
    id: 'ucli-session',
    tier: 'safety-rules'
  }, {}, ucodeAdapter.createUCodeRuntime(), { PATH: 'F:\\tools' })

  assert.equal(env.UCODE_CLIENT, 'ucli')
  assert.equal(JSON.parse(env.UCODE_CONFIG_CONTENT).permission['*'], 'allow')
  assert.equal(env.OPENCODE_CLIENT, undefined)
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
})

test('OpenCode-compatible Gateway snapshots retain the U-Code provider identity', () => {
  const source = {
    info: { id: 'ses_ucode' },
    messages: [
      { info: { id: 'turn-1', role: 'user', time: { created: 1 } }, parts: [] },
      {
        info: { id: 'assistant-1', role: 'assistant', finish: 'stop', time: { completed: 2 } },
        parts: [{ type: 'text', text: 'U-Code result' }]
      }
    ]
  }

  assert.deepEqual(extractOpenCodeResultSnapshot(source, 'turn-1', {
    provider: 'ucode',
    displayName: 'U-Code'
  }), {
    kind: 'result',
    title: 'U-Code result',
    markdown: 'U-Code result',
    provider: 'ucode',
    nativeSessionId: 'ses_ucode',
    turnId: 'turn-1',
    capturedAt: 2
  })
})
