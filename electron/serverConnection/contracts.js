import { parseConnectionInput } from './linkParser.js'

export const LINK_STATUSES = Object.freeze(['AVAILABLE', 'EXPIRED', 'REVOKED', 'CONSUMED'])
export const AUTHORIZATION_STATUSES = Object.freeze(['AVAILABLE', 'BOUND', 'DISABLED', 'EXPIRED', 'DELETED'])
export const CONNECTION_STATUSES = Object.freeze([
  'disconnected', 'connecting', 'connected', 'unreachable', 'expiring',
  'disabled', 'expired', 'deleted', 'account_inactive', 'org_inactive'
])
export const SERVER_ERROR_CODES = Object.freeze([
  'invalid_link', 'link_expired', 'link_revoked', 'link_consumed',
  'invalid_device', 'invalid_grant', 'grant_disabled', 'grant_expired',
  'grant_deleted', 'account_inactive', 'organization_inactive'
])
export const PUBLIC_MODEL_PROTOCOLS = Object.freeze([
  'openai_responses', 'openai_chat', 'anthropic_messages'
])
export const MODEL_PROTOCOL_LOCAL_PATHS = Object.freeze({
  openai_responses: '/v1/responses',
  openai_chat: '/v1/chat/completions',
  anthropic_messages: '/anthropic/v1/messages'
})

const GATEWAY_ROUTE_ERRORS = Object.freeze({
  model_protocol_unavailable: Object.freeze({
    message: 'The model does not support the requested protocol', retryable: false
  }),
  model_channel_unavailable: Object.freeze({
    message: 'No model channel is currently available', retryable: true
  }),
  upstream_unavailable: Object.freeze({
    message: 'No upstream channel succeeded', retryable: true
  })
})

// Keep the protocol target decoupled from package metadata until the release bump.
export const TARGET_CLIENT_VERSION = '0.12.0'

const LINK_STATUS_SET = new Set(LINK_STATUSES)
const AUTHORIZATION_STATUS_SET = new Set(AUTHORIZATION_STATUSES)
const SERVER_ERROR_CODE_SET = new Set(SERVER_ERROR_CODES)
const PUBLIC_MODEL_PROTOCOL_SET = new Set(PUBLIC_MODEL_PROTOCOLS)
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

function responseError() {
  return Object.assign(new TypeError('Server response is invalid'), { code: 'SERVER_RESPONSE_INVALID' })
}

function responseHeader(headers, name) {
  try { return new Headers(headers).get(name) } catch { return null }
}

export function gatewayResponseMetadata({ status, headers } = {}) {
  return {
    httpStatus: Number.isSafeInteger(status) ? status : 'not-received',
    contentType: responseHeader(headers, 'content-type') || 'not-received',
    cacheControl: responseHeader(headers, 'cache-control') || 'not-received',
    stableCode: 'not-received',
    requestId: responseHeader(headers, 'x-ucli-request-id') || 'not-received',
    retryable: null
  }
}

function hasJsonContentType(contentType) {
  return /^application\/json(?:\s*;\s*charset\s*=\s*[^;\s](?:[^;]*[^;\s])?)?$/i.test(contentType)
}

function hasNoStoreDirective(cacheControl) {
  return cacheControl.split(',').some(directive => directive.trim().toLowerCase() === 'no-store')
}

export function parseGatewayRouteFailure(value = {}) {
  let diagnostic = {
    httpStatus: 'not-received',
    contentType: 'not-received',
    cacheControl: 'not-received',
    stableCode: 'not-received',
    requestId: 'not-received',
    retryable: null
  }
  let ownError
  const invalid = () => {
    const error = responseError()
    error.diagnostic = diagnostic
    ownError = error
    throw error
  }
  try {
    const { status, headers, body } = value && typeof value === 'object' ? value : {}
    diagnostic = gatewayResponseMetadata({ status, headers })
    if (status !== 503 || !hasJsonContentType(diagnostic.contentType) ||
      !hasNoStoreDirective(diagnostic.cacheControl) || !body || typeof body !== 'object' || Array.isArray(body) ||
      body.statusCode !== 503 || typeof body.requestId !== 'string' || !body.requestId ||
      diagnostic.requestId === 'not-received' || body.requestId !== diagnostic.requestId ||
      typeof body.code !== 'string' || !Object.hasOwn(GATEWAY_ROUTE_ERRORS, body.code)) {
      return invalid()
    }
    const routeError = GATEWAY_ROUTE_ERRORS[body.code]
    if (body.message !== routeError.message || body.retryable !== routeError.retryable) return invalid()
    return { ...diagnostic, stableCode: body.code, requestId: body.requestId, retryable: routeError.retryable }
  } catch (error) {
    if (error === ownError) throw error
    return invalid()
  }
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw responseError()
  return value
}

