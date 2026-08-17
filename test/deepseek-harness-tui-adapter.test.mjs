import assert from 'node:assert/strict'
import test from 'node:test'

import { listAdapterDescriptors } from '../electron/adapterRegistry.js'
import { DeepSeekHarnessAdapter } from '../electron/adapters/deepSeekHarnessAdapter.js'

function compatibleRuntime(overrides = {}) {
  return {
    installed: true,
    compatible: true,
    version: '0.1.0-rc.6',
    home: 'F:\\dsh-home',
    launch: { file: 'C:\\node.exe', prefixArgs: ['C:\\dsh\\lib\\bin.js'] },
    ...overrides
  }
}

function compatibleProfile(overrides = {}) {
  return {
    profileName: 'tui',
    profileReady: true,
    bridgeInstalled: true,
    bridgeCompatible: true,
    bridgeVersion: '0.11.0',
    errorCode: null,
    ...overrides
  }
}

function fakePtyProcess() {
  return {
    pid: 1234,
    onData(handler) { this.dataHandler = handler },
    onExit(handler) { this.exitHandler = handler },
    write() {},
    resize() {}
  }
}

test('registry exposes DeepSeek Harness after the existing terminal adapters', () => {
  const descriptors = listAdapterDescriptors()
  assert.deepEqual(descriptors.map(({ id }) => id), [
    'claude',
    'codex',
    'opencode',
    'ucode',
    'deepseek-harness'
  ])
  const descriptor = descriptors.at(-1)
  assert.equal(descriptor.displayName, 'DeepSeek Harness')
  assert.deepEqual(descriptor.models, ['native'])
  assert.equal(descriptor.costAvailable, false)
  assert.deepEqual(descriptor.capabilities, {
    surface: 'terminal',
    permissionOwner: 'ucli',
    historyOwner: 'ucli',
    statsOwner: 'ucli',
    gateway: true,
    bridge: true
  })
})

test('TUI start listens on its bridge before launching the exact compatible rc6 profile', async () => {
  const order = []
  const bridge = {
    endpoint: '\\\\.\\pipe\\ucli-dsh-one',
    token: 'a'.repeat(64),
    protocolVersion: 1,
    async waitForHello() {
      order.push('hello')
      return { surface: 'tui', profileName: 'tui' }
    },
    async close() { order.push('bridge-close') }
  }
  const proc = fakePtyProcess()
  let spawnCall
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-one',
      cwd: 'F:\\workspace',
      cliSessionId: null,
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      baseEnv: { PATH: 'safe-path', UCLI_DSH_BRIDGE_TOKEN: 'stale' },
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async (options) => {
        order.push('bridge')
        assert.equal(options.handshakeTimeoutMs, 60_000)
        return bridge
      },
      pty: {
        spawn(file, args, options) {
          order.push('pty')
          spawnCall = { file, args, options }
          return proc
        }
      }
    }
  })

  await adapter.start()

  assert.deepEqual(order, ['bridge', 'pty', 'hello'])
  assert.equal(spawnCall.file, 'C:\\node.exe')
  assert.deepEqual(spawnCall.args, [
    'C:\\dsh\\lib\\bin.js', '--profile', 'tui'
  ])
  assert.equal(spawnCall.options.cwd, 'F:\\workspace')
  assert.equal(spawnCall.options.env.DSH_HOME, 'F:\\dsh-home')
  assert.equal(spawnCall.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(spawnCall.options.env.UCLI_DSH_BRIDGE_ENDPOINT, bridge.endpoint)
  assert.equal(spawnCall.options.env.UCLI_DSH_BRIDGE_TOKEN, bridge.token)
  assert.equal(spawnCall.options.env.UCLI_DSH_BRIDGE_PROTOCOL, '1')
  assert.equal(spawnCall.options.env.TERM, 'xterm-256color')
})

