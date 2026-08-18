import assert from 'node:assert/strict'
import test from 'node:test'

import { listAdapterDescriptors } from '../electron/adapterRegistry.js'
import { DeepSeekHarnessAdapter } from '../electron/adapters/deepSeekHarnessAdapter.js'

function legacyAdapter(surfacePreference = 'legacy-tui') {
  const calls = { bridge: 0, pty: 0, runtime: 0, decisions: 0, events: [] }
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: `legacy-${surfacePreference}`,
      cwd: 'F:\\workspace',
      cliSessionId: 'native-legacy',
      adapterConfig: { surfacePreference, profileName: 'TUI' }
    },
    engine: { decide: async () => { calls.decisions += 1 } },
    settings: {
      inspectRuntime: async () => { calls.runtime += 1 },
      createBridgeServer: async () => { calls.bridge += 1 },
      pty: { spawn: () => { calls.pty += 1 } }
    }
  })
  adapter.on('event', event => calls.events.push(event))
  return { adapter, calls }
}

test('registry exposes DSH Web by default and unavailable capabilities for legacy persisted config', () => {
  const descriptor = listAdapterDescriptors().find(value => value.id === 'deepseek-harness')
  assert.deepEqual(descriptor.capabilities, {
    surface: 'web', permissionOwner: 'native', historyOwner: 'native',
    statsOwner: 'ucli', gateway: false, bridge: false
  })
  assert.equal(descriptor.capabilitiesForConfig({ surfacePreference: 'web' }).surface, 'web')
  assert.deepEqual(descriptor.capabilitiesForConfig({
    surfacePreference: 'legacy-tui', profileName: 'TUI'
  }), {
    surface: 'unavailable', permissionOwner: 'native', historyOwner: 'native',
    statsOwner: 'native', gateway: false, bridge: false
  })
})

for (const surface of ['legacy-tui', 'tui']) {
  test(`${surface} start and resume fail unavailable before runtime, bridge, PTY or UCLI events`, async () => {
    const { adapter, calls } = legacyAdapter(surface)
    await assert.rejects(adapter.start(), { code: 'DSH_TUI_UNAVAILABLE' })
    await assert.rejects(adapter.resume('native-resume'), { code: 'DSH_TUI_UNAVAILABLE' })
    assert.deepEqual(calls, {
      bridge: 0, pty: 0, runtime: 0, decisions: 0, events: []
    })
    assert.equal(adapter.ptyProc, null)
    assert.equal(adapter.bridge, null)
    assert.equal(adapter.isGatewayLive(), false)
  })
}
