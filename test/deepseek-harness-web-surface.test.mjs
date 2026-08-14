import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  launchDshWebSurface,
  normalizeDshWebSurfaceState,
  parseDshWebReadyUrl,
  terminateDshWebProcessTree
} from '../electron/adapters/deepSeekHarnessRuntime.js'
import { DeepSeekHarnessAdapter } from '../electron/adapters/deepSeekHarnessAdapter.js'
import { DSH_WEB_CAPABILITIES } from '../electron/adapters/adapterCapabilities.js'
import { resolveAdapterCapabilities } from '../electron/adapters/adapterCapabilities.js'
import { deepSeekHarnessDescriptor } from '../electron/adapters/deepSeekHarnessAdapter.js'
import {
  deriveHostedWebSurface,
  DSH_WEB_IFRAME_ALLOW,
  DSH_WEB_IFRAME_SANDBOX
} from '../src/sessionSurfacePresentation.js'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const TEST_DSH_HOME = resolve('test/fixtures/dsh-web-home')
const TEST_EXECUTABLE = resolve('test/fixtures/dsh-web-node')
const TEST_ENTRY = resolve('test/fixtures/dsh-web-entry.js')
const TEST_CWD = resolve('test/fixtures/dsh-web-workspace')

function fakeChild(pid = 43127) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

test('DSH Web readiness accepts only an exact loopback origin with a valid port', () => {
  assert.equal(
    parseDshWebReadyUrl('dsh web: http://127.0.0.1:43127'),
    'http://127.0.0.1:43127'
  )
  for (const unsafe of [
    'dsh web: http://localhost:43127',
    'dsh web: http://[::1]:43127',
    'dsh web: http://0.0.0.0:43127',
    'dsh web: http://192.168.1.9:43127',
    'dsh web: http://user@127.0.0.1:43127',
    'dsh web: http://127.0.0.1:43127/path',
    'dsh web: http://127.0.0.1:43127?query=1',
    'dsh web: http://127.0.0.1:43127#fragment',
    'dsh web: http://127.0.0.1:0',
    'dsh web: http://127.0.0.1:65536',
    '\u001b[32mdsh web: http://127.0.0.1:43127\u001b[0m'
  ]) {
    assert.equal(parseDshWebReadyUrl(unsafe), null, unsafe)
  }
})

test('DSH Web launch uses fixed argv and publishes only a complete validated stdout line', async () => {
  const child = fakeChild()
  const launches = []
  const states = []
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [TEST_ENTRY] }
    },
    cwd: TEST_CWD,
    env: {
      PATH: 'C:\\Windows',
      UCLI_DSH_BRIDGE_ENDPOINT: 'secret-endpoint',
      UCLI_DSH_BRIDGE_TOKEN: 'secret-token',
      UCLI_DSH_BRIDGE_PROTOCOL: '1',
      ucli_dsh_bridge_future_secret: 'secret-future-value',
      dsh_home: 'C:\\wrong-home'
    },
    platform: 'win32',
    spawnProcess(file, args, options) {
      launches.push({ file, args, options })
      return child
    },
    terminateProcessTree: async () => true,
    onState: state => states.push(state)
  })
  child.stdout.write('dsh web: http://127.0.0.1:')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(states.at(-1).status, 'starting')
  child.stdout.write('43127\n')

  assert.deepEqual(await controller.ready, {
    kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
  })
  assert.deepEqual(launches[0].args, [
    TEST_ENTRY, 'web', '--host', '127.0.0.1', '--port', '0'
  ])
  assert.equal(launches[0].options.shell, false)
  assert.equal(launches[0].options.cwd, TEST_CWD)
  assert.equal(launches[0].options.env.DSH_HOME, TEST_DSH_HOME)
  assert.equal(launches[0].options.env.dsh_home, undefined)
  assert.equal(launches[0].options.env.UCLI_DSH_BRIDGE_ENDPOINT, undefined)
  assert.equal(launches[0].options.env.UCLI_DSH_BRIDGE_TOKEN, undefined)
  assert.equal(launches[0].options.env.UCLI_DSH_BRIDGE_PROTOCOL, undefined)
  assert.equal(launches[0].options.env.ucli_dsh_bridge_future_secret, undefined)
  await controller.stop()
})

