import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { createLocalGatewayProxy } from '../electron/serverConnection/localGatewayProxy.js'

const identity = Object.freeze({ connectionId: 'connection-1', connectionRevision: 3 })

function createManager({ available = true, bootstrap, accessToken = 'server-access-token' } = {}) {
  let currentIdentity = available ? identity : null
  const calls = { bootstrap: 0, accessToken: [] }
  return {
    calls,
    getRuntimeConnectionIdentity: () => currentIdentity,
    setIdentity: value => { currentIdentity = value },
    async getBootstrap() {
      calls.bootstrap += 1
      return bootstrap || { gateway: { baseUrl: 'https://gateway.example.test/gateway' } }
    },
    async getAccessToken(options) {
      calls.accessToken.push(options)
      return accessToken
    }
  }
}

async function startedProxy(options = {}) {
  const proxy = createLocalGatewayProxy(options)
  await proxy.start()
  return proxy
}

async function startedUpstream(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('binds only loopback and authorizes a distinct bearer bound to the immutable connection identity', async t => {
  const manager = createManager()
  let upstreamCalls = 0
  let randomValue = 6
  const proxy = await startedProxy({
    connectionManager: manager,
    randomBytes: size => Buffer.alloc(size, ++randomValue),
    fetchImpl: async () => {
      upstreamCalls += 1
      return new Response(JSON.stringify({ object: 'list', data: [] }), { headers: { 'content-type': 'application/json' } })
    }
  })
  t.after(() => proxy.shutdown())

  assert.match(proxy.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  const first = proxy.createSession({ sessionId: 'session-1', ...identity })
  const second = proxy.createSession({ sessionId: 'session-2', ...identity })
  assert.notEqual(first.bearer, second.bearer)
  assert.equal(first.connectionRevision, identity.connectionRevision)

  const denied = await fetch(`${proxy.baseUrl}/v1/models`)
  assert.equal(denied.status, 401)
  assert.equal(upstreamCalls, 0)

  const allowed = await fetch(`${first.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${first.bearer}` } })
  assert.equal(allowed.status, 200)
  assert.equal(upstreamCalls, 1)

  manager.setIdentity({ connectionId: 'connection-2', connectionRevision: 3 })
  assert.equal((await fetch(`${first.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${first.bearer}` } })).status, 401)
  assert.equal(upstreamCalls, 1)

  manager.setIdentity(identity)
  proxy.revokeConnection(identity)
  assert.equal((await fetch(`${first.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${first.bearer}` } })).status, 401)
  assert.equal(upstreamCalls, 1)
})

test('forwards only allowlisted traffic under the gateway root with sanitized headers and streamed bodies', async t => {
  const manager = createManager()
  const requests = []
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, bodyType: options.body?.constructor?.name })
      const requestText = await new Response(options.body).text()
      return new Response(`reply:${requestText}`, {
        status: 201,
        headers: { 'content-type': 'text/plain', connection: 'close', 'x-upstream': 'ok' }
      })
    }
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-1', ...identity })

  const response = await fetch(`${session.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.bearer}`,
      cookie: 'ignored=true',
      'x-api-key': 'client-key',
      'content-type': 'text/plain'
    },
    body: 'stream-me',
    duplex: 'half'
  })
  assert.equal(response.status, 201)
  assert.equal(await response.text(), 'reply:stream-me')
  assert.equal(requests.length, 1)
  assert.equal(String(requests[0].url), 'https://gateway.example.test/gateway/v1/responses')
  assert.equal(requests[0].bodyType, 'ReadableStream')
  assert.equal(requests[0].options.headers.authorization, 'Bearer server-access-token')
  assert.equal(requests[0].options.headers.cookie, undefined)
  assert.equal(requests[0].options.headers['x-api-key'], undefined)
  assert.equal(response.headers.get('x-upstream'), 'ok')

  for (const request of [
    ['/v1/models?x=1', 'GET'],
    ['/v1/../models', 'GET'],
    ['/v1/%2e%2e/models', 'GET'],
    ['/v1/models', 'POST'],
    ['/other', 'GET']
  ]) {
    const rejected = await fetch(`${session.baseUrl}${request[0]}`, {
      method: request[1], headers: { authorization: `Bearer ${session.bearer}` }
    })
    assert.equal(rejected.status, 404)
  }
  assert.equal(requests.length, 1)
})

test('forwards Claude Anthropic messages from the proxy Anthropic base path', async t => {
  const manager = createManager()
  const upstreamUrls = []
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async url => {
      upstreamUrls.push(String(url))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'claude-session', ...identity })
  const response = await fetch(`${session.baseUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.bearer}`, 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(response.status, 200)
  assert.deepEqual(upstreamUrls, ['https://gateway.example.test/gateway/anthropic/v1/messages'])
})

test('does not call upstream when the connection becomes stale while resolving gateway state', async t => {
  const manager = createManager()
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async () => {
      throw new Error('stale connection must not reach upstream')
    }
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-1', ...identity })
  manager.getBootstrap = async () => {
    manager.setIdentity({ connectionId: 'replacement', connectionRevision: 3 })
    return { gateway: { baseUrl: 'https://gateway.example.test/gateway' } }
  }

  const response = await fetch(`${session.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${session.bearer}` }
  })
  assert.equal(response.status, 401)
})

test('decompresses fetched gzip bodies without relaying stale framing or Connection-named headers', async t => {
  const body = JSON.stringify({ object: 'list', data: [{ id: 'compressed-model' }] })
  const compressed = gzipSync(body)
  const upstream = await startedUpstream((request, response) => {
    assert.equal(request.url, '/gateway/v1/models')
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': compressed.length,
      connection: 'x-internal',
      'x-internal': 'must-not-leak'
    })
    response.end(compressed)
  })
  t.after(() => upstream.close())
  const manager = createManager({ bootstrap: { gateway: { baseUrl: `${upstream.baseUrl}/gateway` } } })
  const proxy = await startedProxy({ connectionManager: manager })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-1', ...identity })

  const response = await fetch(`${session.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${session.bearer}` }
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('x-internal'), null)
})

