import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { encodeBridgeFrame, BridgeFrameDecoder } from '../electron/adapters/dshBridgeProtocol.js'
import {
  DSH_BRIDGE_CAPABILITIES,
  DSH_BRIDGE_MAX_PENDING_REQUESTS,
  createDshBridgeEndpoint,
  createDshBridgeServer,
  removeDshBridgeEndpoint
} from '../electron/adapters/dshBridgeServer.js'

function helloFor(server, overrides = {}) {
  return {
    type: 'hello',
    protocolVersion: 1,
    token: server.token,
    bridgeVersion: '0.11.0',
    profileName: 'tui-local',
    surface: 'tui',
    capabilities: { ...DSH_BRIDGE_CAPABILITIES },
    ...overrides
  }
}

async function connect(endpoint) {
  const socket = net.createConnection(endpoint)
  await once(socket, 'connect')
  return socket
}

async function closeSocket(socket) {
  if (!socket || socket.destroyed) return
  socket.end()
  await Promise.race([once(socket, 'close'), new Promise((resolve) => setTimeout(resolve, 200))])
  socket.destroy()
}

async function authenticate(server, overrides) {
  const socket = await connect(server.endpoint)
  const inbox = createFrameInbox(socket)
  socket.write(encodeBridgeFrame(helloFor(server, overrides)))
  const [hello, ack] = await Promise.all([server.waitForHello(), inbox.next()])
  assert.deepEqual(ack, { type: 'hello-ack', protocolVersion: 1 })
  assert.equal(hello.profileName, 'tui-local')
  return socket
}

function createFrameInbox(socket) {
  const frames = []
  const waiters = []
  const decoder = new BridgeFrameDecoder((frame) => {
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else frames.push(frame)
  })
  socket.on('data', (chunk) => decoder.push(chunk))
  return {
    next() {
      if (frames.length > 0) return Promise.resolve(frames.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for bridge frame')),
          1_000
        )
        waiters.push((frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
      })
    }
  }
}

function rawFrame(jsonText) {
  const body = Buffer.from(jsonText, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

test('Windows endpoints are unguessable named pipes and never include the session id', () => {
  const endpoint = createDshBridgeEndpoint({
    platform: 'win32',
    tempDirectory: 'C:\\Temp',
    randomId: '2fd53c47-84a7-4db1-8215-a0cdd20af0d9',
    sessionId: 'sensitive-session-id'
  })

  assert.deepEqual(endpoint, {
    endpoint: '\\\\.\\pipe\\ucli-dsh-2fd53c47-84a7-4db1-8215-a0cdd20af0d9',
    socketRoot: null
  })
  assert.equal(endpoint.endpoint.includes('sensitive-session-id'), false)
})

test('macOS endpoints stay in the exact ucli-dsh temp directory', () => {
  const endpoint = createDshBridgeEndpoint({
    platform: 'darwin',
    tempDirectory: '/private/tmp',
    randomId: '2fd53c47-84a7-4db1-8215-a0cdd20af0d9'
  })

  assert.deepEqual(endpoint, {
    endpoint: '/private/tmp/ucli-dsh/2fd53c47-84a7-4db1-8215-a0cdd20af0d9.sock',
    socketRoot: '/private/tmp/ucli-dsh'
  })
})

test('macOS cleanup removes only a socket directly inside the exact generated root', async () => {
  const calls = []
  const fsPromises = {
    lstat: async (path) => ({
      uid: 501,
      mode: path === '/private/tmp/ucli-dsh' ? 0o40700 : 0o140600,
      isDirectory: () => path === '/private/tmp/ucli-dsh',
      isSocket: () => path.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (path) => path,
    unlink: async (path) => calls.push(['unlink', path]),
    rmdir: async (path) => calls.push(['rmdir', path])
  }

  await removeDshBridgeEndpoint({
    endpoint: '/private/tmp/ucli-dsh/bridge.sock',
    socketRoot: '/private/tmp/ucli-dsh',
    tempDirectory: '/private/tmp',
    platform: 'darwin',
    fsPromises,
    getUid: () => 501
  })

  assert.deepEqual(calls, [
    ['unlink', '/private/tmp/ucli-dsh/bridge.sock'],
    ['rmdir', '/private/tmp/ucli-dsh']
  ])

  await assert.rejects(
    removeDshBridgeEndpoint({
      endpoint: '/private/tmp/outside.sock',
      socketRoot: '/private/tmp/ucli-dsh',
      tempDirectory: '/private/tmp',
      platform: 'darwin',
      fsPromises,
      getUid: () => 501
    }),
    (error) => error.code === 'DSH_BRIDGE_ENDPOINT_UNSAFE'
  )
})

test('macOS cleanup refuses a final root symlink before touching the endpoint', async () => {
  const touched = []
  const fsPromises = {
    lstat: async () => ({
      uid: 501,
      isDirectory: () => false,
      isSocket: () => false,
      isSymbolicLink: () => true
    }),
    realpath: async (path) => path,
    unlink: async (path) => touched.push(path),
    rmdir: async (path) => touched.push(path)
  }

  await assert.rejects(
    removeDshBridgeEndpoint({
      endpoint: '/private/tmp/ucli-dsh/bridge.sock',
      socketRoot: '/private/tmp/ucli-dsh',
      tempDirectory: '/private/tmp',
      platform: 'darwin',
      fsPromises,
      getUid: () => 501
    }),
    (error) => error.code === 'DSH_BRIDGE_ENDPOINT_UNSAFE'
  )
  assert.deepEqual(touched, [])
})

test('macOS cleanup rejects filesystem ownership that cannot be verified', async () => {
  const touched = []
  const fsPromises = {
    lstat: async (value) => ({
      mode: value.endsWith('ucli-dsh') ? 0o40700 : 0o140600,
      isDirectory: () => value.endsWith('ucli-dsh'),
      isSocket: () => value.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (value) => value,
    unlink: async (value) => touched.push(value),
    rmdir: async (value) => touched.push(value)
  }

  await assert.rejects(removeDshBridgeEndpoint({
    endpoint: '/private/tmp/ucli-dsh/bridge.sock',
    socketRoot: '/private/tmp/ucli-dsh',
    tempDirectory: '/private/tmp',
    platform: 'darwin',
    fsPromises,
    getUid: () => 501
  }), (error) => error.code === 'DSH_BRIDGE_ENDPOINT_UNSAFE')
  assert.deepEqual(touched, [])
})

test('server authenticates one client with timing-safe token comparison and exact hello shape', async (t) => {
  let comparisonCount = 0
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    timingSafeEqual(left, right) {
      comparisonCount += 1
      assert.equal(Buffer.isBuffer(left), true)
      assert.equal(Buffer.isBuffer(right), true)
      return left.equals(right)
    }
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))

  assert.equal(comparisonCount, 1)
  assert.deepEqual(await server.waitForHello(), {
    bridgeVersion: '0.11.0',
    profileName: 'tui-local',
    surface: 'tui',
    capabilities: { ...DSH_BRIDGE_CAPABILITIES }
  })
})

test('server rejects matching-looking tokens when timing-safe comparison rejects them', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    timingSafeEqual: () => false
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))

  socket.write(encodeBridgeFrame(helloFor(server)))

  await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_AUTH_FAILED')
})

test('server rejects unsupported protocol with a distinct stable error', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {}
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))
  socket.write(encodeBridgeFrame(helloFor(server, { protocolVersion: 2 })))

  await assert.rejects(
    server.waitForHello(),
    (error) => error.code === 'DSH_BRIDGE_PROTOCOL_UNSUPPORTED'
  )
})