test('DSH Web readiness fails when either startup stream exceeds its cumulative byte budget', async () => {
  for (const streamName of ['stdout', 'stderr']) {
    const child = fakeChild()
    const controller = launchDshWebSurface({
      runtime: {
        home: TEST_DSH_HOME,
        launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
      },
      cwd: TEST_CWD,
      platform: 'win32',
      spawnProcess: () => child,
      terminateProcessTree: async () => true
    })
    const rejected = assert.rejects(controller.ready, error => {
      assert.equal(error.code, 'DSH_WEB_READY_URL_INVALID')
      return true
    })
    child[streamName].write(Buffer.alloc(16 * 1024, 0x78))
    child[streamName].write('x')
    if (streamName === 'stdout') {
      child.stdout.write('\ndsh web: http://127.0.0.1:43127\n')
    }
    await rejected
    assert.equal(controller.state.status, 'error')
    assert.equal(controller.state.url, null)
  }
})

test('DSH Web accepts a complete ready line before later bytes in the same stdout chunk exceed the budget', async () => {
  const child = fakeChild()
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => true
  })
  const readyLine = Buffer.from('dsh web: http://127.0.0.1:43127\n')
  child.stdout.write(Buffer.concat([readyLine, Buffer.alloc(16 * 1024, 0x78)]))

  assert.equal((await controller.ready).url, 'http://127.0.0.1:43127')
  await controller.stop()
})

test('DSH Web drains both raw streams after readiness without retaining or forwarding output', async () => {
  class DrainStream extends EventEmitter {
    resumeCalls = 0
    resume() { this.resumeCalls += 1 }
  }
  const child = new EventEmitter()
  child.pid = 43127
  child.stdout = new DrainStream()
  child.stderr = new DrainStream()
  const states = []
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => true,
    onState: state => states.push(state)
  })
  child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:43127\n'))
  await controller.ready
  child.stdout.emit('data', Buffer.alloc(64 * 1024, 0x78))
  child.stderr.emit('data', Buffer.alloc(64 * 1024, 0x79))

  assert.equal(child.stdout.resumeCalls, 1)
  assert.equal(child.stderr.resumeCalls, 1)
  assert.equal(states.length, 2)
  await controller.stop()
})

test('DSH Web remains stopping until one shared tree cleanup is confirmed', async () => {
  const child = fakeChild()
  let resolveCleanup
  const cleanup = new Promise(resolve => { resolveCleanup = resolve })
  let cleanupCalls = 0
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => { cleanupCalls += 1; return cleanup },
  })
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  await controller.ready
  const first = controller.stop()
  const second = controller.stop()

  assert.equal(controller.state.status, 'stopping')
  assert.equal(controller.state.url, null)
  assert.equal(cleanupCalls, 1)
  resolveCleanup(true)
  await Promise.all([first, second])
  assert.equal(controller.state.status, 'stopped')
  assert.equal(cleanupCalls, 1)
})

test('DSH Web startup failure and stop share one owned-tree cleanup attempt', async () => {
  const child = fakeChild()
  let resolveCleanup
  const cleanup = new Promise(resolve => { resolveCleanup = resolve })
  let cleanupCalls = 0
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => { cleanupCalls += 1; return cleanup }
  })
  const rejected = assert.rejects(controller.ready, {
    code: 'DSH_WEB_READY_URL_INVALID'
  })
  child.stdout.write('dsh web: http://localhost:43127\n')
  const stopped = controller.stop()

  assert.equal(cleanupCalls, 1)
  resolveCleanup(true)
  await Promise.all([rejected, stopped])
  assert.equal(cleanupCalls, 1)
})

test('DSH Web normalizes synchronous spawn failures without exposing raw errors', () => {
  assert.throws(() => launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess() {
      throw new Error('spawn C:\\secret\\dsh.exe ENOENT in C:\\private-workspace')
    }
  }), error => {
    assert.equal(error.code, 'DSH_WEB_SPAWN_FAILED')
    assert.equal(error.message, 'DSH_WEB_SPAWN_FAILED')
    return true
  })
})

