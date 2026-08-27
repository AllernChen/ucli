import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createDeviceGrantClient } from '../electron/serverConnection/deviceGrantClient.js'

const origin = 'http://10.44.100.100'
const linkSecret = 'one-time-link-secret'
const refreshToken = 'refresh-token-secret'
const accessToken = 'access-token-secret'
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/server-connection/${name}`, import.meta.url), 'utf8'))
const bootstrapFixture = () => ({
  ...fixture('bootstrap-success.json'),
  gateway: { baseUrl: `${origin}/gateway` },
  skillsCatalogUrl: `${origin}/api/v1/skills/catalog`
})
const device = {
  installationId: '550e8400-e29b-41d4-a716-446655440000',
  name: '  Ada workstation  ',
  platform: 'windows',
  clientVersion: '0.12.0'
}

function response(body, { status = 200, cacheControl = 'no-store' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cacheControl === null ? {} : { 'Cache-Control': cacheControl }
  })
}

function recordingFetch(responses) {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return responses.shift()
  }
  return { fetchImpl, requests }
}

async function rejected(operation) {
  try {
    await operation()
    assert.fail('Expected operation to reject')
  } catch (error) {
    return error
  }
}

test('preview posts the opaque link to the fixed control-plane path with no-store required', async () => {
  const wire = recordingFetch([response(fixture('preview-available.json'))])
  const client = createDeviceGrantClient({ fetchImpl: wire.fetchImpl })

  const preview = await client.preview({ serverOrigin: origin, linkSecret })

  assert.deepEqual(preview, fixture('preview-available.json'))
  assert.equal(wire.requests.length, 1)
  const [{ url, options }] = wire.requests
  assert.equal(url, `${origin}/api/v1/auth/device-grants/preview`)
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.equal(options.redirect, 'manual')
  assert.deepEqual(JSON.parse(options.body), { link: linkSecret })
  assert.ok(options.signal instanceof AbortSignal)
})

test('redeem validates and normalises the device before posting to its fixed path', async () => {
  const wire = recordingFetch([response(fixture('redeem-success.json'))])
  const client = createDeviceGrantClient({ fetchImpl: wire.fetchImpl })

  const redeemed = await client.redeem({ serverOrigin: origin, linkSecret, device })

  assert.equal(redeemed.refreshToken, 'fixture-refresh-token')
  const [{ url, options }] = wire.requests
  assert.equal(url, `${origin}/api/v1/auth/device-grants/redeem`)
  assert.deepEqual(JSON.parse(options.body), {
    link: linkSecret,
    device: { ...device, name: 'Ada workstation' }
  })
  assert.equal(options.headers['Content-Type'], 'application/json')
})

test('refresh posts its token with no-store required and bootstrap uses bearer authentication', async () => {
  const wire = recordingFetch([
    response(fixture('refresh-success.json')),
    response(bootstrapFixture())
  ])
  const client = createDeviceGrantClient({ fetchImpl: wire.fetchImpl })

  await client.refresh({ serverOrigin: origin, refreshToken })
  await client.bootstrap({ serverOrigin: origin, accessToken })

  assert.equal(wire.requests[0].url, `${origin}/api/v1/auth/token/refresh`)
  assert.deepEqual(JSON.parse(wire.requests[0].options.body), { refreshToken })
  assert.equal(wire.requests[0].options.headers['Content-Type'], 'application/json')
  assert.equal(wire.requests[1].url, `${origin}/api/v1/client/bootstrap`)
  assert.equal(wire.requests[1].options.method, 'GET')
  assert.deepEqual(wire.requests[1].options.headers, { Authorization: `Bearer ${accessToken}` })
  assert.equal(wire.requests[1].options.body, undefined)
})

test('control-plane requests use a fifteen-second abort signal by default', async () => {
  let signal
  const client = createDeviceGrantClient({
    fetchImpl: async (_url, options) => {
      signal = options.signal
      return response(fixture('preview-available.json'))
    }
  })

  await client.preview({ serverOrigin: origin, linkSecret })

  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
})

test('untrusted origins and path, query, or fragment injection never reach fetch', async () => {
  let calls = 0
  const client = createDeviceGrantClient({ fetchImpl: async () => { calls += 1 } })
  for (const serverOrigin of [
    'http://example.test',
    'http://10.44.100.100/attacker-path',
    'http://10.44.100.100?redirect=https://attacker.test',
    'http://10.44.100.100#fragment'
  ]) {
    const error = await rejected(() => client.preview({ serverOrigin, linkSecret }))
    assert.deepEqual(error, { code: null, message: 'Server operation failed', retryable: false })
  }
  assert.equal(calls, 0)
})

test('device validation requires a UUID v4, valid trimmed name, platform, and target client version', async () => {
  const invalidDevices = [
    { ...device, installationId: '550e8400-e29b-31d4-a716-446655440000' },
    { ...device, name: '   ' },
    { ...device, name: 'x'.repeat(121) },
    { ...device, platform: 'freebsd' },
    { ...device, clientVersion: '0.12.1' }
  ]
  let calls = 0
  const client = createDeviceGrantClient({ fetchImpl: async () => { calls += 1 } })

  for (const invalidDevice of invalidDevices) {
    const error = await rejected(() => client.redeem({ serverOrigin: origin, linkSecret, device: invalidDevice }))
    assert.deepEqual(error, { code: null, message: 'Server operation failed', retryable: false })
  }
  assert.equal(calls, 0)
})

test('preview and redeem expose only stable 400 protocol errors without branching on message text', async () => {
  for (const method of ['preview', 'redeem']) {
    const client = createDeviceGrantClient({
      fetchImpl: async () => response({ code: 'link_expired', message: 'untrusted arbitrary wording' }, { status: 400 })
    })
    const error = await rejected(() => method === 'preview'
      ? client.preview({ serverOrigin: origin, linkSecret })
      : client.redeem({ serverOrigin: origin, linkSecret, device }))
    assert.deepEqual(error, { code: 'link_expired', message: 'Connection link has expired', retryable: false })
  }
})

test('refresh and bootstrap expose only stable 401 lifecycle errors', async () => {
  for (const method of ['refresh', 'bootstrap']) {
    const client = createDeviceGrantClient({
      fetchImpl: async () => response({ code: 'grant_expired', message: 'untrusted arbitrary wording' }, { status: 401 })
    })
    const error = await rejected(() => method === 'refresh'
      ? client.refresh({ serverOrigin: origin, refreshToken })
      : client.bootstrap({ serverOrigin: origin, accessToken }))
    assert.deepEqual(error, { code: 'grant_expired', message: 'Device grant has expired', retryable: false })
  }
})

test('timeouts, network failures, and server failures are retryable without new protocol codes', async () => {
  const failures = [
    async () => { throw Object.assign(new Error('network unavailable'), { code: 'ECONNRESET' }) },
    async () => { throw new DOMException('timed out', 'TimeoutError') },
    async () => response({ code: 'not-used' }, { status: 503 })
  ]
  for (const fetchImpl of failures) {
    const client = createDeviceGrantClient({ fetchImpl })
    const error = await rejected(() => client.preview({ serverOrigin: origin, linkSecret }))
    assert.deepEqual(error, { code: null, message: 'Server operation failed', retryable: true })
  }
})

test('missing no-store fails closed for preview, redeem, and refresh but not bootstrap', async () => {
  for (const [method, args, body] of [
    ['preview', { serverOrigin: origin, linkSecret }, fixture('preview-available.json')],
    ['redeem', { serverOrigin: origin, linkSecret, device }, fixture('redeem-success.json')],
    ['refresh', { serverOrigin: origin, refreshToken }, fixture('refresh-success.json')]
  ]) {
    const client = createDeviceGrantClient({ fetchImpl: async () => response(body, { cacheControl: null }) })
    const error = await rejected(() => client[method](args))
    assert.deepEqual(error, { code: null, message: 'Server operation failed', retryable: false })
  }

  const client = createDeviceGrantClient({ fetchImpl: async () => response(bootstrapFixture(), { cacheControl: null }) })
  assert.equal((await client.bootstrap({ serverOrigin: origin, accessToken })).gateway.baseUrl, `${origin}/gateway`)
})
