import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  SERVER_ERROR_CODES,
  parseGatewayRouteFailure,
  parseBootstrapResponse,
  parseGatewayModelsResponse,
  parsePreviewResponse,
  parseRedeemResponse,
  parseRefreshResponse,
  parseSkillsCatalogPage,
  selectModelForProtocol,
  sanitiseServerError
} from '../electron/serverConnection/contracts.js'
import { createDeviceGrantClient } from '../electron/serverConnection/deviceGrantClient.js'
import { createLocalGatewayProxy } from '../electron/serverConnection/localGatewayProxy.js'
import { codexNativeProfileName, serverCodexNativeProfileName } from '../electron/aiCliProfiles/codexProfileFile.js'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/server-connection/${name}`, import.meta.url), 'utf8'))
const textFixture = name => readFileSync(new URL(`./fixtures/server-connection/${name}`, import.meta.url), 'utf8')
const serverOrigin = 'http://server.fixture.test'
const deviceGrantOrigin = 'http://10.44.100.100'

function response(body, { contentType = 'application/json', cacheControl = 'no-store' } = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': contentType,
      ...(cacheControl === null ? {} : { 'cache-control': cacheControl })
    }
  })
}

test('official server connection fixtures parse through the production contract boundary', () => {
  assert.deepEqual(parsePreviewResponse(fixture('preview-available.json')).link.status, 'AVAILABLE')
  assert.equal(parseRedeemResponse(fixture('redeem-success.json')).expiresIn, 900)
  assert.equal(parseRefreshResponse(fixture('refresh-success.json')).expiresIn, 900)
  assert.equal(parseBootstrapResponse(fixture('bootstrap-success.json'), { serverOrigin }).gateway.baseUrl, `${serverOrigin}/gateway`)
  assert.equal(parseSkillsCatalogPage(fixture('skills-catalog-page.json'), { serverOrigin })[0].downloadUrl,
    `${serverOrigin}/api/v1/skills/skill-version-fixture-001/download`)
})

test('model directory fixtures select models for every supported protocol', () => {
  const gatewayModels = parseGatewayModelsResponse(fixture('gateway-models-success.json')).data
  assert.equal(selectModelForProtocol(gatewayModels, 'openai_responses').id, 'fixture-model')
  assert.equal(selectModelForProtocol(gatewayModels, 'openai_chat').id, 'fixture-chat-model')
  assert.equal(selectModelForProtocol(gatewayModels, 'anthropic_messages').id, 'fixture-model')
})

test('model directory fixtures reject missing, empty, and unsupported protocol arrays', () => {
  const bootstrap = fixture('bootstrap-success.json')
  const gateway = fixture('gateway-models-success.json')
  for (const protocols of [undefined, [], ['gemini'], ['openai_chat', 'future_protocol']]) {
    assert.throws(() => parseBootstrapResponse({
      ...bootstrap,
      models: [{ ...bootstrap.models[0], protocols }]
    }, { serverOrigin }), { code: 'SERVER_RESPONSE_INVALID' })
    assert.throws(() => parseGatewayModelsResponse({
      ...gateway,
      data: [{ ...gateway.data[0], protocols }]
    }), { code: 'SERVER_RESPONSE_INVALID' })
  }
})

test('stable Gateway 503 fixtures parse to the exact safe diagnostics', () => {
  for (const [name, stableCode, retryable] of [
    ['error-model-protocol-unavailable.json', 'model_protocol_unavailable', false],
    ['error-model-channel-unavailable.json', 'model_channel_unavailable', true],
    ['error-upstream-unavailable.json', 'upstream_unavailable', true]
  ]) {
    const body = fixture(name)
    assert.deepEqual(parseGatewayRouteFailure({
      status: 503,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-ucli-request-id': body.requestId
      }),
      body
    }), {
      httpStatus: 503,
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
      stableCode,
      requestId: body.requestId,
      retryable
    })
  }
})

test('contract parsers ignore ordinary unknown fields but reject malformed protocol fields', () => {
  const preview = fixture('preview-available.json')
  assert.equal(Object.hasOwn(parsePreviewResponse({ ...preview, futureField: true }), 'futureField'), false)

  const cases = [
    () => parsePreviewResponse({ ...preview, link: { ...preview.link, status: 'FUTURE_STATUS' } }),
    () => parsePreviewResponse({ ...preview, authorization: { ...preview.authorization, serverTime: '2026-02-30T00:00:00.000Z' } }),
    () => parseRedeemResponse({ ...fixture('redeem-success.json'), refreshToken: undefined }),
    () => parseBootstrapResponse({ ...fixture('bootstrap-success.json'), gateway: { baseUrl: 'https://other.fixture.test/gateway' } }, { serverOrigin }),
    () => parseBootstrapResponse({ ...fixture('bootstrap-success.json'), skillsCatalogUrl: `${serverOrigin}/wrong-catalog` }, { serverOrigin }),
    () => parseSkillsCatalogPage([{ ...fixture('skills-catalog-page.json')[0], downloadUrl: `${serverOrigin}/wrong-download` }], { serverOrigin })
  ]
  for (const parse of cases) assert.throws(parse, { code: 'SERVER_RESPONSE_INVALID' })
})

test('stable server errors are public and unknown errors remain generic', () => {
  for (const code of SERVER_ERROR_CODES) {
    const value = sanitiseServerError({ code, message: 'untrusted message', detail: 'untrusted detail' })
    assert.equal(value.code, code)
    assert.equal(value.retryable, false)
    assert.equal(value.message.includes('untrusted'), false)
  }
  assert.deepEqual(sanitiseServerError({ code: 'future_code', message: 'untrusted message', retryable: true }), {
    code: null, message: 'Server operation failed', retryable: true
  })
})

test('local rollback compatibility keeps server-owned profile files outside the legacy namespace', () => {
  const legacy = codexNativeProfileName('550e8400-e29b-41d4-a716-446655440000')
  const server = serverCodexNativeProfileName('0123456789abcdef0123456789abcdef')
  assert.equal(legacy, 'ucli-550e8400e29b41d4a716446655440000')
  assert.equal(server, 'ucli-server-0123456789abcdef0123456789abcdef')
  assert.equal(server.startsWith(`${legacy}-`), false)
})

test('device-grant JSON responses require JSON content type and Cache-Control no-store', async () => {
  const client = createDeviceGrantClient({
    fetchImpl: async () => response(fixture('preview-available.json'), { contentType: 'text/plain' })
  })
  await assert.rejects(client.preview({ serverOrigin: deviceGrantOrigin, linkSecret: 'synthetic-link' }), {
    code: null, message: 'Server operation failed', retryable: false
  })

  const noStore = createDeviceGrantClient({ fetchImpl: async () => response(fixture('preview-available.json'), { cacheControl: null }) })
  await assert.rejects(noStore.preview({ serverOrigin: deviceGrantOrigin, linkSecret: 'synthetic-link' }), {
    code: null, message: 'Server operation failed', retryable: false
  })
})

test('the local gateway proxy preserves synthetic SSE framing while retaining the gateway base path', async t => {
  const sse = textFixture('model-stream.sse')
  const identity = { connectionId: 'fixture-connection', connectionRevision: 1 }
  const connectionManager = {
    getRuntimeConnectionIdentity: () => identity,
    getBootstrap: async () => ({ gateway: { baseUrl: `${serverOrigin}/gateway` } }),
    getAccessToken: async () => 'synthetic-access-token'
  }
  const upstreamRequests = []
  const proxy = createLocalGatewayProxy({
    connectionManager,
    fetchImpl: async (url, options) => {
      upstreamRequests.push({ url: url.toString(), options })
      return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    }
  })
  await proxy.start()
  t.after(() => proxy.shutdown())
  const session = proxy.createSession({ sessionId: 'fixture-session', ...identity })
  const result = await fetch(`${session.baseUrl}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${session.bearer}` }, body: '{}', duplex: 'half'
  })

  assert.equal(await result.text(), sse)
  assert.equal(upstreamRequests[0].url, `${serverOrigin}/gateway/v1/responses`)
  assert.equal(upstreamRequests[0].options.headers.authorization, 'Bearer synthetic-access-token')
})