test('server rejects wrong profile, capability shape, oversized UTF-8 version, and extra hello keys', async (t) => {
  const cases = [
    { profileName: 'another-profile' },
    { capabilities: { ...DSH_BRIDGE_CAPABILITIES, unexpected: true } },
    { bridgeVersion: '界'.repeat(22) },
    { unexpected: true }
  ]

  for (const overrides of cases) {
    const server = await createDshBridgeServer({
      sessionId: 'session-1',
      profileName: 'tui-local',
      onEvent() {}
    })
    t.after(() => server.close())
    const socket = await connect(server.endpoint)
    t.after(() => closeSocket(socket))
    socket.write(encodeBridgeFrame(helloFor(server, overrides)))
    await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_HELLO_INVALID')
  }
})

test('invalid hello fail-stops a coalesced chunk before later hello and event frames', async (t) => {
  const events = []
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent: (event) => events.push(event)
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))
  socket.write(Buffer.concat([
    encodeBridgeFrame(helloFor(server, { profileName: 'wrong' })),
    encodeBridgeFrame(helloFor(server)),
    encodeBridgeFrame({ type: 'session-ready', nativeSessionId: 'native-1' })
  ]))

  await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_HELLO_INVALID')
  await once(socket, 'close')
  assert.deepEqual(events, [])
})

test('hello resolves only after hello-ack write succeeds and rejects when it fails', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    createServer(handler) {
      return net.createServer((socket) => {
        socket.write = (_frame, callback) => {
          queueMicrotask(() => callback(new Error('simulated ack write failure')))
          return false
        }
        handler(socket)
      })
    }
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))
  socket.write(encodeBridgeFrame(helloFor(server)))

  await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_ACK_FAILED')
  await once(socket, 'close')
})

test('a synchronous hello-ack write failure is normalized and disconnects', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    createServer(handler) {
      return net.createServer((socket) => {
        socket.write = () => { throw new Error('simulated synchronous write failure') }
        handler(socket)
      })
    }
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))
  socket.write(encodeBridgeFrame(helloFor(server)))

  await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_ACK_FAILED')
  await once(socket, 'close')
})