test('TUI start fails closed before bridge or PTY for an incompatible runtime or profile', async () => {
  for (const fixture of [
    {
      runtime: compatibleRuntime({ version: '0.1.0-rc.5' }),
      profiles: [compatibleProfile()],
      code: 'DSH_VERSION_UNSUPPORTED'
    },
    {
      runtime: compatibleRuntime(),
      profiles: [compatibleProfile({ bridgeCompatible: false, errorCode: 'DSH_BRIDGE_NOT_INSTALLED' })],
      code: 'DSH_BRIDGE_NOT_INSTALLED'
    }
  ]) {
    let bridgeCalls = 0
    let ptyCalls = 0
    const adapter = new DeepSeekHarnessAdapter({
      session: {
        id: `ucli-${fixture.code}`,
        cwd: 'F:\\workspace',
        adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
      },
      engine: null,
      settings: {
        inspectRuntime: async () => fixture.runtime,
        profileManager: { listProfiles: async () => ({ profiles: fixture.profiles }) },
        createBridgeServer: async () => { bridgeCalls += 1 },
        pty: { spawn() { ptyCalls += 1 } }
      }
    })
    await assert.rejects(adapter.start(), error => error.code === fixture.code)
    assert.equal(bridgeCalls, 0)
    assert.equal(ptyCalls, 0)
  }
})

test('an unsafe persisted native id is rejected before opening a bridge', async () => {
  let bridgeCalls = 0
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-unsafe-resume', cwd: 'F:\\workspace', cliSessionId: '../other-profile',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => { bridgeCalls += 1 }
    }
  })
  await assert.rejects(adapter.start(), error => error.code === 'DSH_NATIVE_SESSION_INVALID')
  assert.equal(bridgeCalls, 0)
})

test('terminal output passes through once while input waits for semantic readiness', async () => {
  let resolveHello
  const hello = new Promise(resolve => { resolveHello = resolve })
  const writes = []
  const resizes = []
  const proc = fakePtyProcess()
  proc.write = value => writes.push(value)
  proc.resize = (cols, rows) => resizes.push([cols, rows])
  const bridge = {
    endpoint: 'endpoint-one', token: 'b'.repeat(64), protocolVersion: 1,
    waitForHello: () => hello,
    async close() {}
  }
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-terminal', cwd: 'F:\\workspace',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => bridge,
      pty: { spawn: () => proc }
    }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  const starting = adapter.start()
  await new Promise(resolve => setImmediate(resolve))

  proc.dataHandler('raw tui bytes')
  assert.equal(adapter.writeInput('premature'), false)
  assert.deepEqual(events.filter(({ type }) => type === 'terminal').map(({ data }) => data), [
    'raw tui bytes'
  ])

  resolveHello({ surface: 'tui', profileName: 'tui' })
  await starting
  assert.equal(adapter.writeInput('accepted'), true)
  adapter.resize(132, 48)
  assert.deepEqual(writes, ['accepted'])
  assert.deepEqual(resizes, [[132, 48]])
  assert.equal(events.filter(({ type }) => type === 'ready').length, 1)
})

test('failed hello closes the owned bridge then terminates and awaits only its PTY tree', async () => {
  const cleanup = []
  const helloError = Object.assign(new Error('timeout'), { code: 'DSH_BRIDGE_HANDSHAKE_TIMEOUT' })
  const bridge = {
    endpoint: 'endpoint-failed', token: 'c'.repeat(64), protocolVersion: 1,
    waitForHello: async () => { throw helloError },
    async close() { cleanup.push('bridge') }
  }
  const proc = fakePtyProcess()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-failed', cwd: 'F:\\workspace',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => bridge,
      pty: { spawn: () => proc },
      async terminatePtyTree(ownedProc, waitForExit) {
        cleanup.push(`terminate:${ownedProc.pid}`)
        ownedProc.exitHandler({ exitCode: 143 })
        await waitForExit
        cleanup.push('exited')
      }
    }
  })

  await assert.rejects(adapter.start(), error => error.code === 'DSH_BRIDGE_HANDSHAKE_TIMEOUT')
  assert.deepEqual(cleanup, ['bridge', 'terminate:1234', 'exited'])
  assert.equal(adapter.writeInput('blocked'), false)
  assert.equal(adapter.ptyProc, null)
  assert.equal(adapter.bridge, null)
})

