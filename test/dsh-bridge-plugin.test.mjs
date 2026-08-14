import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import {
  DSH_BRIDGE_CAPABILITIES,
  apply,
  internals,
  name
} from '../integrations/deepseek-harness-bridge/index.js'
import {
  BridgeFrameDecoder,
  DSH_BRIDGE_MAX_FRAME_BYTES,
  encodeBridgeFrame
} from '../integrations/deepseek-harness-bridge/framing.js'

const realLoadSandboxPolicy = internals.loadSandboxPolicy
internals.loadSandboxPolicy = async () => ({
  effectiveSandboxMode: () => 'workspace-write',
  setSandboxMode() {}
})
test.after(() => { internals.loadSandboxPolicy = realLoadSandboxPolicy })

class FakeContext {
  constructor(roots = [], agents = roots) {
    this.listeners = new Map()
    this.cleanups = []
    this.agents = {
      list: () => [...agents],
      roots: () => [...roots],
      get: (id) => agents.find((agent) => agent.id === id),
      isOwnedBy: (id, owner) => {
        const child = agents.find((agent) => agent.id === id)
        return Boolean(child && !roots.includes(child) && roots.length === 1 && owner === roots[0])
      }
    }
    this.sessions = {}
  }

  effect(setup) {
    const cleanup = setup()
    if (typeof cleanup === 'function') this.cleanups.push(cleanup)
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  async waterfall(event, ...args) {
    const listeners = [...(this.listeners.get(event) ?? [])]
    assert.equal(listeners.length, 1, `${event} must have exactly one listener`)
    return listeners[0](...args)
  }

  dispose() {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
  }
}

function withBridgeEnvironment(values, callback) {
  const keys = [
    'UCLI_DSH_BRIDGE_ENDPOINT',
    'UCLI_DSH_BRIDGE_TOKEN',
    'UCLI_DSH_BRIDGE_PROTOCOL'
  ]
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  return Promise.resolve(callback()).finally(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  })
}