test('server applies the shared DSH profile safety validation before opening an endpoint', async () => {
  for (const profileName of ['', '.', '..', 'node_modules', 'bad/name', 'bad\\name', 'bad\nname']) {
    await assert.rejects(
      createDshBridgeServer({ sessionId: 'session-1', profileName, onEvent() {} }),
      /profile name/i,
      JSON.stringify(profileName)
    )
  }
})

test('server rejects a client that does not send hello within the injected 10 second deadline', async (t) => {
  let scheduled
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    setTimeoutFn(callback, delay) {
      assert.equal(delay, 10_000)
      scheduled = callback
      return { callback }
    },
    clearTimeoutFn() {}
  })
  t.after(() => server.close())
  const socket = await connect(server.endpoint)
  t.after(() => closeSocket(socket))

  scheduled()

  await assert.rejects(server.waitForHello(), (error) => error.code === 'DSH_BRIDGE_HANDSHAKE_TIMEOUT')
})

test('server forwards an allowlisted semantic event and sends a stable error before closing a duplicate client', async (t) => {
  const events = []
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent: (event) => events.push(event)
  })
  t.after(() => server.close())
  const first = await authenticate(server)
  t.after(() => closeSocket(first))

  const second = await connect(server.endpoint)
  const secondInbox = createFrameInbox(second)
  const secondClosed = once(second, 'close')
  t.after(() => closeSocket(second))
  assert.deepEqual(await secondInbox.next(), {
    type: 'error',
    code: 'DSH_BRIDGE_DUPLICATE_CLIENT'
  })
  await secondClosed

  first.write(encodeBridgeFrame({ type: 'agent-status', nativeSessionId: 'native-1', status: 'running' }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(events, [{ type: 'agent-status', nativeSessionId: 'native-1', status: 'running' }])
  assert.equal(first.destroyed, false)
})

test('post-auth hello, unknown events, non-objects, arrays, and token-bearing frames close without reaching onEvent', async (t) => {
  const invalidFrames = [
    encodeBridgeFrame({ type: 'hello', protocolVersion: 1 }),
    encodeBridgeFrame({ type: 'not-a-semantic-event' }),
    rawFrame('true'),
    rawFrame('[]'),
    encodeBridgeFrame({ type: 'agent-status', token: 'must-not-pass', status: 'running' })
  ]

  for (const invalidFrame of invalidFrames) {
    const events = []
    const server = await createDshBridgeServer({
      sessionId: 'session-1',
      profileName: 'tui-local',
      onEvent: (event) => events.push(event)
    })
    t.after(() => server.close())
    const socket = await authenticate(server)
    const closed = once(socket, 'close')
    socket.write(invalidFrame)
    await closed
    assert.deepEqual(events, [])
  }
})

test('post-auth semantic events cannot smuggle the handshake token in string values', async (t) => {
  const events = []
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local',
    onEvent: (event) => events.push(event)
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  const closed = once(socket, 'close')
  socket.write(encodeBridgeFrame({
    type: 'usage',
    nativeSessionId: 'native-1',
    metadata: { note: `credential:${server.token}` }
  }))

  let closeTimer
  await Promise.race([
    closed.finally(() => clearTimeout(closeTimer)),
    new Promise((_, reject) => {
      closeTimer = setTimeout(
        () => reject(new Error('token-bearing event did not close the bridge')),
        1_000
      )
    })
  ])
  assert.deepEqual(events, [])
})

test('canonical usage token counters reach onEvent without matching credential keys', async (t) => {
  const events = []
  let resolveEvent
  const received = new Promise((resolve) => { resolveEvent = resolve })
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local',
    onEvent: (event) => {
      events.push(event)
      resolveEvent()
    }
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  const usage = {
    type: 'usage',
    nativeSessionId: 'n',
    inputTokens: 1,
    outputTokens: 2,
    turns: 1,
    model: 'm'
  }
  socket.write(encodeBridgeFrame(usage))

  await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('canonical usage event was not forwarded')),
      1_000
    ))
  ])
  assert.deepEqual(events, [usage])
  assert.equal(socket.destroyed, false)
})

test('request writes an RPC frame and resolves its matching response', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  const received = []
  const decoder = new BridgeFrameDecoder((frame) => received.push(frame))
  socket.on('data', (chunk) => decoder.push(chunk))

  const pending = server.request('snapshot.plan', { nativeSessionId: 'native-1' })
  while (received.length === 0) await once(socket, 'data')
  const request = received[0]
  assert.equal(request.type, 'request')
  assert.equal(request.method, 'snapshot.plan')
  assert.deepEqual(request.params, { nativeSessionId: 'native-1' })

  socket.write(encodeBridgeFrame({
    type: 'response',
    requestId: request.requestId,
    result: { text: 'plan' }
  }))

  assert.deepEqual(await pending, { text: 'plan' })
})

