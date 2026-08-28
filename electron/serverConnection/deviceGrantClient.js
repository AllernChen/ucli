import {
  TARGET_CLIENT_VERSION,
  parseBootstrapResponse,
  parsePreviewResponse,
  parseRedeemResponse,
  parseRefreshResponse,
  sanitiseServerError
} from './contracts.js'
import { parseConnectionInput } from './linkParser.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' })

function invalidResponse() {
  return Object.assign(new TypeError('Server response is invalid'), { code: 'SERVER_RESPONSE_INVALID' })
}

function retryableFailure() {
  return Object.assign(new Error('Server request failed'), { retryable: true })
}

function trustedOrigin(serverOrigin) {
  return parseConnectionInput(`${serverOrigin}/connect#link=placeholder`).serverOrigin
}

function fixedUrl(serverOrigin, path) {
  return new URL(path, trustedOrigin(serverOrigin)).toString()
}

function requiredOpaqueValue(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('A required value is missing')
  return value
}

function validatedDevice(device) {
  if (!device || typeof device !== 'object' || Array.isArray(device) ||
    !UUID_V4.test(device.installationId) ||
    typeof device.name !== 'string' ||
    !['windows', 'macos', 'linux'].includes(device.platform) ||
    device.clientVersion !== TARGET_CLIENT_VERSION) {
    throw new TypeError('Device registration is invalid')
  }
  const name = device.name.trim()
  if (!name || [...name].length > 120) throw new TypeError('Device registration is invalid')
  return {
    installationId: device.installationId,
    name,
    platform: device.platform,
    clientVersion: device.clientVersion
  }
}

function hasNoStore(response) {
  const cacheControl = response.headers?.get?.('cache-control')
  return typeof cacheControl === 'string' && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)
}

function hasJsonContentType(response) {
  const contentType = response.headers?.get?.('content-type')
  return typeof contentType === 'string' && /^application\/json(?:;|$)/i.test(contentType)
}

async function errorFromResponse(response, expectedErrorStatus) {
  if (response.status !== expectedErrorStatus) throw invalidResponse()
  let body
  try {
    body = await response.json()
  } catch {
    throw invalidResponse()
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidResponse()
  throw Object.assign(new Error('Server operation failed'), { code: body.code })
}

export function createDeviceGrantClient({ fetchImpl = fetch, timeoutMs = 15_000, now = Date.now } = {}) {
  void now

  async function request({ serverOrigin, path, method, body, headers, parse, requireNoStore, expectedErrorStatus }) {
    const url = fixedUrl(serverOrigin, path)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual'
      })
    } catch {
      throw retryableFailure()
    }

    if (!response || typeof response.status !== 'number') throw retryableFailure()
    if (response.status >= 500) throw retryableFailure()
    if (!hasJsonContentType(response) || (requireNoStore && !hasNoStore(response))) throw invalidResponse()
    if (!response.ok) return errorFromResponse(response, expectedErrorStatus)

    let value
    try {
      value = await response.json()
    } catch {
      throw invalidResponse()
    }
    return parse(value, { serverOrigin })
  }

  async function safe(operation) {
    try {
      return await operation()
    } catch (error) {
      throw sanitiseServerError(error)
    }
  }

  return {
    preview({ serverOrigin, linkSecret }) {
      return safe(() => request({
        serverOrigin,
        path: '/api/v1/auth/device-grants/preview',
        method: 'POST',
        headers: JSON_HEADERS,
        body: { link: requiredOpaqueValue(linkSecret) },
        parse: parsePreviewResponse,
        requireNoStore: true,
        expectedErrorStatus: 400
      }))
    },
    redeem({ serverOrigin, linkSecret, device }) {
      return safe(() => request({
        serverOrigin,
        path: '/api/v1/auth/device-grants/redeem',
        method: 'POST',
        headers: JSON_HEADERS,
        body: { link: requiredOpaqueValue(linkSecret), device: validatedDevice(device) },
        parse: parseRedeemResponse,
        requireNoStore: true,
        expectedErrorStatus: 400
      }))
    },
    refresh({ serverOrigin, refreshToken }) {
      return safe(() => request({
        serverOrigin,
        path: '/api/v1/auth/token/refresh',
        method: 'POST',
        headers: JSON_HEADERS,
        body: { refreshToken: requiredOpaqueValue(refreshToken) },
        parse: parseRefreshResponse,
        requireNoStore: true,
        expectedErrorStatus: 401
      }))
    },
    bootstrap({ serverOrigin, accessToken }) {
      return safe(() => request({
        serverOrigin,
        path: '/api/v1/client/bootstrap',
        method: 'GET',
        headers: { Authorization: `Bearer ${requiredOpaqueValue(accessToken)}` },
        parse: parseBootstrapResponse,
        requireNoStore: false,
        expectedErrorStatus: 401
      }))
    }
  }
}