async function createHost() {
  const frames = []
  const waiters = []
  let peer
  let peerClosed
  const server = net.createServer((socket) => {
    peer = socket
    peerClosed = once(socket, 'close')
    const decoder = new BridgeFrameDecoder((frame) => {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else frames.push(frame)
    })
    socket.on('data', (chunk) => decoder.push(chunk))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    endpoint: 'test-only-endpoint',
    connect: () => net.createConnection({ host: '127.0.0.1', port: address.port }),
    nextFrame(label = 'plugin frame') {
      if (frames.length > 0) return Promise.resolve(frames.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000)
        waiters.push((frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
      })
    },
    write(frame) {
      peer.write(encodeBridgeFrame(frame))
    },
    async drainAfter(delay = 100) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return frames.splice(0)
    },
    waitForPeerClose() {
      return peerClosed
    },
    async close() {
      peer?.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

function fakeAgent(overrides = {}) {
  const session = {
    id: 'native-session-1',
    header: { cwd: 'C:\\workspace' },
    ...overrides.session
  }
  return {
    id: session.id,
    session,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    status: 'idle',
    ...overrides
  }
}

async function activatePlugin(ctx, host, profileName = 'tui-local') {
  const token = 'a'.repeat(64)
  const previousCreateConnection = internals.createConnection
  internals.createConnection = host.connect
  await withBridgeEnvironment({
    UCLI_DSH_BRIDGE_ENDPOINT: host.endpoint,
    UCLI_DSH_BRIDGE_TOKEN: token,
    UCLI_DSH_BRIDGE_PROTOCOL: '1'
  }, async () => {
    apply(ctx, { argv: ['node', 'dsh', '--profile', profileName] })
    const hello = await host.nextFrame()
    assert.deepEqual(hello, {
      type: 'hello',
      protocolVersion: 1,
      token,
      bridgeVersion: '0.11.0',
      profileName,
      surface: 'tui',
      capabilities: DSH_BRIDGE_CAPABILITIES
    })
    host.write({ type: 'hello-ack', protocolVersion: 1 })
    const deadline = Date.now() + 1_000
    while ((ctx.listeners.get('session/event')?.size ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(ctx.listeners.get('session/event')?.size, 1)
  }).finally(() => { internals.createConnection = previousCreateConnection })
}

async function assertPermissionHooksFailClosed(ctx) {
  const active = [...ctx.listeners]
    .filter(([, listeners]) => listeners.size > 0)
    .map(([event, listeners]) => [event, listeners.size])
    .sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(active, [
    ['approval/request', 1],
    ['tools/pre-execute', 1]
  ])

  let delegated = 0
  assert.deepEqual(
    await ctx.waterfall('tools/pre-execute', {}, async () => {
      delegated += 1
      return { kind: 'allow' }
    }),
    { kind: 'deny', reason: 'UCLI permission bridge disconnected' }
  )
  assert.equal(delegated, 0)
  assert.equal(
    await ctx.waterfall('approval/request', {}, async () => 'allowed-once'),
    'rejected'
  )
}

function assertAllListenersDisposed(ctx) {
  assert.equal([...ctx.listeners.values()].every((listeners) => listeners.size === 0), true)
}

test('framing is standalone, bounded, fatal UTF-8, plain-object only, and fail-stop', () => {
  assert.equal(DSH_BRIDGE_MAX_FRAME_BYTES, 1024 * 1024)
  const seen = []
  const decoder = new BridgeFrameDecoder((frame) => seen.push(frame))
  const encoded = encodeBridgeFrame({ type: 'hello', text: '你好' })
  decoder.push(encoded.subarray(0, 3))
  decoder.push(encoded.subarray(3))
  assert.deepEqual(seen, [{ type: 'hello', text: '你好' }])

  assert.throws(() => encodeBridgeFrame([]), (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID')
  assert.throws(
    () => encodeBridgeFrame({ body: 'x'.repeat(DSH_BRIDGE_MAX_FRAME_BYTES) }),
    (error) => error.code === 'DSH_BRIDGE_FRAME_TOO_LARGE'
  )

  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28])
  assert.throws(() => decoder.push(invalidUtf8), (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID')
  assert.throws(() => decoder.push(encoded), (error) => error.code === 'DSH_BRIDGE_FRAME_INVALID')
})

test('framing keeps one-byte fragments and giant coalesced input bounded by one frame', () => {
  const frames = Array.from({ length: 4_096 }, (_, index) => ({ type: 'event', index }))
  const giant = Buffer.concat(frames.map((frame) => encodeBridgeFrame(frame)))
  assert.ok(giant.length > 100_000)
  let count = 0
  const decoder = new BridgeFrameDecoder(() => { count += 1 })
  for (const byte of giant.subarray(0, 513)) {
    decoder.push(Buffer.of(byte))
    assert.ok(decoder.bufferedBytes <= DSH_BRIDGE_MAX_FRAME_BYTES + 4)
  }
  decoder.push(giant.subarray(513))
  assert.equal(count, frames.length)
  assert.equal(decoder.bufferedBytes, 0)
})

test('plugin is a strict no-op unless endpoint, token, and protocol are all present', async () => {
  assert.equal(name, 'ucli-dsh-bridge')
  for (const missing of [
    ['UCLI_DSH_BRIDGE_ENDPOINT'],
    ['UCLI_DSH_BRIDGE_TOKEN'],
    ['UCLI_DSH_BRIDGE_PROTOCOL'],
    ['UCLI_DSH_BRIDGE_ENDPOINT', 'UCLI_DSH_BRIDGE_TOKEN', 'UCLI_DSH_BRIDGE_PROTOCOL']
  ]) {
    const ctx = new FakeContext()
    const values = {
      UCLI_DSH_BRIDGE_ENDPOINT: '127.0.0.1:9',
      UCLI_DSH_BRIDGE_TOKEN: 'a'.repeat(64),
      UCLI_DSH_BRIDGE_PROTOCOL: '1'
    }
    for (const key of missing) delete values[key]
    await withBridgeEnvironment(values, () => apply(ctx, { argv: ['dsh', '--profile', 'tui'] }))
    assert.equal(ctx.cleanups.length, 0)
    assert.equal(ctx.listeners.size, 0)
  }
})

test('plugin subscribes only after hello-ack, projects official events, and fully disposes', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())

  const consoleMethods = ['log', 'warn', 'error']
  const consoleBefore = Object.fromEntries(consoleMethods.map((method) => [method, console[method]]))
  const writes = []
  for (const method of consoleMethods) console[method] = (...args) => writes.push([method, args.join(' ')])
  t.after(() => {
    for (const method of consoleMethods) console[method] = consoleBefore[method]
  })

  await activatePlugin(ctx, host)
  const initialReady = await host.nextFrame('initial session-ready')
  const initialStatus = await host.nextFrame('initial agent-status')
  assert.deepEqual(initialReady, {
    type: 'session-ready',
    nativeSessionId: 'native-session-1',
    cwd: 'C:\\workspace',
    model: 'deepseek-chat'
  })
  assert.deepEqual(initialStatus, {
    type: 'agent-status',
    nativeSessionId: 'native-session-1',
    status: 'idle'
  })

  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/chunk',
    data: { turn: 7, step: 1, chunk: { type: 'text-delta', text: 'draft' } }
  })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/chunk',
    data: {
      turn: 7,
      step: 1,
      chunk: {
        type: 'usage',
        usage: {
          inputTokens: 12, outputTokens: 5, cacheReadTokens: 3,
          cacheWriteTokens: 9, reasoningTokens: 4
        }
      }
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 7,
      step: 1,
      message: { content: [{ type: 'text', text: 'committed answer' }] },
      usage: {
        inputTokens: 12, outputTokens: 5, cacheReadTokens: 3,
        cacheWriteTokens: 9, reasoningTokens: 4
      }
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'tool/call',
    data: {
      turn: 7,
      step: 2,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"npm test"}'
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'tool/result',
    data: {
      turn: 7,
      step: 2,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }]
      }
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'tool/call',
    data: {
      turn: 7,
      step: 3,
      callId: 'plan-1',
      name: 'exit_plan_mode',
      arguments: '{"plan":"# Ship\\n\\nRun tests."}'
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 7, reason: { kind: 'completed' } }
  })
  ctx.emit('agent/error', { agent, turn: 7, step: 3, error: new Error('private failure') })

  const projected = await host.drainAfter()
  assert.deepEqual(projected, [
    { type: 'agent-status', nativeSessionId: 'native-session-1', status: 'running' },
    {
      type: 'usage', nativeSessionId: 'native-session-1', inputTokens: 24,
      outputTokens: 5, turns: 1, model: 'deepseek-chat'
    },
    {
      type: 'assistant-committed', nativeSessionId: 'native-session-1',
      turnId: '7', text: 'committed answer'
    },
    {
      type: 'tool-request', requestId: 'call-1', nativeSessionId: 'native-session-1',
      tool: 'bash', input: { command: 'npm test' }, cwd: 'C:\\workspace', command: 'npm test'
    },
    {
      type: 'tool-result', requestId: 'call-1', nativeSessionId: 'native-session-1',
      status: 'completed'
    },
    {
      type: 'tool-request', requestId: 'plan-1', nativeSessionId: 'native-session-1',
      tool: 'exit_plan_mode', input: { plan: '# Ship\n\nRun tests.' }, cwd: 'C:\\workspace'
    },
    { type: 'plan-snapshot', nativeSessionId: 'native-session-1', markdown: '# Ship\n\nRun tests.' },
    { type: 'turn-complete', nativeSessionId: 'native-session-1', turnId: '7', status: 'completed' },
    { type: 'result-snapshot', nativeSessionId: 'native-session-1', markdown: 'committed answer' },
    {
      type: 'attention', nativeSessionId: 'native-session-1',
      kind: 'question', operation: 'agent-error'
    }
  ])
  assert.deepEqual(writes, [])

  const activeCounts = Object.fromEntries([...ctx.listeners].map(([event, listeners]) => [event, listeners.size]))
  assert.deepEqual(activeCounts, {
    'tools/pre-execute': 1,
    'approval/request': 1,
    'agent/created': 1,
    'agent/disposed': 1,
    'agent/status': 1,
    'agent/error': 1,
    'session/created': 1,
    'session/disposed': 1,
    'session/event': 1
  })
  ctx.dispose()
  assert.equal([...ctx.listeners.values()].every((listeners) => listeners.size === 0), true)
})