test('a replacement session bearer supersedes every prior bearer for that session ID', async t => {
  const manager = createManager()
  let upstreamCalls = 0
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async () => {
      upstreamCalls += 1
      return new Response('ok')
    }
  })
  t.after(() => proxy.shutdown())
  const first = proxy.createSession({ sessionId: 'session-1', ...identity })
  const replacement = proxy.createSession({ sessionId: 'session-1', ...identity })
  assert.notEqual(first.bearer, replacement.bearer)

  assert.equal((await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${first.bearer}` } })).status, 401)
  assert.equal((await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${replacement.bearer}` } })).status, 200)
  assert.equal(upstreamCalls, 1)
})

test('forwards stable model 503s once without refresh, disconnect, or credential mutation', async t => {
  const manager = createManager()
  let disconnectCalls = 0
  let credentialMutationCalls = 0
  manager.disconnect = async () => { disconnectCalls += 1 }
  manager.clearCredentials = async () => { credentialMutationCalls += 1 }
  const bodies = [
    { code: 'model_protocol_unavailable', message: 'The model does not support the requested protocol', retryable: false },
    { code: 'model_channel_unavailable', message: 'No model channel is currently available', retryable: true },
    { code: 'upstream_unavailable', message: 'No upstream channel succeeded', retryable: true }
  ]
  let requestNumber = 0
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async () => {
      const source = bodies[requestNumber++]
      const requestId = `proxy-request-${requestNumber}`
      return new Response(JSON.stringify({ statusCode: 503, ...source, requestId }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-ucli-request-id': requestId
        }
      })
    }
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-503', ...identity })
  const headers = { authorization: `Bearer ${session.bearer}`, 'content-type': 'application/json' }

  for (const [index, path] of ['/v1/responses', '/v1/chat/completions', '/anthropic/v1/messages'].entries()) {
    const expected = JSON.stringify({ statusCode: 503, ...bodies[index], requestId: `proxy-request-${index + 1}` })
    const result = await fetch(`${session.baseUrl}${path}`, { method: 'POST', headers, body: '{}', duplex: 'half' })
    assert.equal(result.status, 503)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-ucli-request-id'), `proxy-request-${index + 1}`)
    assert.equal(await result.text(), expected)
  }

  assert.equal(requestNumber, 3)
  assert.equal(manager.calls.accessToken.length, 3)
  assert.equal(manager.calls.accessToken.some(call => call?.minValidityMs === Number.MAX_SAFE_INTEGER), false)
  assert.equal(disconnectCalls, 0)
  assert.equal(credentialMutationCalls, 0)
  assert.deepEqual(manager.getRuntimeConnectionIdentity(), identity)
})

test('does not replay POST 401s, refreshes GET models once, and blocks every redirect', async t => {
  const manager = createManager()
  const calls = []
  const responses = [
    new Response('unauthorized', { status: 401 }),
    new Response('ok', { status: 200 }),
    new Response('unauthorized', { status: 401 }),
    new Response(null, { status: 302, headers: { location: '/gateway/v1/models' } }),
    new Response(null, { status: 302, headers: { location: 'https://gateway.example.test/other' } }),
    new Response(null, { status: 302, headers: { location: 'https://other.example.test/models' } })
  ]
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return responses.shift()
    }
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-1', ...identity })
  const headers = { authorization: `Bearer ${session.bearer}` }

  assert.equal((await fetch(`${session.baseUrl}/v1/models`, { headers })).status, 200)
  assert.equal(calls.length, 2)
  assert.equal(manager.calls.accessToken.length, 2)
  assert.equal(manager.calls.accessToken[1].minValidityMs, Number.MAX_SAFE_INTEGER)

  assert.equal((await fetch(`${session.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: 'request', duplex: 'half' })).status, 401)
  assert.equal(calls.length, 3)

  assert.equal((await fetch(`${session.baseUrl}/v1/models`, { headers })).status, 502)
  assert.equal(calls.length, 4)
  assert.equal((await fetch(`${session.baseUrl}/v1/models`, { headers })).status, 502)
  assert.equal(calls.length, 5)
  assert.equal((await fetch(`${session.baseUrl}/v1/models`, { headers })).status, 502)
  assert.equal(calls.length, 6)
})

test('aborting a client model request aborts its upstream stream without changing manager state', async t => {
  const manager = createManager()
  let upstreamAborted = false
  let upstreamStarted
  const started = new Promise(resolve => { upstreamStarted = resolve })
  const proxy = await startedProxy({
    connectionManager: manager,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      upstreamStarted()
      options.signal.addEventListener('abort', () => {
        upstreamAborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
  })
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'session-1', ...identity })
  const request = http.request(`${session.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.bearer}`, 'content-type': 'text/plain' }
  })
  request.on('error', () => {})
  request.end('cancel-me')
  await started
  request.destroy()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(upstreamAborted, true)
  assert.equal(manager.calls.bootstrap, 1)
  assert.equal(manager.calls.accessToken.length, 1)
})

test('orchestrator exposes only the deferred server-gateway session facade', () => {
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /createServerGatewaySession:\s*connection\s*=>\s*localGatewayProxy\?\.createSession\(connection\)/)
  assert.match(source, /revokeServerGatewaySession:\s*sessionId\s*=>\s*localGatewayProxy\?\.revokeSession\(sessionId\)/)
})