function requiredString(value) {
  if (typeof value !== 'string' || !value) throw responseError()
  return value
}

function parseModelProtocols(value) {
  if (!Array.isArray(value) || value.length === 0 ||
    value.some(protocol => typeof protocol !== 'string' || !PUBLIC_MODEL_PROTOCOL_SET.has(protocol))) {
    throw responseError()
  }
  return [...value]
}

function parseGatewayModel(value) {
  value = object(value)
  if (value.object !== 'model' || !Number.isSafeInteger(value.context_size) || value.context_size <= 0) {
    throw responseError()
  }
  return {
    id: requiredString(value.id),
    object: 'model',
    ownedBy: requiredString(value.owned_by),
    displayName: requiredString(value.display_name),
    contextSize: value.context_size,
    protocols: parseModelProtocols(value.protocols)
  }
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function requiredDate(value) {
  if (typeof value !== 'string') throw responseError()
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) || Number.isNaN(Date.parse(value))) {
    throw responseError()
  }
  return value
}

function nullableDate(value) {
  return value === null ? null : requiredDate(value)
}

function parseAccount(value) {
  value = object(value)
  return { id: requiredString(value.id), displayName: requiredString(value.displayName) }
}

function parseOrganization(value, { timezone = false } = {}) {
  value = object(value)
  const parsed = { id: requiredString(value.id), name: requiredString(value.name) }
  if (timezone) parsed.timezone = requiredString(value.timezone)
  return parsed
}

function parseAuthorization(value, { status = false } = {}) {
  value = object(value)
  const parsed = { expiresAt: nullableDate(value.expiresAt), serverTime: requiredDate(value.serverTime) }
  if (status) {
    if (typeof value.status !== 'string' || !AUTHORIZATION_STATUS_SET.has(value.status)) throw responseError()
    return { status: value.status, ...parsed }
  }
  return parsed
}

function parseCredentials(value) {
  value = object(value)
  if (!Number.isSafeInteger(value.expiresIn) || value.expiresIn <= 0) throw responseError()
  return {
    accessToken: requiredString(value.accessToken),
    refreshToken: requiredString(value.refreshToken),
    expiresIn: value.expiresIn
  }
}

function parseServerOrigin(value) {
  let url
  try {
    url = new URL(requiredString(value))
  } catch {
    throw responseError()
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw responseError()
  }
  return url.origin
}

function parseSameOriginUrl(value, serverOrigin) {
  let url
  try {
    url = new URL(requiredString(value))
  } catch {
    throw responseError()
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search ||
    url.origin !== parseServerOrigin(serverOrigin)) {
    throw responseError()
  }
  return url.toString()
}

function parseFixedSameOriginUrl(value, serverOrigin, pathname) {
  const parsed = parseSameOriginUrl(value, serverOrigin)
  if (new URL(parsed).pathname !== pathname) throw responseError()
  return parsed
}

export function parsePreviewResponse(value) {
  value = object(value)
  const link = object(value.link)
  if (typeof link.status !== 'string' || !LINK_STATUS_SET.has(link.status)) throw responseError()
  return {
    account: parseAccount(value.account),
    organization: parseOrganization(value.organization),
    link: { status: link.status, expiresAt: nullableDate(link.expiresAt) },
    authorization: parseAuthorization(value.authorization, { status: true })
  }
}

export function parseRedeemResponse(value) {
  value = object(value)
  return {
    ...parseCredentials(value),
    account: parseAccount(value.account),
    organization: parseOrganization(value.organization),
    authorization: parseAuthorization(value.authorization)
  }
}

export function parseRefreshResponse(value) {
  value = object(value)
  return { ...parseCredentials(value), authorization: parseAuthorization(value.authorization) }
}