test('response must be exact, match a live request, and choose exactly one of result or error', async (t) => {
  const invalidResponses = [
    (requestId) => ({ type: 'response', requestId, result: {}, extra: true }),
    (requestId) => ({ type: 'response', requestId, result: {}, error: { code: 'NO', message: 'no' } }),
    () => ({ type: 'response', requestId: 'forged-request-id', result: {} })
  ]

  for (const makeResponse of invalidResponses) {
    const server = await createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local', onEvent() {}
    })
    t.after(() => server.close())
    const socket = await authenticate(server)
    const inbox = createFrameInbox(socket)
    const pending = server.request('snapshot.plan', {})
    const pendingRejected = assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_DISCONNECTED')
    const request = await inbox.next()
    const closed = once(socket, 'close')
    socket.write(encodeBridgeFrame(makeResponse(request.requestId)))
    await closed
    await pendingRejected
  }
})

test('remote response errors have bounded control-free codes and messages', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  const inbox = createFrameInbox(socket)
  const pending = server.request('snapshot.result', {})
  const request = await inbox.next()
  socket.write(encodeBridgeFrame({
    type: 'response',
    requestId: request.requestId,
    error: {
      code: 'BAD\nCODE',
      message: `remote\r\nmessage ${'x'.repeat(400)}`
    }
  }))

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'DSH_BRIDGE_REQUEST_FAILED')
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(error.message), false)
    assert.ok(error.message.length <= 256)
    return true
  })
})

test('remote error text cannot expose endpoint, token, or API key markers', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  const inbox = createFrameInbox(socket)
  const pending = server.request('snapshot.result', {})
  const request = await inbox.next()
  socket.write(encodeBridgeFrame({
    type: 'response',
    requestId: request.requestId,
    error: {
      code: 'DSH_AGENT_UNAVAILABLE',
      message: `remote failure ${server.endpoint} ${server.token} sk-api-marker`
    }
  }))

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'DSH_AGENT_UNAVAILABLE')
    assert.equal(error.message, 'DSH bridge request failed')
    assert.equal(error.message.includes(server.endpoint), false)
    assert.equal(error.message.includes(server.token), false)
    assert.equal(error.message.includes('sk-api-marker'), false)
    return true
  })
})

test('successful response results cannot return the handshake token', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  const inbox = createFrameInbox(socket)
  const pending = server.request('snapshot.result', {})
  const rejected = assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_DISCONNECTED')
  const request = await inbox.next()
  socket.write(encodeBridgeFrame({
    type: 'response',
    requestId: request.requestId,
    result: { text: server.token }
  }))

  await rejected
})

test('Windows pipe endpoint cannot escape through semantic events or successful responses', async (t) => {
  for (const channel of ['semantic', 'response']) {
    const events = []
    const server = await createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local',
      onEvent: (event) => events.push(event)
    })
    t.after(() => server.close())
    assert.equal(server.endpoint.startsWith('\\\\.\\pipe\\ucli-dsh-'), true)
    const socket = await authenticate(server)

    if (channel === 'semantic') {
      const closed = once(socket, 'close')
      socket.write(encodeBridgeFrame({
        type: 'agent-status',
        nativeSessionId: 'n',
        status: 'running',
        detail: `internal endpoint ${server.endpoint}`
      }))
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('endpoint-bearing semantic event did not close the bridge')),
          1_000
        ))
      ])
      assert.deepEqual(events, [])
      continue
    }

    const inbox = createFrameInbox(socket)
    const pending = server.request('snapshot.result', {})
    const rejected = assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_DISCONNECTED')
    const request = await inbox.next()
    socket.write(encodeBridgeFrame({
      type: 'response',
      requestId: request.requestId,
      result: { text: `internal endpoint ${server.endpoint}` }
    }))
    await rejected
    assert.deepEqual(events, [])
  }
})

test('request accepts only five v1 methods and enforces the pending request limit', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)

  await assert.rejects(
    server.request('arbitrary.method', {}),
    (error) => error.code === 'DSH_BRIDGE_REQUEST_METHOD_UNSUPPORTED'
  )

  const pending = []
  for (let index = 0; index < DSH_BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
    pending.push(server.request('snapshot.plan', { index }))
  }
  await assert.rejects(
    server.request('snapshot.plan', { overflow: true }),
    (error) => error.code === 'DSH_BRIDGE_REQUEST_LIMIT'
  )
  const rejected = pending.map((promise) => assert.rejects(
    promise,
    (error) => error.code === 'DSH_BRIDGE_DISCONNECTED'
  ))
  socket.destroy()
  await Promise.all(rejected)
})