test('bridge semantic events map once without interpreting the terminal transcript', async () => {
  let bridgeOptions
  const proc = fakePtyProcess()
  const bridge = {
    endpoint: 'endpoint-events', token: 'd'.repeat(64), protocolVersion: 1,
    waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
    async close() {}
  }
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-events', cwd: 'F:\\workspace', cliSessionId: null,
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => { bridgeOptions = options; return bridge },
      pty: { spawn: () => proc }
    }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  await adapter.start()

  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-one', model: 'deepseek-chat' })
  proc.dataHandler('same assistant text')
  bridgeOptions.onEvent({
    type: 'assistant-committed', nativeSessionId: 'native-one', turnId: 'turn-one',
    text: 'same assistant text'
  })
  bridgeOptions.onEvent({
    type: 'tool-request', nativeSessionId: 'native-one', requestId: 'tool-one',
    tool: 'Bash', input: { command: 'npm test' }, cwd: 'F:\\workspace', command: 'npm test'
  })
  bridgeOptions.onEvent({
    type: 'tool-result', nativeSessionId: 'native-one', requestId: 'tool-one', status: 'completed'
  })
  bridgeOptions.onEvent({
    type: 'usage', nativeSessionId: 'native-one', inputTokens: 120,
    outputTokens: 30, turns: 1, model: 'deepseek-chat'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-one', turnId: 'turn-one', status: 'completed'
  })
  bridgeOptions.onEvent({
    type: 'attention', nativeSessionId: 'native-one', kind: 'approval', operation: '执行命令'
  })

  assert.deepEqual(
    events.filter(({ type }) => ['init', 'message', 'tool_call', 'tool_result', 'stats_update', 'turn_complete', 'attention'].includes(type))
      .map(event => ({ ...event, sessionId: undefined, ts: undefined })),
    [
      { type: 'stats_update', usage: { inputTokens: 0, outputTokens: 0 }, synthetic: true, costUsd: null, costAvailable: false, turns: 0, model: null, sessionId: undefined, ts: undefined },
      { type: 'init', cliSessionId: 'native-one', model: 'deepseek-chat', sessionId: undefined, ts: undefined },
      { type: 'message', role: 'assistant', text: 'same assistant text', turnId: 'turn-one', sessionId: undefined, ts: undefined },
      { type: 'tool_call', toolUseId: 'tool-one', tool: 'Bash', input: { command: 'npm test' }, cwd: 'F:\\workspace', command: 'npm test', sessionId: undefined, ts: undefined },
      { type: 'tool_result', toolUseId: 'tool-one', status: 'completed', isError: false, sessionId: undefined, ts: undefined },
      { type: 'stats_update', usage: { inputTokens: 120, outputTokens: 30 }, costUsd: null, costAvailable: false, turns: 1, completedTurns: 0, model: 'deepseek-chat', sessionId: undefined, ts: undefined },
      { type: 'turn_complete', turnId: 'turn-one', status: 'completed', sessionId: undefined, ts: undefined },
      { type: 'stats_update', usage: { inputTokens: 120, outputTokens: 30 }, costUsd: null, costAvailable: false, turns: 1, completedTurns: 1, model: 'deepseek-chat', sessionId: undefined, ts: undefined },
      { type: 'attention', kind: 'approval', operation: '执行命令', sessionId: undefined, ts: undefined }
    ]
  )
  assert.equal(events.filter(({ type }) => type === 'message').length, 1)
})