test('a Web root exit stays stopping until its remaining process tree is confirmed gone', async () => {
  const child = fakeChild()
  let resolveCleanup
  const cleanup = new Promise(resolve => { resolveCleanup = resolve })
  let cleanupCalls = 0
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'linux',
    spawnProcess: () => child,
    terminateProcessTree: async () => { cleanupCalls += 1; return cleanup }
  })
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  await controller.ready
  child.emit('close', 0)

  assert.equal(controller.state.status, 'stopping')
  assert.equal(controller.state.url, null)
  assert.equal(cleanupCalls, 1)
  resolveCleanup(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.state.status, 'stopped')
})

test('a normal Windows root close does not taskkill an already-dead PID', async () => {
  const child = fakeChild()
  let cleanupCalls = 0
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => { cleanupCalls += 1; return false }
  })
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  await controller.ready
  child.emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(controller.state.status, 'stopped')
  assert.equal(controller.state.url, null)
  assert.equal(cleanupCalls, 0)
})

test('DSH Web arms a 60-second start timeout and rejects late readiness after one cleanup', async () => {
  const child = fakeChild()
  let timerCallback
  let timerDelay
  let cleanupCalls = 0
  const controller = launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: TEST_CWD,
    platform: 'win32',
    spawnProcess: () => child,
    terminateProcessTree: async () => { cleanupCalls += 1; return true },
    setTimer(callback, delay) {
      timerCallback = callback
      timerDelay = delay
      return { unref() {} }
    },
    clearTimer() {}
  })
  const rejected = assert.rejects(controller.ready, error => {
    assert.equal(error.code, 'DSH_WEB_START_TIMEOUT')
    assert.equal(error.message, 'DSH_WEB_START_TIMEOUT')
    return true
  })
  assert.equal(timerDelay, 60_000)
  timerCallback()
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  await rejected

  assert.equal(controller.state.status, 'error')
  assert.equal(controller.state.url, null)
  assert.equal(cleanupCalls, 1)
})

test('concurrent DSH Web sessions keep distinct loopback ports and ownership', async () => {
  const children = [fakeChild(43127), fakeChild(43128)]
  const cleanupCalls = [0, 0]
  const makeController = index => launchDshWebSurface({
    runtime: {
      home: TEST_DSH_HOME,
      launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
    },
    cwd: resolve(`test/fixtures/dsh-web-workspace-${index}`),
    platform: 'win32',
    spawnProcess: () => children[index],
    terminateProcessTree: async () => { cleanupCalls[index] += 1; return true }
  })
  const first = makeController(0)
  const second = makeController(1)
  children[0].stdout.write('dsh web: http://127.0.0.1:43127\n')
  children[1].stdout.write('dsh web: http://127.0.0.1:43128\n')

  assert.equal((await first.ready).url, 'http://127.0.0.1:43127')
  assert.equal((await second.ready).url, 'http://127.0.0.1:43128')
  await first.stop()
  assert.equal(second.state.status, 'ready')
  assert.deepEqual(cleanupCalls, [1, 0])
  await second.stop()
  assert.deepEqual(cleanupCalls, [1, 1])
})

test('DSH Web stop gives its POSIX process group seven seconds before a hard kill', async () => {
  const signals = []
  const waits = []
  await terminateDshWebProcessTree(
    { pid: 43210 },
    Promise.resolve(),
    {
      platform: 'linux',
      killProcess(pid, signal) { signals.push([pid, signal]) },
      async waitForGroupGone(_pid, timeoutMs) {
        waits.push(timeoutMs)
        return waits.length > 1
      }
    }
  )

  assert.deepEqual(signals, [
    [-43210, 'SIGTERM'],
    [-43210, 'SIGKILL']
  ])
  assert.deepEqual(waits, [7000, 3000])
})

