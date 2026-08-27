import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  AUTHORIZATION_STATUSES,
  CONNECTION_STATUSES,
  LINK_STATUSES,
  SERVER_ERROR_CODES,
  parseBootstrapResponse,
  parsePreviewResponse,
  parseRedeemResponse,
  parseRefreshResponse,
  parseSkillsCatalogPage,
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
    code: 'server_operation_failed', message: 'Server operation failed', retryable: false
  })
})
