import http from 'node:http'
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ALLOWED_ROUTES = new Map([
  ['GET /v1/models', 'models'],
  ['POST /v1/responses', 'responses'],
  ['POST /v1/chat/completions', 'chat-completions'],
  ['POST /anthropic/v1/messages', 'anthropic-messages']
])

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
])
const UNSAFE_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS, 'authorization', 'cookie', 'host', 'content-length', 'x-api-key'
])

function immutableIdentity({ connectionId, connectionRevision } = {}) {
  if (typeof connectionId !== 'string' || !connectionId || !Number.isSafeInteger(connectionRevision)) {
    throw new TypeError('A connectionId and connectionRevision are required')
  }
  return Object.freeze({ connectionId, connectionRevision })
}

function sameIdentity(left, right) {
  return Boolean(left && right &&
    left.connectionId === right.connectionId &&
    left.connectionRevision === right.connectionRevision)
}

function sessionFingerprint(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
}

function routeFor(request) {
  if (typeof request.url !== 'string' || request.url.includes('?') || request.url.includes('#')) return null
  return ALLOWED_ROUTES.get(`${request.method} ${request.url}`) || null
}

function authorizationBearer(request) {
  const value = request.headers.authorization
  const bearer = Array.isArray(value) ? value[0] : value
  const match = typeof bearer === 'string' ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(bearer) : null
  return match?.[1] || null
}

function safeHeaders(headers) {
  const connectionTokens = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase())
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (UNSAFE_REQUEST_HEADERS.has(lower) || connectionTokens.includes(lower)) continue
    if (value !== undefined) forwarded[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  return forwarded
}

function safeResponseHeaders(headers) {
  const forwarded = {}
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) forwarded[name] = value
  }
  return forwarded
}

function gatewayUrl(baseUrl, route) {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Gateway base URL is unavailable')
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  return new URL(`${basePath}${route}`, base.origin)
}

function crossOriginRedirect(response, upstreamUrl) {
  if (response.status < 300 || response.status >= 400) return false
  const location = response.headers.get('location')
  if (!location) return false
  try { return new URL(location, upstreamUrl).origin !== upstreamUrl.origin } catch { return true }
}

export function createLocalGatewayProxy({ connectionManager, fetchImpl = fetch, randomBytes = nodeRandomBytes, logger = () => {} } = {}) {
  if (!connectionManager || typeof connectionManager.getRuntimeConnectionIdentity !== 'function') {
    throw new TypeError('A connection manager with runtime identity access is required')
  }
  const sessions = new Map()
  let server = null
  let baseUrl = null
  let closed = false

  function log({ origin = null, route = 'unknown', status, startedAt, sessionId }) {
    try {
      logger({
        origin,
        route,
        status,
        durationMs: Date.now() - startedAt,
        sessionId: sessionId ? sessionFingerprint(sessionId) : null
      })
    } catch { /* diagnostics must never affect requests */ }
  }

  function reject(response, status, context) {
    response.writeHead(status)
    response.end()
    log({ ...context, status })
  }

  async function requestHandler(request, response) {
    const startedAt = Date.now()
    const bearer = authorizationBearer(request)
    const session = bearer ? sessions.get(bearer) : null
    const route = routeFor(request)
    const sessionIsCurrent = () => !closed && sameIdentity(connectionManager.getRuntimeConnectionIdentity(), session?.identity)
    if (!session || !sessionIsCurrent()) {
      reject(response, 401, { route: route || 'unknown', startedAt, sessionId: session?.sessionId })
      return
    }
    if (!route) {
      reject(response, 404, { route: 'unknown', startedAt, sessionId: session.sessionId })
      return
    }

    const abortController = new AbortController()
    const abortUpstream = () => abortController.abort()
    request.once('aborted', abortUpstream)
    request.socket.once('close', abortUpstream)
    response.once('close', () => {
      if (!response.writableEnded) abortUpstream()
    })

    let origin = null
    try {
      const bootstrap = await connectionManager.getBootstrap()
      if (!sessionIsCurrent()) {
        reject(response, 401, { route, startedAt, sessionId: session.sessionId })
        return
      }
      const upstreamUrl = gatewayUrl(bootstrap?.gateway?.baseUrl, request.url)
      origin = upstreamUrl.origin
      let accessToken = await connectionManager.getAccessToken()
      if (!sessionIsCurrent()) {
        reject(response, 401, { origin, route, startedAt, sessionId: session.sessionId })
        return
      }
      const forward = async token => fetchImpl(upstreamUrl, {
        method: request.method,
        headers: { ...safeHeaders(request.headers), authorization: `Bearer ${token}` },
        body: request.method === 'POST' ? Readable.toWeb(request) : undefined,
        duplex: request.method === 'POST' ? 'half' : undefined,
        redirect: 'manual',
        signal: abortController.signal
      })
      let upstream = await forward(accessToken)
      if (upstream.status === 401 && request.method === 'GET' && request.url === '/v1/models') {
        await upstream.body?.cancel()
        accessToken = await connectionManager.getAccessToken({ minValidityMs: Number.MAX_SAFE_INTEGER })
        if (!sessionIsCurrent()) {
          reject(response, 401, { origin, route, startedAt, sessionId: session.sessionId })
          return
        }
        upstream = await forward(accessToken)
      }
      if (crossOriginRedirect(upstream, upstreamUrl)) {
        await upstream.body?.cancel()
        reject(response, 502, { origin, route, startedAt, sessionId: session.sessionId })
        return
      }
      response.writeHead(upstream.status, safeResponseHeaders(upstream.headers))
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response)
      else response.end()
      log({ origin, route, status: upstream.status, startedAt, sessionId: session.sessionId })
    } catch {
      if (!response.headersSent && !response.writableEnded) {
        reject(response, sessionIsCurrent() ? 502 : 401, { origin, route, startedAt, sessionId: session.sessionId })
      }
    } finally {
      request.removeListener('aborted', abortUpstream)
      request.socket.removeListener('close', abortUpstream)
    }
  }

  return {
    get baseUrl() { return baseUrl },
    async start() {
      if (closed) throw new Error('Loopback proxy is shut down')
      if (server) return baseUrl
      server = http.createServer(requestHandler)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Loopback proxy did not bind IPv4 loopback')
      baseUrl = `http://127.0.0.1:${address.port}`
      return baseUrl
    },
    createSession({ sessionId, connectionId, connectionRevision } = {}) {
      if (!baseUrl || closed || typeof sessionId !== 'string' || !sessionId) throw new Error('Loopback proxy is unavailable')
      const identity = immutableIdentity({ connectionId, connectionRevision })
      let bearer
      do { bearer = Buffer.from(randomBytes(32)).toString('base64url') } while (sessions.has(bearer))
      sessions.set(bearer, { sessionId, identity })
      return { baseUrl, bearer, connectionRevision: identity.connectionRevision }
    },
    revokeSession(sessionId) {
      for (const [bearer, session] of sessions) if (session.sessionId === sessionId) sessions.delete(bearer)
    },
    revokeConnection(identity) {
      const target = immutableIdentity(identity)
      for (const [bearer, session] of sessions) if (sameIdentity(session.identity, target)) sessions.delete(bearer)
    },
    revokeRevision(identity) {
      this.revokeConnection(identity)
    },
    async shutdown() {
      closed = true
      sessions.clear()
      const active = server
      server = null
      baseUrl = null
      if (active) {
        active.closeIdleConnections?.()
        active.closeAllConnections?.()
        await new Promise((resolve, reject) => active.close(error => error ? reject(error) : resolve()))
      }
    }
  }
}