test('invalid hello-ack never activates event subscriptions', async (t) => {
  const ctx = new FakeContext([fakeAgent()])
  const host = await createHost()
  t.after(() => host.close())
  await withBridgeEnvironment({
    UCLI_DSH_BRIDGE_ENDPOINT: host.endpoint,
    UCLI_DSH_BRIDGE_TOKEN: 'b'.repeat(64),
    UCLI_DSH_BRIDGE_PROTOCOL: '1'
  }, async () => {
    const previousCreateConnection = internals.createConnection
    internals.createConnection = host.connect
    apply(ctx, { argv: ['dsh', '--profile=tui-local'] })
    await host.nextFrame()
    host.write({ type: 'hello-ack', protocolVersion: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    internals.createConnection = previousCreateConnection
  })
  await assertPermissionHooksFailClosed(ctx)
  ctx.dispose()
  assertAllListenersDisposed(ctx)
})

test('hello-ack timeout closes the socket and dispose clears the injected timer', async (t) => {
  const ctx = new FakeContext()
  const host = await createHost()
  t.after(() => host.close())
  const previous = {
    createConnection: internals.createConnection,
    setTimeout: internals.setTimeout,
    clearTimeout: internals.clearTimeout
  }
  let scheduled
  const timer = { kind: 'hello-timeout' }
  const cleared = []
  internals.createConnection = host.connect
  internals.setTimeout = (callback, delay) => {
    assert.equal(delay, 10_000)
    scheduled = callback
    return timer
  }
  internals.clearTimeout = (value) => cleared.push(value)
  t.after(() => Object.assign(internals, previous))

  await withBridgeEnvironment({
    UCLI_DSH_BRIDGE_ENDPOINT: host.endpoint,
    UCLI_DSH_BRIDGE_TOKEN: 'c'.repeat(64),
    UCLI_DSH_BRIDGE_PROTOCOL: '1'
  }, async () => {
    apply(ctx, { argv: ['dsh', '--profile', 'tui-local'] })
    await host.nextFrame('hello before timeout')
    assert.equal(typeof scheduled, 'function')
    scheduled()
    await Promise.race([
      host.waitForPeerClose(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ack timeout did not close')), 1_000))
    ])
  })
  await assertPermissionHooksFailClosed(ctx)
  assert.deepEqual(cleared, [timer])
  ctx.dispose()
  assert.deepEqual(cleared, [timer])
  assertAllListenersDisposed(ctx)
})

test('disposing while awaiting hello-ack cancels the deadline and closes the socket', async (t) => {
  const ctx = new FakeContext()
  const host = await createHost()
  t.after(() => host.close())
  const previous = {
    createConnection: internals.createConnection,
    setTimeout: internals.setTimeout,
    clearTimeout: internals.clearTimeout
  }
  const timer = { kind: 'hello-timeout' }
  const cleared = []
  internals.createConnection = host.connect
  internals.setTimeout = (_callback, delay) => {
    assert.equal(delay, 10_000)
    return timer
  }
  internals.clearTimeout = (value) => cleared.push(value)
  t.after(() => Object.assign(internals, previous))

  await withBridgeEnvironment({
    UCLI_DSH_BRIDGE_ENDPOINT: host.endpoint,
    UCLI_DSH_BRIDGE_TOKEN: 'd'.repeat(64),
    UCLI_DSH_BRIDGE_PROTOCOL: '1'
  }, async () => {
    apply(ctx, { argv: ['dsh', '--profile', 'tui-local'] })
    await host.nextFrame('hello before dispose')
    ctx.dispose()
    await Promise.race([
      host.waitForPeerClose(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dispose did not close')), 1_000))
    ])
  })
  assert.deepEqual(cleared, [timer])
  assertAllListenersDisposed(ctx)
})

test('only root agents emit ready and status while subagent lifecycle stays private', async (t) => {
  const root = fakeAgent()
  const subagent = fakeAgent({
    id: 'native-subagent-1',
    session: { id: 'native-subagent-1', header: { cwd: 'C:\\workspace' } },
    status: 'running'
  })
  const ctx = new FakeContext([root], [root, subagent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  assert.equal((await host.nextFrame()).nativeSessionId, root.id)
  assert.equal((await host.nextFrame()).nativeSessionId, root.id)
  ctx.emit('agent/created', { agent: subagent })
  ctx.emit('agent/status', { agent: subagent, status: 'idle' })
  ctx.emit('agent/disposed', { agent: subagent })
  assert.deepEqual(await host.drainAfter(50), [])
})

test('root tracking uses the native session id when the agent id differs', async (t) => {
  const root = fakeAgent({ id: 'agent-root-1' })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  assert.equal((await host.nextFrame()).nativeSessionId, root.session.id)
  assert.equal((await host.nextFrame()).nativeSessionId, root.session.id)
  ctx.emit('session/event', root.session, {
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: { content: [{ type: 'text', text: 'kept' }] }
    }
  })
  assert.deepEqual(await host.nextFrame(), {
    type: 'assistant-committed', nativeSessionId: root.session.id, turnId: '1', text: 'kept'
  })
})

test('Unicode profile and semantic names are preserved without ASCII narrowing', async (t) => {
  const agent = fakeAgent({ options: { provider: 'deepseek', model: '深度模型' } })
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host, '中文-TUI')
  const ready = await host.nextFrame()
  assert.equal(ready.model, '深度模型')
})

test('tool JSON primitives become stable plain-object inputs', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame()
  await host.nextFrame()
  for (const [index, raw] of ['42', 'null', '[1,2]'].entries()) {
    ctx.emit('session/event', agent.session, {
      type: 'tool/call',
      data: { turn: 1, step: index + 1, callId: `call-${index}`, name: '工具', arguments: raw }
    })
  }
  const projected = await host.drainAfter(50)
  assert.deepEqual(projected.map((event) => event.input), [
    { raw: '42' },
    { raw: 'null' },
    { raw: '[1,2]' }
  ])
})

test('usage bookkeeping is released when a session id is disposed and reused', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame()
  await host.nextFrame()
  const usageEvent = {
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } } }
  }
  ctx.emit('session/event', agent.session, usageEvent)
  assert.equal((await host.nextFrame()).turns, 1)
  ctx.emit('session/disposed', agent.session)
  ctx.emit('session/event', agent.session, usageEvent)
  const reused = await host.nextFrame('usage after disposed id reuse')
  assert.deepEqual(reused, {
    type: 'usage', nativeSessionId: agent.id, inputTokens: 2,
    outputTokens: 1, turns: 1, model: 'deepseek-chat'
  })
})