test('a response for an expired request is treated as forged and closes the bridge', async (t) => {
  let requestTimer
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    setTimeoutFn(callback, delay) {
      if (delay === 30_000) {
        requestTimer = callback
        return { kind: 'request' }
      }
      return setTimeout(callback, delay)
    },
    clearTimeoutFn(timer) {
      if (timer?.kind === 'request') return
      clearTimeout(timer)
    }
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  const inbox = createFrameInbox(socket)
  const pending = server.request('snapshot.plan', {})
  const request = await inbox.next()
  requestTimer()
  await assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_REQUEST_TIMEOUT')
  const closed = once(socket, 'close')
  socket.write(encodeBridgeFrame({ type: 'response', requestId: request.requestId, result: {} }))
  await closed
})

test('request rejects with a stable timeout error using the injected timer', async (t) => {
  let scheduled
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    setTimeoutFn(callback, delay) {
      if (delay === 10_000) return setTimeout(callback, delay)
      assert.equal(delay, 30_000)
      scheduled = callback
      return { callback }
    },
    clearTimeoutFn(timer) {
      if (typeof timer === 'object' && 'callback' in timer) return
      clearTimeout(timer)
    }
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))

  const pending = server.request('snapshot.result', {})
  scheduled()

  await assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_REQUEST_TIMEOUT')
})

test('disconnect rejects every pending request immediately', async (t) => {
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {}
  })
  t.after(() => server.close())
  const socket = await authenticate(server)

  const first = server.request('snapshot.plan', {})
  const second = server.request('snapshot.result', {})
  const firstRejected = assert.rejects(first, (error) => error.code === 'DSH_BRIDGE_DISCONNECTED')
  const secondRejected = assert.rejects(second, (error) => error.code === 'DSH_BRIDGE_DISCONNECTED')
  socket.destroy()

  await firstRejected
  await secondRejected
})

test('a persistent server error handler rejects hello and pending work without an unhandled error event', async (t) => {
  let rawServer
  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    createServer(handler) {
      rawServer = net.createServer(handler)
      return rawServer
    }
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  const pending = server.request('snapshot.plan', {})
  const pendingRejected = assert.rejects(pending, (error) => error.code === 'DSH_BRIDGE_SERVER_ERROR')
  const closed = once(socket, 'close')

  assert.doesNotThrow(() => rawServer.emit('error', new Error('simulated runtime error')))
  await pendingRejected
  await closed
  assert.ok(rawServer.listenerCount('error') >= 1)
})

test('close removes a generated macOS socket with 0700 directory and 0600 socket permissions', async () => {
  const chmodCalls = []
  const cleanupCalls = []
  const fakeServer = new EventEmitter()
  fakeServer.listen = (_endpoint, callback) => queueMicrotask(callback)
  fakeServer.close = (callback) => queueMicrotask(callback)
  const fsPromises = {
    mkdir: async (path, options) => chmodCalls.push(['mkdir', path, options.mode]),
    chmod: async (path, mode) => chmodCalls.push(['chmod', path, mode]),
    lstat: async (path) => ({
      uid: 501,
      mode: path === '/private/tmp/ucli-dsh' ? 0o40700 : 0o140600,
      isDirectory: () => path === '/private/tmp/ucli-dsh',
      isSocket: () => path.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (path) => path,
    unlink: async (path) => cleanupCalls.push(['unlink', path]),
    rmdir: async (path) => cleanupCalls.push(['rmdir', path])
  }

  const server = await createDshBridgeServer({
    sessionId: 'session-1',
    profileName: 'tui-local',
    onEvent() {},
    platform: 'darwin',
    tempDirectory: '/private/tmp',
    randomUUID: () => 'bridge-id',
    createServer: () => fakeServer,
    fsPromises,
    getUid: () => 501
  })
  await server.close()

  assert.deepEqual(chmodCalls, [
    ['mkdir', '/private/tmp/ucli-dsh', 0o700],
    ['chmod', '/private/tmp/ucli-dsh', 0o700],
    ['chmod', '/private/tmp/ucli-dsh/bridge-id.sock', 0o600]
  ])
  assert.deepEqual(cleanupCalls, [
    ['unlink', '/private/tmp/ucli-dsh/bridge-id.sock'],
    ['rmdir', '/private/tmp/ucli-dsh']
  ])
})

test('macOS server canonicalizes a symlinked temp parent before creating its private final root', async () => {
  let listenedEndpoint
  const fakeServer = new EventEmitter()
  fakeServer.listen = (endpoint, callback) => {
    listenedEndpoint = endpoint
    queueMicrotask(callback)
  }
  fakeServer.close = (callback) => queueMicrotask(callback)
  const fsPromises = {
    mkdir: async () => {},
    chmod: async () => {},
    lstat: async (value) => ({
      uid: 501,
      mode: value.endsWith('ucli-dsh') ? 0o40700 : 0o140600,
      isDirectory: () => value.endsWith('ucli-dsh'),
      isSocket: () => value.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (value) => {
      if (value === '/var/tmp-alias') return '/private/tmp'
      if (value.startsWith('/var/tmp-alias/')) return value.replace('/var/tmp-alias/', '/private/tmp/')
      return value
    },
    unlink: async () => {},
    rmdir: async () => {}
  }

  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
    platform: 'darwin', tempDirectory: '/var/tmp-alias', randomUUID: () => 'bridge-id',
    createServer: () => fakeServer, fsPromises, getUid: () => 501
  })
  assert.equal(server.endpoint, '/private/tmp/ucli-dsh/bridge-id.sock')
  assert.equal(listenedEndpoint, server.endpoint)
  await server.close()
})

test('macOS startup rejects a symlinked final root before listening', async () => {
  let listened = false
  const fakeServer = new EventEmitter()
  fakeServer.listen = () => { listened = true }
  fakeServer.close = (callback) => queueMicrotask(callback)
  const fsPromises = {
    mkdir: async () => {},
    lstat: async () => ({
      uid: 501,
      isDirectory: () => false,
      isSocket: () => false,
      isSymbolicLink: () => true
    }),
    realpath: async (value) => value,
    unlink: async () => assert.fail('must not unlink through a symlink root'),
    rmdir: async () => assert.fail('must not remove a symlink root')
  }

  await assert.rejects(
    createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
      platform: 'darwin', tempDirectory: '/private/tmp', randomUUID: () => 'bridge-id',
      createServer: () => fakeServer, fsPromises, getUid: () => 501
    }),
    (error) => error.code === 'DSH_BRIDGE_ENDPOINT_UNSAFE'
  )
  assert.equal(listened, false)
})

