export const DSH_WEB_IFRAME_SANDBOX = 'allow-same-origin allow-scripts'
export const DSH_WEB_IFRAME_ALLOW = 'clipboard-write'

const READY_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u
const ERROR_CODES = new Set([
  'DSH_WEB_SPAWN_FAILED',
  'DSH_WEB_RUNTIME_UNAVAILABLE',
  'DSH_WEB_START_TIMEOUT',
  'DSH_WEB_READY_URL_INVALID',
  'DSH_WEB_CLEANUP_FAILED'
])

function exactReadyUrl(value) {
  if (typeof value !== 'string') return null
  const match = READY_URL.exec(value)
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65_535 ? value : null
}

export function deriveHostedWebSurface(state) {
  if (state?.kind !== 'web') {
    return { kind: 'web', status: 'error', url: null, errorCode: 'DSH_WEB_READY_URL_INVALID' }
  }
  if (state.status === 'ready') {
    const url = exactReadyUrl(state.url)
    if (url && state.errorCode == null) {
      return { kind: 'web', status: 'ready', url, errorCode: null }
    }
  } else if (['starting', 'stopping', 'stopped'].includes(state.status)) {
    if (state.url == null && state.errorCode == null) {
      return { kind: 'web', status: state.status, url: null, errorCode: null }
    }
  } else if (
    state.status === 'error' && state.url == null && ERROR_CODES.has(state.errorCode)
  ) {
    return { kind: 'web', status: 'error', url: null, errorCode: state.errorCode }
  }
  return { kind: 'web', status: 'error', url: null, errorCode: 'DSH_WEB_READY_URL_INVALID' }
}