test('a final usage sample replaces an earlier chunk by emitting only its delta', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame()
  await host.nextFrame()
  ctx.emit('session/event', agent.session, {
    type: 'assistant/chunk',
    data: {
      turn: 3, step: 2,
      chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    }
  })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 3, step: 2,
      message: { content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 5, outputTokens: 4 }
    }
  })
  const usageEvents = (await host.drainAfter(50)).filter((event) => event.type === 'usage')
  assert.deepEqual(usageEvents, [
    {
      type: 'usage', nativeSessionId: agent.id, inputTokens: 2,
      outputTokens: 1, turns: 1, model: 'deepseek-chat'
    },
    {
      type: 'usage', nativeSessionId: agent.id, inputTokens: 3,
      outputTokens: 3, turns: 0, model: 'deepseek-chat'
    }
  ])
  assert.deepEqual(usageEvents.reduce((total, event) => ({
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
    turns: total.turns + event.turns
  }), { inputTokens: 0, outputTokens: 0, turns: 0 }), {
    inputTokens: 5, outputTokens: 4, turns: 1
  })
})

test('committed Unicode output above 256 KiB remains connected and bounded', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame()
  await host.nextFrame()
  const text = '你'.repeat(100_000)
  assert.ok(Buffer.byteLength(text, 'utf8') > 262_144)
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text }] } }
  })
  const event = await host.nextFrame('large Unicode committed output')
  assert.equal(event.text, text)
  assert.equal(ctx.listeners.get('session/event')?.size, 1)
})