test('startup chmod failure closes the net server before safe endpoint cleanup', async () => {
  const order = []
  const fakeServer = new EventEmitter()
  fakeServer.listen = (_endpoint, callback) => queueMicrotask(callback)
  fakeServer.close = (callback) => {
    order.push('close-server')
    queueMicrotask(callback)
  }
  const fsPromises = {
    mkdir: async () => {},
    chmod: async (value) => {
      if (value.endsWith('.sock')) throw new Error('chmod failed')
    },
    lstat: async (value) => ({
      uid: 501,
      mode: value === '/private/tmp/ucli-dsh' ? 0o40700 : 0o140600,
      isDirectory: () => value === '/private/tmp/ucli-dsh',
      isSocket: () => value.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (value) => value,
    unlink: async () => order.push('unlink-socket'),
    rmdir: async () => order.push('remove-root')
  }

  await assert.rejects(createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
    platform: 'darwin', tempDirectory: '/private/tmp', randomUUID: () => 'bridge-id',
    createServer: () => fakeServer, fsPromises, getUid: () => 501
  }), /chmod failed/)
  assert.deepEqual(order, ['close-server', 'unlink-socket', 'remove-root'])
})

test('startup failure does not unlink the endpoint when closing the net server also fails', async () => {
  const touched = []
  let closeAttempts = 0
  const fakeServer = new EventEmitter()
  fakeServer.listen = (_endpoint, callback) => queueMicrotask(callback)
  fakeServer.close = () => {
    closeAttempts += 1
    const error = new Error('close leaked /private/tmp/ucli-dsh/bridge-id.sock')
    error.code = closeAttempts === 1 ? 'E_CLOSE_FIRST' : 'E_CLOSE_SECOND'
    throw error
  }
  const fsPromises = {
    mkdir: async () => {},
    chmod: async (value) => {
      if (value.endsWith('.sock')) {
        const error = new Error('startup leaked /private/tmp/ucli-dsh/bridge-id.sock')
        error.code = 'E_STARTUP_CHMOD'
        throw error
      }
    },
    lstat: async (value) => ({
      uid: 501,
      mode: value.endsWith('ucli-dsh') ? 0o40700 : 0o140600,
      isDirectory: () => value.endsWith('ucli-dsh'),
      isSocket: () => value.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (value) => value,
    unlink: async (value) => touched.push(['unlink', value]),
    rmdir: async (value) => touched.push(['rmdir', value])
  }

  await assert.rejects(createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
    platform: 'darwin', tempDirectory: '/private/tmp', randomUUID: () => 'bridge-id',
    createServer: () => fakeServer, fsPromises, getUid: () => 501
  }), (error) => {
    assert.equal(error.code, 'DSH_BRIDGE_STARTUP_CLEANUP_FAILED')
    assert.equal(error.startupCode, 'E_STARTUP_CHMOD')
    assert.equal(error.closeCode, 'E_CLOSE_SECOND')
    assert.equal(error.message.includes('/private/tmp'), false)
    return true
  })
  assert.equal(closeAttempts, 2)
  assert.deepEqual(touched, [])
})

