import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  AUTHORIZATION_STATUSES,
  CONNECTION_STATUSES,
  LINK_STATUSES,
  MODEL_PROTOCOL_LOCAL_PATHS,
  PUBLIC_MODEL_PROTOCOLS,
  SERVER_ERROR_CODES,
  assertGatewayModelProtocolConsistency,
  gatewayResponseMetadata,
  localGatewayPathForProtocol,
  parseBootstrapResponse,
  parseGatewayModelsResponse,
  parseGatewayRouteFailure,
  parsePreviewResponse,
  parseRedeemResponse,
  parseRefreshResponse,
  parseSkillsCatalogPage,
  selectModelForProtocol,
  sanitiseServerError
} from '../electron/serverConnection/contracts.js'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/server-connection/${name}`, import.meta.url), 'utf8'))
const serverOrigin = 'http://server.fixture.test'

test('wire status constants expose the protocol values used by later consumers', () => {
  assert.deepEqual(LINK_STATUSES, ['AVAILABLE', 'EXPIRED', 'REVOKED', 'CONSUMED'])
  assert.deepEqual(AUTHORIZATION_STATUSES, ['AVAILABLE', 'BOUND', 'DISABLED', 'EXPIRED', 'DELETED'])
  assert.deepEqual(CONNECTION_STATUSES, [
    'disconnected', 'connecting', 'connected', 'unreachable', 'expiring',
    'disabled', 'expired', 'deleted', 'account_inactive', 'org_inactive'
  ])
  assert.deepEqual(SERVER_ERROR_CODES, [
    'invalid_link', 'link_expired', 'link_revoked', 'link_consumed',
    'invalid_device', 'invalid_grant', 'grant_disabled', 'grant_expired',
    'grant_deleted', 'account_inactive', 'organization_inactive'
  ])
})

test('model protocols are explicit and map to fixed local Gateway paths', () => {
  assert.deepEqual(PUBLIC_MODEL_PROTOCOLS, [
    'openai_responses', 'openai_chat', 'anthropic_messages'
  ])
  assert.deepEqual(MODEL_PROTOCOL_LOCAL_PATHS, {
    openai_responses: '/v1/responses',
    openai_chat: '/v1/chat/completions',
    anthropic_messages: '/anthropic/v1/messages'
  })
  assert.equal(localGatewayPathForProtocol('openai_chat'), '/v1/chat/completions')
  for (const protocol of ['gemini', 'toString', 'constructor', '__proto__']) {
    assert.throws(() => localGatewayPathForProtocol(protocol), { code: 'SERVER_RESPONSE_INVALID' })
  }
})

test('Bootstrap and Gateway model directories require known non-empty protocols', () => {
  const bootstrap = fixture('bootstrap-success.json')
  const gateway = fixture('gateway-models-success.json')
  assert.deepEqual(
    parseBootstrapResponse(bootstrap, { serverOrigin }).models[0].protocols,
    ['openai_responses', 'anthropic_messages']
  )
  assert.deepEqual(parseGatewayModelsResponse(gateway).data[1], {
    id: 'fixture-chat-model',
    object: 'model',
    ownedBy: 'ucli',
    displayName: 'Fixture Chat Model',
    contextSize: 64000,
    protocols: ['openai_chat']
  })
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

test('model selection and directory agreement never fall back to the first model', () => {
  const bootstrapModels = parseBootstrapResponse(fixture('bootstrap-success.json'), { serverOrigin }).models
  const gatewayModels = parseGatewayModelsResponse(fixture('gateway-models-success.json')).data
  assert.equal(selectModelForProtocol(gatewayModels, 'openai_chat').id, 'fixture-chat-model')
  assert.equal(selectModelForProtocol(gatewayModels, 'openai_responses').id, 'fixture-model')
  assert.equal(selectModelForProtocol([{ ...gatewayModels[0], protocols: ['openai_chat'] }], 'openai_responses'), null)
  assert.equal(assertGatewayModelProtocolConsistency({
    bootstrapModels,
    gatewayModels,
    modelId: 'fixture-model',
    protocol: 'openai_responses'
  }).id, 'fixture-model')
  assert.throws(() => assertGatewayModelProtocolConsistency({
    bootstrapModels,
    gatewayModels: [{ ...gatewayModels[0], protocols: ['openai_responses'] }],
    modelId: 'fixture-model',
    protocol: 'openai_responses'
  }), { code: 'SERVER_RESPONSE_INVALID' })
})

test('Gateway response metadata contains only allowlisted response fields', () => {
  const safe = gatewayResponseMetadata({
    status: 503,
    headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ucli-request-id': 'fixture-request-metadata',
      authorization: 'Bearer fixture-access-token'
    })
  })
  assert.deepEqual(safe, {
    httpStatus: 503,
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'no-store',
    stableCode: 'not-received',
    requestId: 'fixture-request-metadata',
    retryable: null
  })
  assert.deepEqual(Object.keys(safe).sort(), [
    'cacheControl', 'contentType', 'httpStatus', 'requestId', 'retryable', 'stableCode'
  ])
})

test('stable Gateway 503 fixtures produce only allowlisted diagnostics', () => {
  for (const [name, stableCode, retryable] of [
    ['error-model-protocol-unavailable.json', 'model_protocol_unavailable', false],
    ['error-model-channel-unavailable.json', 'model_channel_unavailable', true],
    ['error-upstream-unavailable.json', 'upstream_unavailable', true]
  ]) {
    const body = fixture(name)
    const safe = parseGatewayRouteFailure({
      status: 503,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-ucli-request-id': body.requestId
      }),
      body
    })
    assert.deepEqual(safe, {
      httpStatus: 503,
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
      stableCode,
      requestId: body.requestId,
      retryable
    })
    assert.deepEqual(Object.keys(safe).sort(), [
      'cacheControl', 'contentType', 'httpStatus', 'requestId', 'retryable', 'stableCode'
    ])
  }
})

test('Gateway route failures reject malformed stable 503 responses without serialising secrets', () => {
  const body = fixture('error-model-protocol-unavailable.json')
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-ucli-request-id': body.requestId
  })
  const cases = [
    { headers: new Headers({ ...Object.fromEntries(headers), 'cache-control': 'private' }) },
    { headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }) },
    { headers: new Headers({ ...Object.fromEntries(headers), 'x-ucli-request-id': 'fixture-request-other' }) },
    { status: 502 },
    { body: { ...body, statusCode: 502 } },
    { body: { ...body, message: 'untrusted route message' } },
    { body: { ...body, retryable: true } },
    { headers: new Headers({ ...Object.fromEntries(headers), 'content-type': 'text/plain' }) },
    { body: { ...body, code: 'future_gateway_error' } }
  ]
  for (const value of cases) {
    assert.throws(() => parseGatewayRouteFailure({
      status: value.status ?? 503,
      headers: value.headers || headers,
      body: {
        ...body,
        secret: 'fixture-gateway-secret',
        accessToken: 'fixture-gateway-token',
        url: 'http://gateway.fixture.test/route#fixture-gateway-secret',
        stack: 'fixture-gateway-stack',
        ...value.body
      }
    }), error => {
      assert.equal(error?.code, 'SERVER_RESPONSE_INVALID')
      const serialised = JSON.stringify(error?.diagnostic)
      assert.deepEqual(Object.keys(error?.diagnostic).sort(), [
        'cacheControl', 'contentType', 'httpStatus', 'requestId', 'retryable', 'stableCode'
      ])
      for (const unsafe of [
        'The model does not support the requested protocol',
        'untrusted route message',
        'fixture-gateway-secret',
        'fixture-gateway-token',
        'http://gateway.fixture.test/route',
        'fixture-gateway-stack'
      ]) assert.equal(serialised.includes(unsafe), false)
      return true
    })
  }
})

test('Gateway route failures fail closed when body getters throw untrusted errors', () => {
  const body = fixture('error-model-protocol-unavailable.json')
  const untrusted = Object.assign(new Error('untrusted getter'), {
    code: 'SERVER_RESPONSE_INVALID',
    diagnostic: { secret: 'untrusted-getter-secret' }
  })
  Object.defineProperty(body, 'code', {
    get() { throw untrusted }
  })
  assert.throws(() => parseGatewayRouteFailure({
    status: 503,
    headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ucli-request-id': body.requestId
    }),
    body
  }), error => {
    assert.notEqual(error, untrusted)
    assert.equal(error?.code, 'SERVER_RESPONSE_INVALID')
    assert.deepEqual(error?.diagnostic, {
      httpStatus: 503,
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
      stableCode: 'not-received',
      requestId: body.requestId,
      retryable: null
    })
    const serialised = JSON.stringify(error?.diagnostic)
    assert.equal(serialised.includes('untrusted getter'), false)
    assert.equal(serialised.includes('untrusted-getter-secret'), false)
    return true
  })
})

test('Gateway route failures fail closed when body getters throw nullish values', () => {
  for (const thrown of [undefined, null]) {
    const body = fixture('error-model-protocol-unavailable.json')
    Object.defineProperty(body, 'code', {
      get() { throw thrown }
    })
    let caught
    try {
      parseGatewayRouteFailure({
        status: 503,
        headers: new Headers({
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-ucli-request-id': 'fixture-request-protocol'
        }),
        body
      })
    } catch (error) {
      caught = error
    }
    assert.equal(caught?.code, 'SERVER_RESPONSE_INVALID')
    assert.deepEqual(caught?.diagnostic, {
      httpStatus: 503,
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
      stableCode: 'not-received',
      requestId: 'fixture-request-protocol',
      retryable: null
    })
  }
})

test('response parsers return known protocol fields and ignore unknown fields', () => {
  const preview = parsePreviewResponse({ ...fixture('preview-available.json'), unexpected: 'discard me' })
  assert.deepEqual(preview.link, { status: 'AVAILABLE', expiresAt: '2026-09-02T04:00:00.000Z' })
  assert.equal(Object.hasOwn(preview, 'unexpected'), false)

  const redeem = parseRedeemResponse({ ...fixture('redeem-success.json'), unexpected: true })
  assert.equal(redeem.accessToken, 'fixture-access-token')
  assert.equal(Object.hasOwn(redeem, 'unexpected'), false)

  const refresh = parseRefreshResponse({ ...fixture('refresh-success.json'), unexpected: true })
  assert.equal(refresh.refreshToken, 'fixture-next-refresh-token')
  assert.equal(Object.hasOwn(refresh, 'unexpected'), false)

  const bootstrap = parseBootstrapResponse({ ...fixture('bootstrap-success.json'), unexpected: true }, { serverOrigin })
  assert.deepEqual(bootstrap.gateway, { baseUrl: 'http://server.fixture.test/gateway' })
  assert.equal(Object.hasOwn(bootstrap, 'unexpected'), false)

  const skills = parseSkillsCatalogPage([{ ...fixture('skills-catalog-page.json')[0], unexpected: true }], { serverOrigin })
  assert.equal(skills[0].skill.slug, 'fixture-skill')
  assert.equal(Object.hasOwn(skills[0], 'unexpected'), false)
})

test('response parsers fail closed for missing required fields, wrong types, invalid dates, and unknown enums', () => {
  const preview = fixture('preview-available.json')
  const redeem = fixture('redeem-success.json')
  const refresh = fixture('refresh-success.json')
  const bootstrap = fixture('bootstrap-success.json')
  const catalog = fixture('skills-catalog-page.json')

  for (const [parse, value, options] of [
    [parsePreviewResponse, { ...preview, account: undefined }],
    [parseRedeemResponse, { ...redeem, expiresIn: '900' }],
    [parseRefreshResponse, { ...refresh, authorization: { ...refresh.authorization, serverTime: 'not-a-date' } }],
    [parseBootstrapResponse, { ...bootstrap, models: 'not-an-array' }, { serverOrigin }],
    [parseSkillsCatalogPage, [{ ...catalog[0], sizeBytes: '2048' }], { serverOrigin }],
    [parsePreviewResponse, { ...preview, link: { ...preview.link, status: 'UNKNOWN' } }],
    [parsePreviewResponse, { ...preview, authorization: { ...preview.authorization, expiresAt: 'yesterday' } }]
  ]) {
    assert.throws(() => parse(value, options), error => error?.code === 'SERVER_RESPONSE_INVALID')
  }
})

test('bootstrap and skills URLs must be same-origin HTTP(S) URLs without credentials or fragments', () => {
  const bootstrap = fixture('bootstrap-success.json')
  const catalog = fixture('skills-catalog-page.json')
  for (const baseUrl of [
    'https://other.fixture.test/gateway',
    'http://user:password@server.fixture.test/gateway',
    'http://server.fixture.test/gateway#fragment',
    'ftp://server.fixture.test/gateway'
  ]) {
    assert.throws(
      () => parseBootstrapResponse({ ...bootstrap, gateway: { baseUrl } }, { serverOrigin }),
      error => error?.code === 'SERVER_RESPONSE_INVALID'
    )
  }
  for (const downloadUrl of [
    'https://other.fixture.test/api/v1/skills/skill-version-fixture-001/download',
    'http://server.fixture.test/api/v1/skills/skill-version-fixture-001/download#fragment',
    'http://user:password@server.fixture.test/api/v1/skills/skill-version-fixture-001/download'
  ]) {
    assert.throws(
      () => parseSkillsCatalogPage([{ ...catalog[0], downloadUrl }], { serverOrigin }),
      error => error?.code === 'SERVER_RESPONSE_INVALID'
    )
  }
})

test('sanitiseServerError emits only stable public fields and never serialises request secrets', () => {
  const inputUrl = 'http://server.fixture.test/connect#link=fixture-link-secret'
  const safe = sanitiseServerError(Object.assign(new Error('underlying stack must not survive'), {
    code: 'grant_expired',
    request: {
      url: inputUrl,
      body: { link: 'fixture-link-secret', accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' },
      headers: { Authorization: 'Bearer fixture-access-token', Cookie: 'fixture-cookie' }
    },
    stack: 'private-stack-trace'
  }))
  assert.deepEqual(safe, { code: 'grant_expired', message: 'Device grant has expired', retryable: false })
  const serialised = JSON.stringify(safe)
  for (const secret of [inputUrl, 'fixture-link-secret', 'fixture-access-token', 'fixture-refresh-token', 'fixture-cookie', 'private-stack-trace']) {
    assert.equal(serialised.includes(secret), false)
  }
  assert.deepEqual(sanitiseServerError({ code: 'grant_bound' }), {
    code: null, message: 'Server operation failed', retryable: false
  })
  assert.deepEqual(sanitiseServerError({ code: 'ETIMEDOUT', retryable: true }), {
    code: null, message: 'Server operation failed', retryable: true
  })
})
