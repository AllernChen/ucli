import { randomUUID } from 'node:crypto'

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u

function isLoopbackOrigin(url) {
  const match = LOOPBACK_ORIGIN.exec(typeof url === 'string' ? url : '')
  if (!match) return false
  const port = Number(match[1])
  return port >= 1 && port <= 65_535
}

export function createDshWebClient({ fetchImpl = globalThis.fetch } = {}) {
  const request = async (url, method, payload) => {
    const response = await fetchImpl(`${url}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload })
    })
    if (!response?.ok) return null
    const body = await response.json().catch(() => null)
    return body?.result?.ok === true ? body.result.value : null
  }

  async function listSessions(url) {
    if (!isLoopbackOrigin(url)) return null
    const value = await request(url, 'session.list', {})
    return Array.isArray(value?.items) ? value.items : null
  }

  async function aggregateTokenUsage(url) {
    const items = await listSessions(url)
    if (!items) return null
    let input = 0
    let output = 0
    for (const item of items) {
      const usage = item?.projections?.values?.tokenUsage
      if (!usage) continue
      input += Number(usage.uncachedInputTokens || 0) + Number(usage.cacheReadTokens || 0)
      output += Number(usage.outputTokens || 0)
    }
    return { input, output }
  }

  return { listSessions, aggregateTokenUsage }
}
