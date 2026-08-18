import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u

function isLoopbackOrigin(url) {
  const match = LOOPBACK_ORIGIN.exec(typeof url === 'string' ? url : '')
  if (!match) return false
  const port = Number(match[1])
  return port >= 1 && port <= 65_535
}

function toFinite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function createDshWebClient({ fetchImpl = globalThis.fetch } = {}) {
  const request = async (url, method, payload) => {
    let response
    try {
      response = await fetchImpl(`${url}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload })
      })
    } catch {
      return null
    }
    if (!response?.ok) return null
    const body = await response.json().catch(() => null)
    return body?.result?.ok === true ? body.result.value : null
  }

  async function listSessions(url) {
    if (!isLoopbackOrigin(url)) return null
    const value = await request(url, 'session.list', {})
    if (!Array.isArray(value?.items)) return null
    return value.items.map((item) => ({
      sessionId: item?.sessionId,
      updatedAt: item?.updatedAt,
      tokenUsage: item?.projections?.values?.tokenUsage
    }))
  }

  async function aggregateTokenUsage(url) {
    const items = await listSessions(url)
    if (!items) return null
    let input = 0
    let output = 0
    for (const item of items) {
      const usage = item?.tokenUsage
      if (!usage) continue
      input += toFinite(usage.uncachedInputTokens) + toFinite(usage.cacheReadTokens)
      output += toFinite(usage.outputTokens)
    }
    return { input, output }
  }

  async function exportSession(url, sessionId) {
    if (!isLoopbackOrigin(url) || typeof sessionId !== 'string' || !sessionId) return null
    let response
    try {
      response = await fetchImpl(`${url}/api/session.export?sessionId=${encodeURIComponent(sessionId)}`)
    } catch {
      return null
    }
    if (!response?.ok) return null
    const buffer = await response.arrayBuffer().catch(() => null)
    if (!buffer) return null
    try {
      const files = unzipSync(new Uint8Array(buffer))
      const jsonl = files['session.jsonl']
      return jsonl ? new TextDecoder().decode(jsonl) : null
    } catch {
      return null
    }
  }

  return { listSessions, aggregateTokenUsage, exportSession }
}