test('an active plugin process writes nothing to stdout or stderr', () => {
  const moduleUrl = new URL('../integrations/deepseek-harness-bridge/index.js', import.meta.url).href
  const script = `
    import { Duplex } from 'node:stream'
    import { apply, internals } from ${JSON.stringify(moduleUrl)}
    const encode = (value) => {
      const body = Buffer.from(JSON.stringify(value))
      const frame = Buffer.alloc(4 + body.length)
      frame.writeUInt32BE(body.length)
      body.copy(frame, 4)
      return frame
    }
    class Socket extends Duplex {
      _read() {}
      _write(_chunk, _encoding, callback) {
        if (!this.acked) {
          this.acked = true
          queueMicrotask(() => this.push(encode({ type: 'hello-ack', protocolVersion: 1 })))
        }
        callback()
      }
    }
    let cleanup
    const listeners = new Map()
    const ctx = {
      agents: { list: () => [], roots: () => [] }, sessions: {},
      effect(setup) { cleanup = setup() },
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      }
    }
    internals.createConnection = () => {
      const socket = new Socket()
      queueMicrotask(() => socket.emit('connect'))
      return socket
    }
    internals.loadSandboxPolicy = async () => ({
      effectiveSandboxMode: () => 'workspace-write',
      setSandboxMode() {}
    })
    process.env.UCLI_DSH_BRIDGE_ENDPOINT = 'test-only'
    process.env.UCLI_DSH_BRIDGE_TOKEN = 'a'.repeat(64)
    process.env.UCLI_DSH_BRIDGE_PROTOCOL = '1'
    apply(ctx, { argv: ['dsh', '--profile', 'tui-local'] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (listeners.size !== 9 || typeof cleanup !== 'function') process.exitCode = 2
    cleanup?.()
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env }
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, '')
  assert.equal(child.stderr, '')
})

test('malformed upstream events close the plugin before anything leaks', async (t) => {
  const agent = fakeAgent()
  const ctx = new FakeContext([agent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame('initial session-ready')
  await host.nextFrame('initial agent-status')

  assert.doesNotThrow(() => ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 42 }] }
    }
  }))
  await Promise.race([
    host.waitForPeerClose(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('plugin did not fail closed')), 1_000))
  ])
  await assertPermissionHooksFailClosed(ctx)
  assert.deepEqual(await host.drainAfter(20), [])
  ctx.dispose()
  assertAllListenersDisposed(ctx)
})

test('pre-execute gates root, subagent, and Code Mode calls through one UCLI decision', async (t) => {
  const root = fakeAgent()
  const subagent = fakeAgent({
    id: 'native-subagent-1',
    session: { id: 'native-subagent-1', header: { cwd: 'C:\\workspace' } }
  })
  const ctx = new FakeContext([root], [root, subagent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame()
  await host.nextFrame()

  for (const [index, execution] of [
    { callId: 'root-call', rootCallId: 'root-call', name: 'bash', arguments: { command: 'npm test' }, agent: root },
    { callId: 'sub-call', rootCallId: 'sub-call', name: 'read_file', arguments: { path: 'README.md' }, agent: subagent },
    {
      callId: 'code-call', rootCallId: 'run-code', name: 'write_file',
      arguments: { path: 'result.txt', content: 'ok' }, agent: subagent, parent: Symbol('run-code')
    }
  ].entries()) {
    const controller = new AbortController()
    let delegated = 0
    const pending = ctx.waterfall(
      'tools/pre-execute',
      { ...execution, token: Symbol(execution.callId), signal: controller.signal },
      async () => { delegated += 1; return { kind: 'allow' } }
    )
    const request = await host.nextFrame(`permission request ${execution.callId}`)
    assert.deepEqual(request, {
      type: 'request', requestId: `plugin-rpc:${index + 1}`, method: 'permission.decide',
      params: {
        actor: {
          nativeSessionId: root.session.id,
          agentId: execution.agent.id,
          subagent: execution.agent !== root
        },
        call: {
          callId: execution.callId,
          rootCallId: execution.rootCallId,
          nested: execution.parent !== undefined
        },
        tool: { name: execution.name },
        input: execution.arguments,
        cwd: 'C:\\workspace',
        approvalRequired: false
      }
    })
    const kind = index === 1 ? 'deny' : 'allow'
    host.write({
      type: 'response', requestId: request.requestId,
      result: { kind, reason: kind === 'deny' ? 'blocked' : 'approved' }
    })
    assert.deepEqual(await pending, kind === 'allow'
      ? { kind: 'allow' }
      : { kind: 'deny', reason: 'blocked' })
    assert.equal(delegated, 1)
  }
})

test('a downstream ask is answered by exactly one UCLI prompt without native UI', async (t) => {
  const root = fakeAgent()
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  let delegated = 0
  const pending = ctx.waterfall('tools/pre-execute', {
    token: Symbol('call'), callId: 'single-prompt-call', rootCallId: 'single-prompt-call',
    name: 'bash', arguments: { command: 'npm test' }, agent: root,
    signal: new AbortController().signal
  }, async () => { delegated += 1; return { kind: 'ask', reason: 'native ask' } })
  const request = await host.nextFrame()
  assert.equal(request.method, 'permission.decide')
  assert.equal(request.params.approvalRequired, true)
  host.write({
    type: 'response', requestId: request.requestId, result: { kind: 'allow' }
  })
  assert.deepEqual(await pending, { kind: 'allow' })
  assert.equal(delegated, 1)
  assert.equal(await ctx.waterfall('approval/request', {
    agent: root, callId: 'single-prompt-call', toolName: 'bash',
    signal: new AbortController().signal
  }, async () => 'unavailable'), 'rejected')
  assert.deepEqual(await host.drainAfter(20), [])
})

test('sandbox escalation arguments deny before UCLI or native approval for every actor path', async (t) => {
  const root = fakeAgent()
  const subagent = fakeAgent({
    id: 'native-subagent-1',
    session: { id: 'native-subagent-1', header: { cwd: 'C:\\workspace' } }
  })
  const ctx = new FakeContext([root], [root, subagent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  for (const [index, actor] of [root, subagent, subagent].entries()) {
    const result = await ctx.waterfall('tools/pre-execute', {
      token: Symbol(`elevated-${index}`), callId: `elevated-call-${index}`,
      rootCallId: index === 2 ? 'run-code' : `elevated-call-${index}`,
      parent: index === 2 ? Symbol('run-code') : undefined,
      name: 'shell_command',
      arguments: { command: 'npm test', sandbox_permissions: 'require_escalated' },
      agent: actor, signal: new AbortController().signal
    }, async () => ({ kind: 'allow' }))
    assert.deepEqual(result, {
      kind: 'deny', reason: 'DSH sandbox escalation is not allowed by UCLI'
    })
  }
  assert.deepEqual(await host.drainAfter(20), [])
})

test('duplicate live call ids fail closed without creating a second UCLI prompt', async (t) => {
  const root = fakeAgent()
  const subagent = fakeAgent({
    id: 'subagent-duplicate-scope',
    session: { id: 'subagent-duplicate-scope', header: { cwd: 'C:\\workspace' } }
  })
  const ctx = new FakeContext([root], [root, subagent])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()
  const execution = {
    token: Symbol('duplicate'), callId: 'duplicate-call', rootCallId: 'duplicate-call',
    name: 'bash', arguments: { command: 'npm test' }, agent: root,
    signal: new AbortController().signal
  }
  const first = ctx.waterfall('tools/pre-execute', execution, async () => ({ kind: 'allow' }))
  const request = await host.nextFrame()
  const otherActor = ctx.waterfall(
    'tools/pre-execute', { ...execution, token: Symbol('subagent'), agent: subagent },
    async () => ({ kind: 'allow' })
  )
  const otherRequest = await host.nextFrame()
  const duplicate = await ctx.waterfall(
    'tools/pre-execute', { ...execution, token: Symbol('other') },
    async () => ({ kind: 'allow' })
  )
  assert.deepEqual(duplicate, { kind: 'deny', reason: 'Duplicate DSH tool call identity' })
  host.write({ type: 'response', requestId: request.requestId, result: { kind: 'allow' } })
  host.write({ type: 'response', requestId: otherRequest.requestId, result: { kind: 'allow' } })
  assert.deepEqual(await first, { kind: 'allow' })
  assert.deepEqual(await otherActor, { kind: 'allow' })
})

test('Code Mode wrapper delegates downstream safety but only nested leaves reach UCLI', async (t) => {
  const root = fakeAgent()
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()
  assert.deepEqual(await ctx.waterfall('tools/pre-execute', {
    token: Symbol('wrapper'), callId: 'run-code', rootCallId: 'run-code', name: 'run_code',
    arguments: { code: 'await tools.read_file({path:"README.md"})' }, agent: root,
    signal: new AbortController().signal
  }, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await host.drainAfter(20), [])
})

test('permission disconnect, timeout, and caller cancellation all fail closed', async (t) => {
  const root = fakeAgent()
  const makeExecution = (callId, signal) => ({
    token: Symbol(callId), callId, rootCallId: callId, name: 'bash',
    arguments: { command: 'npm test' }, agent: root, signal
  })

  {
    const ctx = new FakeContext([root])
    const host = await createHost()
    await activatePlugin(ctx, host)
    await host.nextFrame(); await host.nextFrame()
    const pending = ctx.waterfall(
      'tools/pre-execute',
      makeExecution('disconnect-call', new AbortController().signal),
      async () => ({ kind: 'allow' })
    )
    await host.nextFrame()
    await host.close()
    assert.deepEqual(await pending, { kind: 'deny', reason: 'UCLI permission bridge disconnected' })
    let downstreamCalls = 0
    assert.deepEqual(await ctx.waterfall(
      'tools/pre-execute',
      makeExecution('after-disconnect', new AbortController().signal),
      async () => { downstreamCalls += 1; return { kind: 'allow' } }
    ), { kind: 'deny', reason: 'UCLI permission bridge disconnected' })
    assert.equal(downstreamCalls, 0)
    assert.equal(await ctx.waterfall('approval/request', {}, async () => 'allowed-once'), 'rejected')
    ctx.dispose()
  }

  {
    const ctx = new FakeContext([root])
    const host = await createHost()
    t.after(() => host.close())
    await activatePlugin(ctx, host)
    await host.nextFrame(); await host.nextFrame()
    const previous = { setTimeout: internals.setTimeout, clearTimeout: internals.clearTimeout }
    let expire
    internals.setTimeout = (callback, delay) => {
      assert.equal(delay, 30_000)
      expire = callback
      return { kind: 'permission-timeout' }
    }
    internals.clearTimeout = () => {}
    try {
      const pending = ctx.waterfall(
        'tools/pre-execute',
        makeExecution('timeout-call', new AbortController().signal),
        async () => ({ kind: 'allow' })
      )
      await host.nextFrame()
      expire()
      assert.deepEqual(await pending, { kind: 'deny', reason: 'UCLI permission request timed out' })
      assert.deepEqual(await host.nextFrame(), { type: 'cancel', requestId: 'plugin-rpc:1' })
    } finally {
      Object.assign(internals, previous)
    }
  }

  {
    const ctx = new FakeContext([root])
    const host = await createHost()
    t.after(() => host.close())
    await activatePlugin(ctx, host)
    await host.nextFrame(); await host.nextFrame()
    const controller = new AbortController()
    const pending = ctx.waterfall(
      'tools/pre-execute', makeExecution('cancel-call', controller.signal),
      async () => ({ kind: 'allow' })
    )
    await host.nextFrame()
    controller.abort()
    assert.deepEqual(await pending, { kind: 'deny', reason: 'UCLI permission request cancelled' })
  }
})

test('turn control requires one matching root and uses the rc6 message factory', async (t) => {
  const followed = []
  const cancelled = []
  const root = fakeAgent({
    followup: (message) => followed.push(message),
    cancel: (cause) => cancelled.push(cause)
  })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadCreateUserMessage
  let loads = 0
  internals.loadCreateUserMessage = async () => {
    loads += 1
    return (input) => Object.freeze({ id: 'message-1', role: 'user', ...input })
  }
  t.after(() => { internals.loadCreateUserMessage = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  host.write({
    type: 'request', requestId: 'turn-rpc-1', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'continue' }
  })
  assert.deepEqual(await host.nextFrame(), {
    type: 'response', requestId: 'turn-rpc-1', result: { accepted: true }
  })
  assert.deepEqual(followed, [{
    id: 'message-1', role: 'user', content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'user' }
  }])
  assert.equal(loads, 1)

  host.write({
    type: 'request', requestId: 'turn-rpc-2', method: 'turn.interrupt',
    params: { nativeSessionId: root.session.id }
  })
  assert.deepEqual(await host.nextFrame(), {
    type: 'response', requestId: 'turn-rpc-2', result: { accepted: true }
  })
  assert.deepEqual(cancelled, [{ kind: 'user' }])

  const closed = host.waitForPeerClose()
  host.write({
    type: 'request', requestId: 'turn-rpc-1', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'duplicate' }
  })
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('completed control id was reused')), 1_000))
  ])
  assert.equal(followed.length, 1)
})

test('disposing during the turn message import prevents a stale followup side effect', async (t) => {
  const followed = []
  const root = fakeAgent({ followup: (message) => followed.push(message) })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadCreateUserMessage
  let resolveFactory
  internals.loadCreateUserMessage = () => new Promise((resolve) => { resolveFactory = resolve })
  t.after(() => { internals.loadCreateUserMessage = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  host.write({
    type: 'request', requestId: 'late-turn', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'must not run' }
  })
  while (!resolveFactory) await new Promise((resolve) => setImmediate(resolve))
  ctx.dispose()
  resolveFactory((input) => ({ id: 'late-message', role: 'user', ...input }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(followed, [])
})

test('a control cancel prevents a late turn side effect without closing the bridge', async (t) => {
  const followed = []
  const interrupted = []
  const root = fakeAgent({
    followup: (message) => followed.push(message),
    cancel: (cause) => interrupted.push(cause)
  })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadCreateUserMessage
  let resolveFactory
  internals.loadCreateUserMessage = () => new Promise((resolve) => { resolveFactory = resolve })
  t.after(() => { internals.loadCreateUserMessage = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  host.write({
    type: 'request', requestId: 'cancelled-turn', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'must not run' }
  })
  while (!resolveFactory) await new Promise((resolve) => setImmediate(resolve))
  host.write({ type: 'cancel', requestId: 'cancelled-turn' })
  await new Promise((resolve) => setImmediate(resolve))
  resolveFactory((input) => ({ id: 'cancelled-message', role: 'user', ...input }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(followed, [])

  host.write({
    type: 'request', requestId: 'after-control-cancel', method: 'turn.interrupt',
    params: { nativeSessionId: root.session.id }
  })
  assert.deepEqual(await host.nextFrame(), {
    type: 'response', requestId: 'after-control-cancel', result: { accepted: true }
  })
  assert.deepEqual(interrupted, [{ kind: 'user' }])
})

test('turn control rejects zero or multiple matching roots without guessing', async () => {
  for (const [roots, code] of [
    [[], 'DSH_ROOT_AGENT_NOT_FOUND'],
    [[fakeAgent(), fakeAgent({
      id: 'native-session-1',
      session: { id: 'native-session-1', header: { cwd: 'C:\\workspace' } }
    })], 'DSH_ROOT_AGENT_AMBIGUOUS']
  ]) {
    const ctx = new FakeContext(roots)
    const host = await createHost()
    await activatePlugin(ctx, host)
    await host.drainAfter(20)
    host.write({
      type: 'request', requestId: `rpc-${code}`, method: 'turn.interrupt',
      params: { nativeSessionId: 'native-session-1' }
    })
    assert.deepEqual(await host.nextFrame(), {
      type: 'response', requestId: `rpc-${code}`,
      error: { code, message: 'DSH bridge control failed' }
    })
    await host.close()
  }
})

test('continuable subagent roots trace to one semantic root and never become control roots', async (t) => {
  const root = fakeAgent()
  const continuation = fakeAgent({
    id: 'continuation-session',
    session: {
      id: 'continuation-session',
      header: {
        cwd: 'C:\\workspace', origin: 'subagent', parentSession: root.session.id
      }
    }
  })
  const ctx = new FakeContext([root, continuation], [root, continuation])
  ctx.agents.get = (id) => [root, continuation].find((agent) => agent.id === id || agent.session.id === id)
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  assert.equal((await host.nextFrame()).nativeSessionId, root.session.id)
  await host.nextFrame()
  assert.deepEqual(await host.drainAfter(20), [])

  const pending = ctx.waterfall('tools/pre-execute', {
    token: Symbol('continued'), callId: 'continued-call', rootCallId: 'continued-call',
    name: 'read_file', arguments: { path: 'README.md' }, agent: continuation,
    signal: new AbortController().signal
  }, async () => ({ kind: 'allow' }))
  const request = await host.nextFrame()
  assert.equal(request.params.actor.nativeSessionId, root.session.id)
  assert.equal(request.params.actor.subagent, true)
  host.write({ type: 'response', requestId: request.requestId, result: { kind: 'allow' } })
  assert.deepEqual(await pending, { kind: 'allow' })
})

test('existing and future bridged agents are pinned from danger-full-access to workspace-write', async (t) => {
  const root = fakeAgent()
  root.session.events = []
  root.session.events.mode = 'danger-full-access'
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadSandboxPolicy
  const switches = []
  internals.loadSandboxPolicy = async () => ({
    effectiveSandboxMode: (events) => events.mode,
    setSandboxMode(session, mode) {
      switches.push([session.id, mode])
      session.events.mode = mode
    }
  })
  t.after(() => { internals.loadSandboxPolicy = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()
  assert.deepEqual(switches, [[root.session.id, 'workspace-write']])

  const future = fakeAgent({
    id: 'future-agent',
    session: { id: 'future-session', header: { cwd: 'C:\\workspace' }, events: Object.assign([], { mode: 'danger-full-access' }) }
  })
  ctx.emit('agent/created', { agent: future })
  assert.deepEqual(switches.at(-1), ['future-session', 'workspace-write'])
})

test('a runtime sandbox mode event is immediately re-pinned without recursive writes', async (t) => {
  const root = fakeAgent()
  root.session.events = Object.assign([], { mode: 'workspace-write' })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadSandboxPolicy
  const switches = []
  internals.loadSandboxPolicy = async () => ({
    effectiveSandboxMode: (events) => events.mode,
    setSandboxMode(session, mode) {
      switches.push([session.id, mode])
      session.events.mode = mode
      ctx.emit('session/event', session, {
        type: 'sandbox/mode', data: { mode }
      })
    }
  })
  t.after(() => { internals.loadSandboxPolicy = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()

  root.session.events.mode = 'danger-full-access'
  ctx.emit('session/event', root.session, {
    type: 'sandbox/mode', data: { mode: 'danger-full-access' }
  })

  assert.deepEqual(switches, [[root.session.id, 'workspace-write']])
})

test('sandbox policy import failure leaves the bridge disconnected and capability-free', async () => {
  const ctx = new FakeContext([fakeAgent()])
  const previous = {
    loadSandboxPolicy: internals.loadSandboxPolicy,
    createConnection: internals.createConnection
  }
  let connected = false
  internals.loadSandboxPolicy = async () => { throw new Error('missing peer details') }
  internals.createConnection = () => { connected = true; throw new Error('must not connect') }
  try {
    await withBridgeEnvironment({
      UCLI_DSH_BRIDGE_ENDPOINT: 'test-only',
      UCLI_DSH_BRIDGE_TOKEN: 'e'.repeat(64),
      UCLI_DSH_BRIDGE_PROTOCOL: '1'
    }, async () => {
      apply(ctx, { argv: ['dsh', '--profile', 'tui-local'] })
      await new Promise((resolve) => setImmediate(resolve))
    })
  } finally {
    Object.assign(internals, previous)
  }
  assert.equal(connected, false)
  await assertPermissionHooksFailClosed(ctx)
  ctx.dispose()
  assertAllListenersDisposed(ctx)
})

test('dispose during sandbox import cannot mutate sessions or connect later', async () => {
  const root = fakeAgent()
  const ctx = new FakeContext([root])
  const previous = {
    loadSandboxPolicy: internals.loadSandboxPolicy,
    createConnection: internals.createConnection
  }
  let resolvePolicy
  let connected = false
  let switched = false
  internals.loadSandboxPolicy = () => new Promise((resolve) => { resolvePolicy = resolve })
  internals.createConnection = () => { connected = true; throw new Error('must not connect') }
  try {
    await withBridgeEnvironment({
      UCLI_DSH_BRIDGE_ENDPOINT: 'test-only',
      UCLI_DSH_BRIDGE_TOKEN: 'f'.repeat(64),
      UCLI_DSH_BRIDGE_PROTOCOL: '1'
    }, async () => {
      apply(ctx, { argv: ['dsh', '--profile', 'tui-local'] })
      await Promise.resolve()
      ctx.dispose()
      resolvePolicy({
        effectiveSandboxMode: () => 'danger-full-access',
        setSandboxMode: () => { switched = true }
      })
      await new Promise((resolve) => setImmediate(resolve))
    })
  } finally {
    Object.assign(internals, previous)
  }
  assert.equal(switched, false)
  assert.equal(connected, false)
})

test('plan and result snapshot controls return cached semantic snapshots', async (t) => {
  const root = fakeAgent()
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()
  ctx.emit('session/event', root.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'plan-call', name: 'exit_plan_mode', arguments: '{"plan":"# Plan"}' }
  })
  ctx.emit('session/event', root.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Result' }] } }
  })
  ctx.emit('session/event', root.session, {
    type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }
  })
  await host.drainAfter(20)
  for (const [index, method] of ['snapshot.plan', 'snapshot.result'].entries()) {
    host.write({
      type: 'request', requestId: `snapshot-${index}`, method,
      params: { nativeSessionId: root.session.id }
    })
    assert.deepEqual(await host.nextFrame(), {
      type: 'response', requestId: `snapshot-${index}`,
      result: index === 0
        ? { markdown: '# Plan' }
        : { turnId: '1', markdown: 'Result' }
    })
  }
})

test('duplicate or 65 concurrent control request ids close before duplicate side effects', async () => {
  for (const count of [2, 65]) {
    const root = fakeAgent({ followup: () => assert.fail('unresolved factory must prevent followup') })
    const ctx = new FakeContext([root])
    const host = await createHost()
    const previousLoader = internals.loadCreateUserMessage
    internals.loadCreateUserMessage = () => new Promise(() => {})
    try {
      await activatePlugin(ctx, host)
      await host.nextFrame(); await host.nextFrame()
      const closed = host.waitForPeerClose()
      for (let index = 0; index < count; index += 1) {
        host.write({
          type: 'request',
          requestId: count === 2 ? 'duplicate-control' : `control-${index}`,
          method: 'turn.send',
          params: { nativeSessionId: root.session.id, text: 'continue' }
        })
      }
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('control limit did not close')), 1_000))
      ])
    } finally {
      internals.loadCreateUserMessage = previousLoader
      await host.close()
    }
  }
})

test('an active control id cannot be replayed after bounded tombstone eviction', async (t) => {
  const followed = []
  const root = fakeAgent({ followup: (message) => followed.push(message) })
  const ctx = new FakeContext([root])
  const host = await createHost()
  t.after(() => host.close())
  const previousLoader = internals.loadCreateUserMessage
  let resolveFactory
  internals.loadCreateUserMessage = () => new Promise((resolve) => { resolveFactory = resolve })
  t.after(() => { internals.loadCreateUserMessage = previousLoader })
  await activatePlugin(ctx, host)
  await host.nextFrame(); await host.nextFrame()
  ctx.emit('session/event', root.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'plan-call', name: 'exit_plan_mode', arguments: '{"plan":"# Plan"}' }
  })
  await host.drainAfter(20)

  host.write({
    type: 'request', requestId: 'active-control', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'must not run twice' }
  })
  while (!resolveFactory) await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < 1_024; index += 1) {
    const requestId = `completed-control-${index}`
    host.write({
      type: 'request', requestId, method: 'snapshot.plan',
      params: { nativeSessionId: root.session.id }
    })
    assert.equal((await host.nextFrame()).requestId, requestId)
  }

  const closed = host.waitForPeerClose()
  host.write({
    type: 'request', requestId: 'active-control', method: 'turn.send',
    params: { nativeSessionId: root.session.id, text: 'replayed' }
  })
  await Promise.race([closed, new Promise((_, reject) => setTimeout(
    () => reject(new Error('active control replay did not close the bridge')), 1_000
  ))])
  resolveFactory((input) => ({ id: 'late-message', role: 'user', ...input }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(followed, [])
})