test('startup cleanup retries close once and unlinks only after the retry succeeds', async () => {
  const order = []
  let closeAttempts = 0
  const fakeServer = new EventEmitter()
  fakeServer.listen = (_endpoint, callback) => queueMicrotask(callback)
  fakeServer.close = (callback) => {
    closeAttempts += 1
    order.push(`close-${closeAttempts}`)
    if (closeAttempts === 1) {
      const error = new Error('first close failure with private path')
      error.code = 'E_CLOSE_FIRST'
      throw error
    }
    queueMicrotask(() => callback())
  }
  const fsPromises = {
    mkdir: async () => {},
    chmod: async (value) => {
      if (value.endsWith('.sock')) {
        const error = new Error('startup chmod failure')
        error.code = 'E_STARTUP_CHMOD'
        throw error
      }
    },
    lstat: async (value) => ({
      uid: 501,
      mode: value.endsWith('ucli-dsh') ? 0o40700 : 0o140600,
      isDirectory: () => value.endsWith('ucli-dsh'),
      isSocket: () => value.endsWith('.sock'),
      isSymbolicLink: () => false
    }),
    realpath: async (value) => value,
    unlink: async () => order.push('unlink-socket'),
    rmdir: async () => order.push('remove-root')
  }

  await assert.rejects(createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
    platform: 'darwin', tempDirectory: '/private/tmp', randomUUID: () => 'bridge-id',
    createServer: () => fakeServer, fsPromises, getUid: () => 501
  }), (error) => error.code === 'E_STARTUP_CHMOD')
  assert.equal(closeAttempts, 2)
  assert.deepEqual(order, ['close-1', 'close-2', 'unlink-socket', 'remove-root'])
})

test('normal close surfaces sync and callback errors, shares the failing attempt, and permits retry', async () => {
  for (const failureKind of ['sync', 'callback']) {
    let attempts = 0
    const fakeServer = new EventEmitter()
    fakeServer.listen = (_endpoint, callback) => queueMicrotask(callback)
    fakeServer.close = (callback) => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error(`raw ${failureKind} close details`)
        error.code = failureKind === 'sync' ? 'E_CLOSE_SYNC' : 'E_CLOSE_CALLBACK'
        if (failureKind === 'sync') throw error
        queueMicrotask(() => callback(error))
        return
      }
      queueMicrotask(() => callback())
    }
    const server = await createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
      createServer: () => fakeServer
    })

    const first = server.close()
    const concurrent = server.close()
    assert.equal(first, concurrent)
    await assert.rejects(first, (error) => {
      assert.equal(error.code, 'DSH_BRIDGE_SERVER_CLOSE_FAILED')
      assert.equal(error.closeCode, failureKind === 'sync' ? 'E_CLOSE_SYNC' : 'E_CLOSE_CALLBACK')
      assert.equal(error.message.includes('raw'), false)
      return true
    })

    const retry = server.close()
    assert.notEqual(retry, first)
    await retry
    assert.equal(attempts, 2)
  }
})

test('concurrent close calls share one promise and suppress ignored pending rejection noise', async () => {
  let rawServer
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
    createServer(handler) {
      rawServer = net.createServer(handler)
      return rawServer
    }
  })
  const socket = await authenticate(server)
  server.request('snapshot.plan', {})
  const clientClosed = once(socket, 'close')

  const first = server.close()
  const second = server.close()
  assert.equal(first, second)
  await first
  await clientClosed
  await new Promise((resolve) => setImmediate(resolve))
  process.removeListener('unhandledRejection', onUnhandled)

  assert.deepEqual(unhandled, [])
  assert.equal(rawServer.listenerCount('error'), 0)
  assert.equal(socket.destroyed, true)
})