test('native session identity is announced once and a conflicting id fails closed', async () => {
  let bridgeOptions
  const cleanup = []
  const proc = fakePtyProcess()
  const bridge = {
    endpoint: 'endpoint-native', token: 'e'.repeat(64), protocolVersion: 1,
    waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
    async close() { cleanup.push('bridge') }
  }
  const session = {
    id: 'ucli-native', cwd: 'F:\\workspace', cliSessionId: null,
    adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
  }
  const adapter = new DeepSeekHarnessAdapter({
    session,
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => { bridgeOptions = options; return bridge },
      pty: { spawn: () => proc },
      async terminatePtyTree(_proc, waitForExit) {
        cleanup.push('terminate')
        proc.exitHandler({ exitCode: 1 })
        await waitForExit
      }
    }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  await adapter.start()

  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-one' })
  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-one' })
  bridgeOptions.onEvent({ type: 'session-ready', nativeSessionId: 'native-two' })
  await adapter._cleanupPromise

  assert.equal(session.cliSessionId, null)
  assert.deepEqual(events.filter(({ type }) => type === 'init').map(({ cliSessionId }) => cliSessionId), [
    'native-one'
  ])
  assert.equal(events.find(({ code }) => code === 'DSH_NATIVE_SESSION_MISMATCH')?.type, 'error')
  assert.deepEqual(cleanup, ['bridge', 'terminate'])
  assert.equal(adapter.writeInput('blocked'), false)
})

test('permission RPC maps bridge metadata into the session engine contract', async () => {
  let bridgeOptions
  let engineCall
  const signal = new AbortController().signal
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-permission', cwd: 'F:\\workspace', cliSessionId: 'native-permission',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: {
      async decide(sessionId, call) {
        engineCall = { sessionId, call }
        return { verdict: 'allow', reason: 'approved' }
      }
    },
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => {
        bridgeOptions = options
        return {
          endpoint: 'endpoint-permission', token: 'f'.repeat(64), protocolVersion: 1,
          waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
          async close() {}
        }
      },
      pty: { spawn: () => fakePtyProcess() }
    }
  })
  await adapter.start()

  const decision = await bridgeOptions.onPermissionRequest({
    sessionId: 'ucli-permission',
    actor: { nativeSessionId: 'native-permission', agentId: 'agent-one', subagent: false },
    call: { callId: 'call-one', rootCallId: 'call-one', nested: false },
    tool: { name: 'Bash' },
    input: { command: 'npm test' },
    cwd: 'F:\\workspace',
    approvalRequired: true,
    signal
  })

  assert.deepEqual(engineCall, {
    sessionId: 'ucli-permission',
    call: {
      tool: 'Bash', input: { command: 'npm test' }, cwd: 'F:\\workspace',
      approvalRequired: true, signal
    }
  })
  assert.deepEqual(decision, { kind: 'allow', reason: 'approved' })
})

test('permission RPC denies and disconnects a mismatched semantic root before the engine', async () => {
  let bridgeOptions
  let engineCalls = 0
  const proc = fakePtyProcess()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-wrong-actor', cwd: 'F:\\workspace', cliSessionId: 'native-owner',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: { async decide() { engineCalls += 1; return { verdict: 'allow' } } },
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => {
        bridgeOptions = options
        return {
          endpoint: 'endpoint-wrong-actor', token: '6'.repeat(64), protocolVersion: 1,
          waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }), async close() {}
        }
      },
      pty: { spawn: () => proc },
      async terminatePtyTree(ownedProc, waitForExit) {
        ownedProc.exitHandler({ exitCode: 1 })
        await waitForExit
      }
    }
  })
  await adapter.start()

  const result = await bridgeOptions.onPermissionRequest({
    actor: { nativeSessionId: 'native-other' },
    tool: { name: 'Bash' }, input: {}, approvalRequired: false
  })
  assert.deepEqual(result, { kind: 'deny', reason: 'DSH native session mismatch' })
  assert.equal(engineCalls, 0)
  assert.equal(adapter.writeInput('blocked'), false)
  await adapter._cleanupPromise
})

test('incremental DSH usage resumes from persisted cumulative statistics', async () => {
  let bridgeOptions
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-stats', cwd: 'F:\\workspace', cliSessionId: 'native-stats', model: 'deepseek-chat',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      initialStats: { tokens: { input: 100, output: 25 }, turns: 4, completedTurns: 4 },
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => {
        bridgeOptions = options
        return {
          endpoint: 'endpoint-stats', token: '1'.repeat(64), protocolVersion: 1,
          waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }), async close() {}
        }
      },
      pty: { spawn: () => fakePtyProcess() }
    }
  })
  const stats = []
  adapter.on('event', event => {
    if (event.type === 'stats_update' && !event.synthetic) stats.push(event)
  })
  await adapter.start()
  bridgeOptions.onEvent({
    type: 'usage', nativeSessionId: 'native-stats', inputTokens: 10, outputTokens: 5,
    turns: 1, model: 'deepseek-chat'
  })
  bridgeOptions.onEvent({
    type: 'usage', nativeSessionId: 'native-stats', inputTokens: 2, outputTokens: 1,
    turns: 0, model: 'deepseek-chat'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-stats', turnId: 'turn-aborted', status: 'aborted'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-stats', turnId: 'turn-completed', status: 'completed'
  })
  bridgeOptions.onEvent({
    type: 'turn-complete', nativeSessionId: 'native-stats', turnId: 'turn-completed', status: 'completed'
  })

  assert.deepEqual(stats.map(event => ({
    input: event.usage.inputTokens,
    output: event.usage.outputTokens,
    turns: event.turns,
    completed: event.completedTurns
  })), [
    { input: 110, output: 30, turns: 5, completed: 4 },
    { input: 112, output: 31, turns: 5, completed: 4 },
    { input: 112, output: 31, turns: 5, completed: 4 },
    { input: 112, output: 31, turns: 5, completed: 5 },
    { input: 112, output: 31, turns: 5, completed: 5 }
  ])
})

