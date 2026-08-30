const TRUSTED_HTTP_ORIGIN = 'http://10.44.100.100'

function linkError() {
  return Object.assign(new TypeError('Connection link is invalid'), { code: 'CONNECTION_LINK_INVALID' })
}

function parseOpaqueLink(hash) {
  if (!hash || !hash.startsWith('#')) throw linkError()
  const fragment = hash.slice(1)
  if (!fragment.startsWith('link=') || fragment.includes('&')) throw linkError()
  const linkSecret = fragment.slice('link='.length)
  if (!linkSecret) throw linkError()
  return linkSecret
}

function parsePureServerOrigin(value) {
  let server
  try {
    server = new URL(value)
  } catch {
    throw linkError()
  }
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password ||
    server.pathname !== '/' || server.search || server.hash || server.origin === 'null' || value !== server.origin ||
    (server.protocol === 'http:' && server.origin !== TRUSTED_HTTP_ORIGIN)) {
    throw linkError()
  }
  return server.origin
}

function parseCustomProtocol(url) {
  if (url.protocol !== 'ucli:' || url.host !== 'connect' || url.username || url.password || url.pathname || !url.search) {
    throw linkError()
  }
  const query = url.search.slice(1)
  if (!query.startsWith('server=') || query.includes('&')) throw linkError()

  let serverValue
  try {
    serverValue = decodeURIComponent(query.slice('server='.length))
  } catch {
    throw linkError()
  }
  return {
    serverOrigin: parsePureServerOrigin(serverValue),
    linkSecret: parseOpaqueLink(url.hash)
  }
}

function parseBrowserUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/connect' || url.search || url.origin === 'null' ||
    (url.protocol === 'http:' && url.origin !== TRUSTED_HTTP_ORIGIN)) {
    throw linkError()
  }
  return {
    serverOrigin: url.origin,
    linkSecret: parseOpaqueLink(url.hash)
  }
}

export function parseConnectionInput(input) {
  if (typeof input !== 'string' || !input || input.trim() !== input) throw linkError()
  let url
  try {
    url = new URL(input)
  } catch {
    throw linkError()
  }
  return url.protocol === 'ucli:' ? parseCustomProtocol(url) : parseBrowserUrl(url)
}