test('a Web adapter publishes a validated surface and rejects UCLI-owned operations', async () => {
  const child = fakeChild()
  let terminated = 0
  const session = {
    id: 'web-session',
    adapterId: 'deepseek-harness',
    cwd: TEST_CWD,
    model: 'native',
    cliSessionId: null,
    adapterConfig: { surfacePreference: 'web' }
  }
  const adapter = new DeepSeekHarnessAdapter({
    session,
    engine: { decide: async () => ({ verdict: 'allow' }) },
    settings: {
      inspectRuntime: async () => ({
        compatible: true,
        version: '0.1.0-rc.6',
        home: TEST_DSH_HOME,
        launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
      }),
      platform: 'win32',
      spawnWebProcess: () => child,
      terminateWebProcessTree: async () => { terminated += 1; return true }
    }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  const starting = adapter.start()
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  await starting

  assert.deepEqual(session.capabilities, DSH_WEB_CAPABILITIES)
  assert.deepEqual(events.filter(event => event.type === 'surface_state').map(event => ({
    kind: event.kind, status: event.status, url: event.url, errorCode: event.errorCode
  })), [
    { kind: 'web', status: 'starting', url: null, errorCode: null },
    { kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null }
  ])
  assert.equal(adapter.writeInput('unsafe'), false)
  assert.equal(adapter.resize(120, 40), false)
  assert.equal(adapter.isGatewayLive(), false)
  assert.deepEqual(adapter.gatewayCapabilities, {
    decisions: false, planSnapshot: false, resultSnapshot: false
  })
  assert.equal(await adapter.getLatestPlanSnapshot('decision'), null)
  assert.equal(await adapter.getLatestResultSnapshot('turn'), null)
  await assert.rejects(adapter.sendTurn('not UCLI-owned'), { code: 'DSH_WEB_NATIVE_OWNERSHIP' })
  await assert.rejects(adapter.interrupt(), { code: 'DSH_WEB_NATIVE_OWNERSHIP' })
  await adapter.dispose()
  assert.equal(terminated, 1)
})

test('a same-tick Web root close wins over readiness without a trailing ready event', async () => {
  const child = fakeChild()
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'web-ready-close-race', adapterId: 'deepseek-harness', cwd: TEST_CWD,
      model: 'native', cliSessionId: null,
      adapterConfig: { surfacePreference: 'web' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => ({
        compatible: true,
        version: '0.1.0-rc.6',
        home: TEST_DSH_HOME,
        launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
      }),
      platform: 'win32',
      spawnWebProcess: () => child,
      terminateWebProcessTree: async () => true
    }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  const starting = adapter.start()
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write('dsh web: http://127.0.0.1:43127\n')
  child.emit('close', 0)

  await assert.rejects(starting, { code: 'DSH_WEB_EXITED' })
  assert.equal(events.some(event => event.type === 'ready'), false)
  assert.equal(adapter.surfaceState.status, 'stopped')
})

test('Web adapter cleanup preserves its stable startup error surface', async () => {
  const adapter = new DeepSeekHarnessAdapter({
    session: {
      id: 'web-timeout', adapterId: 'deepseek-harness', cwd: TEST_CWD,
      model: 'native', cliSessionId: null,
      adapterConfig: { surfacePreference: 'web' }
    },
    engine: null,
    settings: {
      inspectRuntime: async () => ({
        compatible: true,
        version: '0.1.0-rc.6',
        home: TEST_DSH_HOME,
        launch: { file: TEST_EXECUTABLE, prefixArgs: [] }
      }),
      launchWebSurface(options) {
        options.onState({
          kind: 'web', status: 'error', url: null,
          errorCode: 'DSH_WEB_START_TIMEOUT'
        })
        return {
          ready: Promise.reject(Object.assign(new Error('DSH_WEB_START_TIMEOUT'), {
            code: 'DSH_WEB_START_TIMEOUT'
          })),
          stop: async () => true
        }
      }
    }
  })
  await assert.rejects(adapter.start(), { code: 'DSH_WEB_START_TIMEOUT' })

  assert.equal(adapter.surfaceState.status, 'error')
  assert.equal(adapter.surfaceState.errorCode, 'DSH_WEB_START_TIMEOUT')
})

test('normalized Web configuration selects native capabilities before adapter launch', () => {
  assert.deepEqual(resolveAdapterCapabilities(
    deepSeekHarnessDescriptor,
    { surfacePreference: 'web' }
  ), DSH_WEB_CAPABILITIES)
})

test('Web surface state exposes only validated URLs and stable error codes', () => {
  assert.deepEqual(normalizeDshWebSurfaceState({
    status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
  }), {
    kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
  })
  assert.equal(normalizeDshWebSurfaceState({
    status: 'ready', url: 'http://127.0.0.1:99999', errorCode: null
  }), null)
  assert.equal(normalizeDshWebSurfaceState({
    status: 'error', url: null, errorCode: 'C:\\private\\raw-error'
  }), null)
  assert.deepEqual(normalizeDshWebSurfaceState({
    status: 'error', url: null, errorCode: 'DSH_WEB_START_TIMEOUT'
  }), {
    kind: 'web', status: 'error', url: null, errorCode: 'DSH_WEB_START_TIMEOUT'
  })
})

test('the renderer binds only a revalidated URL in a fixed sandbox allowed by narrow CSP', () => {
  assert.deepEqual(deriveHostedWebSurface({
    kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
  }), {
    kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
  })
  assert.equal(deriveHostedWebSurface({
    kind: 'web', status: 'ready', url: 'http://127.0.0.1:99999', errorCode: null
  }).status, 'error')

  const component = readFileSync(new URL(
    '../src/components/HostedWebSurface.vue', import.meta.url
  ), 'utf8')
  assert.match(component, /<iframe/u)
  assert.match(component, /:src="view\.url"/u)
  assert.match(component, new RegExp(`sandbox="${DSH_WEB_IFRAME_SANDBOX}"`, 'u'))
  assert.match(component, new RegExp(`allow="${DSH_WEB_IFRAME_ALLOW}"`, 'u'))
  assert.doesNotMatch(component, /<webview/u)

  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8')
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\*/u)
  assert.doesNotMatch(html, /connect-src[^;]*127\.0\.0\.1/u)
  const frameDirective = html.match(/frame-src[^;]*/u)?.[0]
  assert.equal(frameDirective, 'frame-src http://127.0.0.1:*')
  assert.doesNotMatch(html, /unsafe-eval/u)
})

test('orchestrator keeps Web surface status nested and distinct from session status', async () => {
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
  const root = mkdtempSync(join(tmpdir(), 'ucli-dsh-web-orchestrator-'))
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = root
  const sent = []
  const originalStart = DeepSeekHarnessAdapter.prototype.start
  DeepSeekHarnessAdapter.prototype.start = async function () {
    this._onWebSurfaceState({
      kind: 'web', status: 'ready', url: 'http://127.0.0.1:43127', errorCode: null
    }, this._epoch)
    this.emitEvent({ type: 'ready' })
    return true
  }
  let orchestrator
  try {
    const module = await import(`../electron/orchestrator.js?dsh-web=${Date.now()}`)
    orchestrator = module.createOrchestrator()
    orchestrator.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
    })
    orchestrator.registerIpc()
    const created = handlers.get('session:create')({}, {
      adapterId: 'deepseek-harness', cwd: TEST_CWD,
      adapterConfig: {
        surfacePreference: 'web', profileName: 'must-not-survive',
        unknown: 'must-not-survive'
      }
    })
    assert.deepEqual(created.adapterConfig, { surfacePreference: 'web' })
    assert.equal(created.capabilities.surface, 'web')
    assert.equal(created.capabilities.gateway, false)
    assert.equal(created.surfaceState.status, 'starting')
    const { sessionId } = created
    await handlers.get('session:start-adapter')({}, sessionId)

    const event = sent.find(item =>
      item.channel === 'session:event' && item.payload.type === 'surface_state'
    )?.payload
    assert.equal(event.status, 'starting')
    assert.equal(event.surfaceState.status, 'ready')
    assert.equal(event.surfaceState.url, 'http://127.0.0.1:43127')
    const listed = handlers.get('session:list')().find(item => item.id === sessionId)
    assert.equal(listed.capabilities.surface, 'web')
    assert.equal(listed.capabilities.gateway, false)
    assert.equal(listed.surfaceState.status, 'ready')
  } finally {
    DeepSeekHarnessAdapter.prototype.start = originalStart
    await orchestrator?.shutdown()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})