test('bridge disconnect becomes non-accepting immediately and disposes the exact PTY once', async () => {
  let bridgeOptions
  let terminateCalls = 0
  const proc = fakePtyProcess()
  const bridge = {
    endpoint: 'endpoint-disconnect', token: '2'.repeat(64), protocolVersion: 1,
    waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
    async close() {}
  }
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-disconnect', cwd: 'F:\\workspace', cliSessionId: 'native-disconnect',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async options => { bridgeOptions = options; return bridge },
      pty: { spawn: () => proc },
      async terminatePtyTree(ownedProc, waitForExit) {
        terminateCalls += 1
        assert.equal(ownedProc, proc)
        ownedProc.exitHandler({ exitCode: 1 })
        await waitForExit
      }
    }
  })
  await adapter.start()

  bridgeOptions.onDisconnect(Object.assign(new Error('gone'), { code: 'DSH_BRIDGE_DISCONNECTED' }))
  assert.equal(adapter.writeInput('blocked immediately'), false)
  await assert.rejects(adapter.sendTurn('blocked'), error => error.code === 'DSH_BRIDGE_DISCONNECTED')
  assert.deepEqual(await bridgeOptions.onPermissionRequest({}), {
    kind: 'deny', reason: 'UCLI permission handler unavailable'
  })
  await adapter._cleanupPromise
  assert.equal(terminateCalls, 1)
  assert.equal(adapter.ptyProc, null)
  assert.equal(adapter.bridge, null)
})

test('natural PTY exit closes the bridge without trying to kill a reusable pid', async () => {
  let bridgeCloses = 0
  let terminateCalls = 0
  const proc = fakePtyProcess()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-natural-exit', cwd: 'F:\\workspace', cliSessionId: 'native-natural',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => ({
        endpoint: 'endpoint-natural', token: '3'.repeat(64), protocolVersion: 1,
        waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
        async close() { bridgeCloses += 1 }
      }),
      pty: { spawn: () => proc },
      async terminatePtyTree() { terminateCalls += 1 }
    }
  })
  await adapter.start()

  proc.exitHandler({ exitCode: 0 })
  await adapter._cleanupPromise
  await adapter.dispose()
  assert.equal(bridgeCloses, 1)
  assert.equal(terminateCalls, 0)
  assert.equal(adapter.ptyProc, null)
})

test('dispose is one shared cleanup and still terminates when bridge close fails', async () => {
  let terminateCalls = 0
  let closeCalls = 0
  const proc = fakePtyProcess()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-dispose', cwd: 'F:\\workspace', cliSessionId: 'native-dispose',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => ({
        endpoint: 'endpoint-dispose', token: '4'.repeat(64), protocolVersion: 1,
        waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
        async close() {
          closeCalls += 1
          if (closeCalls <= 2) {
            throw Object.assign(new Error('close failed'), { code: 'DSH_BRIDGE_SERVER_CLOSE_FAILED' })
          }
        }
      }),
      pty: { spawn: () => proc },
      async terminatePtyTree(ownedProc, waitForExit) {
        terminateCalls += 1
        ownedProc.exitHandler({ exitCode: 1 })
        await waitForExit
      }
    }
  })
  await adapter.start()

  const first = adapter.dispose()
  const second = adapter.dispose()
  assert.equal(first, second)
  await assert.rejects(first, error => error.code === 'DSH_BRIDGE_SERVER_CLOSE_FAILED')
  assert.equal(terminateCalls, 1)
  assert.notEqual(adapter.bridge, null)

  await adapter.dispose()
  assert.equal(closeCalls, 3)
  assert.equal(terminateCalls, 1)
  assert.equal(adapter.bridge, null)
})