test('real POSIX bridge creates private socket state and removes it on close', {
  skip: process.platform === 'win32' ? 'requires POSIX Unix sockets' : false
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ucli-dsh-real-'))
  try {
    const server = await createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
      platform: 'darwin', tempDirectory: root
    })
    const fs = await import('node:fs/promises')
    const socketRoot = path.join(root, 'ucli-dsh')
    const rootStat = await fs.lstat(socketRoot)
    const socketStat = await fs.lstat(server.endpoint)
    assert.equal(rootStat.isDirectory(), true)
    assert.equal(rootStat.mode & 0o777, 0o700)
    assert.equal(socketStat.isSocket(), true)
    assert.equal(socketStat.mode & 0o777, 0o600)
    await server.close()
    await assert.rejects(fs.lstat(server.endpoint), (error) => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('real POSIX startup refuses a symlinked final socket root', {
  skip: process.platform === 'win32' ? 'requires POSIX symlinks' : false
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ucli-dsh-symlink-'))
  const target = await mkdtemp(path.join(tmpdir(), 'ucli-dsh-target-'))
  try {
    await symlink(target, path.join(root, 'ucli-dsh'), 'dir')
    await assert.rejects(
      createDshBridgeServer({
        sessionId: 'session-1', profileName: 'tui-local', onEvent() {},
        platform: 'darwin', tempDirectory: root
      }),
      (error) => error.code === 'DSH_BRIDGE_ENDPOINT_UNSAFE'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

const validSemanticFrames = [
  { type: 'session-ready', nativeSessionId: 'native-1', cwd: 'C:\\workspace', model: '深度模型' },
  { type: 'agent-status', nativeSessionId: 'native-1', status: 'running' },
  { type: 'assistant-committed', nativeSessionId: 'native-1', turnId: '1', text: 'answer' },
  {
    type: 'tool-request', requestId: 'call-1', nativeSessionId: 'native-1', tool: 'bash',
    input: { command: 'npm test' }, cwd: 'C:\\workspace', command: 'npm test'
  },
  { type: 'tool-result', requestId: 'call-1', nativeSessionId: 'native-1', status: 'completed' },
  {
    type: 'usage', nativeSessionId: 'native-1', inputTokens: 10,
    outputTokens: 4, turns: 1, model: '深度模型'
  },
  { type: 'turn-complete', nativeSessionId: 'native-1', turnId: '1', status: 'completed' },
  { type: 'attention', nativeSessionId: 'native-1', kind: 'approval', operation: 'bash' },
  { type: 'plan-snapshot', nativeSessionId: 'native-1', markdown: '# Plan' },
  { type: 'result-snapshot', nativeSessionId: 'native-1', markdown: 'answer' }
]

test('authenticated semantic frames pass only through the ten exact v1 event schemas', async (t) => {
  const events = []
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent: (event) => events.push(event)
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  for (const frame of validSemanticFrames) socket.write(encodeBridgeFrame(frame))
  const deadline = Date.now() + 1_000
  while (events.length < validSemanticFrames.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.deepEqual(events, validSemanticFrames)
})

test('malformed semantic fields fail closed before onEvent', async () => {
  const malformed = [
    { ...validSemanticFrames[0], unexpected: true },
    { ...validSemanticFrames[0], nativeSessionId: 'x'.repeat(257) },
    { ...validSemanticFrames[0], cwd: `bad\0path` },
    { ...validSemanticFrames[1], status: 'busy' },
    { ...validSemanticFrames[2], turnId: '' },
    { ...validSemanticFrames[2], text: 'x'.repeat(786_433) },
    { ...validSemanticFrames[3], requestId: `call\n1` },
    { ...validSemanticFrames[3], tool: 'x'.repeat(257) },
    { ...validSemanticFrames[3], input: { value: 'x'.repeat(786_433) } },
    { ...validSemanticFrames[3], input: 42 },
    { ...validSemanticFrames[3], input: [1, 2] },
    { ...validSemanticFrames[3], input: null },
    { ...validSemanticFrames[3], command: 'x'.repeat(32_769) },
    { ...validSemanticFrames[4], status: 'unknown' },
    { ...validSemanticFrames[5], inputTokens: -1 },
    { ...validSemanticFrames[5], outputTokens: 1.5 },
    { ...validSemanticFrames[5], turns: Number.MAX_SAFE_INTEGER + 1 },
    { ...validSemanticFrames[5], model: 'bad\nmodel' },
    { ...validSemanticFrames[6], status: 'done' },
    { ...validSemanticFrames[7], kind: 'warning' },
    { ...validSemanticFrames[7], operation: 'x'.repeat(257) },
    { ...validSemanticFrames[8], markdown: 'x'.repeat(786_433) },
    { ...validSemanticFrames[9], markdown: 42 }
  ]

  for (const frame of malformed) {
    const events = []
    const server = await createDshBridgeServer({
      sessionId: 'session-1', profileName: 'tui-local', onEvent: (event) => events.push(event)
    })
    const socket = await authenticate(server)
    let didClose = false
    const closed = once(socket, 'close').then(() => { didClose = true })
    socket.write(encodeBridgeFrame(frame))
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 50))])
    try {
      assert.deepEqual(events, [], frame.type)
      assert.equal(didClose, true, `${frame.type} did not close the bridge`)
    } finally {
      socket.destroy()
      await server.close()
    }
  }
})

test('semantic text above 256 KiB uses UTF-8 byte limits without closing a valid frame', async (t) => {
  const events = []
  const server = await createDshBridgeServer({
    sessionId: 'session-1', profileName: 'tui-local', onEvent: (event) => events.push(event)
  })
  t.after(() => server.close())
  const socket = await authenticate(server)
  t.after(() => closeSocket(socket))
  const text = '你'.repeat(100_000)
  socket.write(encodeBridgeFrame({
    type: 'assistant-committed', nativeSessionId: 'native-1', turnId: '1', text
  }))
  const deadline = Date.now() + 1_000
  while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(events[0]?.text, text)
})