export function parseBootstrapResponse(value, { serverOrigin } = {}) {
  value = object(value)
  const gateway = object(value.gateway)
  if (!Array.isArray(value.models)) throw responseError()
  return {
    organization: parseOrganization(value.organization, { timezone: true }),
    gateway: { baseUrl: parseFixedSameOriginUrl(gateway.baseUrl, serverOrigin, '/gateway') },
    models: value.models.map(model => {
      model = object(model)
      if (!Number.isSafeInteger(model.contextSize) || model.contextSize <= 0) throw responseError()
      return {
        id: requiredString(model.id),
        displayName: requiredString(model.displayName),
        contextSize: model.contextSize,
        protocols: parseModelProtocols(model.protocols)
      }
    }),
    skillsCatalogUrl: parseFixedSameOriginUrl(value.skillsCatalogUrl, serverOrigin, '/api/v1/skills/catalog'),
    authorization: parseAuthorization(value.authorization)
  }
}

export function parseGatewayModelsResponse(value) {
  value = object(value)
  if (value.object !== 'list' || !Array.isArray(value.data)) throw responseError()
  return { object: 'list', data: value.data.map(parseGatewayModel) }
}

export function selectModelForProtocol(models, protocol) {
  if (!Array.isArray(models) || !PUBLIC_MODEL_PROTOCOL_SET.has(protocol)) throw responseError()
  return models.find(model => Array.isArray(model?.protocols) && model.protocols.includes(protocol)) || null
}

export function localGatewayPathForProtocol(protocol) {
  if (!PUBLIC_MODEL_PROTOCOL_SET.has(protocol)) throw responseError()
  const path = MODEL_PROTOCOL_LOCAL_PATHS[protocol]
  return path
}

function sameProtocolSet(left, right) {
  return left.length === right.length && left.every(protocol => right.includes(protocol))
}

export function assertGatewayModelProtocolConsistency({ bootstrapModels, gatewayModels, modelId, protocol } = {}) {
  if (!PUBLIC_MODEL_PROTOCOL_SET.has(protocol)) throw responseError()
  const bootstrapModel = bootstrapModels?.find(model => model.id === modelId)
  const gatewayModel = gatewayModels?.find(model => model.id === modelId)
  if (!bootstrapModel || !gatewayModel ||
    !bootstrapModel.protocols.includes(protocol) || !gatewayModel.protocols.includes(protocol) ||
    !sameProtocolSet(bootstrapModel.protocols, gatewayModel.protocols)) {
    throw responseError()
  }
  return gatewayModel
}

export function parseSkillsCatalogPage(value, { serverOrigin } = {}) {
  if (!Array.isArray(value) || value.length > 100) throw responseError()
  return value.map(item => {
    item = object(item)
    const skill = object(item.skill)
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 ||
      typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
      throw responseError()
    }
    return {
      id: requiredString(item.id),
      version: requiredString(item.version),
      sha256: item.sha256.toLowerCase(),
      sizeBytes: item.sizeBytes,
      publishedAt: requiredDate(item.publishedAt),
      createdAt: requiredDate(item.createdAt),
      skill: {
        slug: requiredString(skill.slug),
        name: requiredString(skill.name),
        description: requiredString(skill.description)
      },
      downloadUrl: parseFixedSameOriginUrl(item.downloadUrl, serverOrigin, `/api/v1/skills/${encodeURIComponent(item.id)}/download`)
    }
  })
}

const ERROR_MESSAGES = Object.freeze({
  invalid_link: 'Connection link is invalid',
  link_expired: 'Connection link has expired',
  link_revoked: 'Connection link was revoked',
  link_consumed: 'Connection link was already used',
  invalid_device: 'Device registration is invalid',
  invalid_grant: 'Device grant is invalid',
  grant_disabled: 'Device grant is disabled',
  grant_expired: 'Device grant has expired',
  grant_deleted: 'Device grant was deleted',
  account_inactive: 'Account is inactive',
  organization_inactive: 'Organization is inactive'
})

export function sanitiseServerError(error) {
  const code = typeof error?.code === 'string' && SERVER_ERROR_CODE_SET.has(error.code)
    ? error.code
    : null
  return {
    code,
    message: ERROR_MESSAGES[code] || 'Server operation failed',
    retryable: code === null ? error?.retryable === true : false
  }
}

export { parseConnectionInput }