test('resume awaits cleanup and launches a new isolated bridge with exact resume argv', async () => {
  const bridges = []
  const spawns = []
  const procs = []
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-resume', cwd: 'F:\\workspace', cliSessionId: null,
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => {
        const index = bridges.length + 1
        const bridge = {
          endpoint: `endpoint-${index}`,
          token: String(index).repeat(64),
          protocolVersion: 1,
          waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
          async close() { bridge.closed = true }
        }
        bridges.push(bridge)
        return bridge
      },
      pty: {
        spawn(file, args, options) {
          const proc = fakePtyProcess()
          proc.pid += procs.length
          procs.push(proc)
          spawns.push({ file, args, options })
          return proc
        }
      },
      async terminatePtyTree(proc, waitForExit) {
        proc.exitHandler({ exitCode: 0 })
        await waitForExit
      }
    }
  })
  await adapter.start()
  await adapter.resume('native-resumed')

  assert.equal(bridges.length, 2)
  assert.notEqual(bridges[0], bridges[1])
  assert.equal(bridges[0].closed, true)
  assert.notEqual(spawns[0].options.env.UCLI_DSH_BRIDGE_ENDPOINT, spawns[1].options.env.UCLI_DSH_BRIDGE_ENDPOINT)
  assert.notEqual(spawns[0].options.env.UCLI_DSH_BRIDGE_TOKEN, spawns[1].options.env.UCLI_DSH_BRIDGE_TOKEN)
  assert.deepEqual(spawns[1].args, [
    'C:\\dsh\\lib\\bin.js', '--profile', 'tui', '--resume', 'native-resumed'
  ])
  assert.equal(adapter.writeInput('new process'), true)
  assert.deepEqual(procs[1].writes || [], [])
})

test('dispose during runtime inspection prevents a stale start from creating resources', async () => {
  let resolveRuntime
  const runtime = new Promise(resolve => { resolveRuntime = resolve })
  let bridgeCalls = 0
  let ptyCalls = 0
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-start-race', cwd: 'F:\\workspace',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: () => runtime,
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => { bridgeCalls += 1 },
      pty: { spawn() { ptyCalls += 1 } }
    }
  })

  const starting = adapter.start()
  const disposing = adapter.dispose()
  resolveRuntime(compatibleRuntime())
  await disposing
  await assert.rejects(starting, error => error.code === 'DSH_ADAPTER_STOPPED')
  assert.equal(bridgeCalls, 0)
  assert.equal(ptyCalls, 0)
  assert.equal(adapter.bridge, null)
  assert.equal(adapter.ptyProc, null)
})

test('concurrent resume attempts cannot overwrite a live transition', async () => {
  let releaseClose
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const proc = fakePtyProcess()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'ucli-resume-race', cwd: 'F:\\workspace', cliSessionId: 'native-old',
      adapterConfig: { surfacePreference: 'tui', profileName: 'tui' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => compatibleRuntime(),
      profileManager: { listProfiles: async () => ({ profiles: [compatibleProfile()] }) },
      createBridgeServer: async () => ({
        endpoint: 'endpoint-resume-race', token: '5'.repeat(64), protocolVersion: 1,
        waitForHello: async () => ({ surface: 'tui', profileName: 'tui' }),
        close: () => closeGate
      }),
      pty: { spawn: () => proc },
      async terminatePtyTree(ownedProc, waitForExit) {
        ownedProc.exitHandler({ exitCode: 0 })
        await waitForExit
      }
    }
  })
  await adapter.start()

  const first = adapter.resume('native-first')
  const second = adapter.resume('native-second')
  releaseClose()
  await assert.rejects(second, error => error.code === 'DSH_LIFECYCLE_BUSY')
  await first
  assert.equal(adapter.session.cliSessionId, 'native-first')
})
