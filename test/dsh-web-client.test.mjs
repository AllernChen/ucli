import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshWebClient } from '../electron/adapters/dshWebClient.js'

function jsonFetch(handler) {
  return async (url, options) => {
    const method = url.slice(url.lastIndexOf('/api/') + '/api/'.length)
    const body = JSON.parse(options.body)
    return handler(method, body, { ok: true, json: async () => ({}) })
  }
}

test('aggregateTokenUsage sums uncachedInput+cacheRead into input and outputTokens into output', async () => {
  let sawPayload = null
  const fetchImpl = jsonFetch((method, body) => {
    sawPayload = { method, body }
    return {
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'a', updatedAt: 1, projections: { values: { tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 } } } },
              { sessionId: 'b', updatedAt: 2, projections: { values: { tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } } }
            ]
          }
        }
      })
    }
  })
  const client = createDshWebClient({ fetchImpl })
  const result = await client.aggregateTokenUsage('http://127.0.0.1:43127')
  assert.deepEqual(result, { input: 124, output: 52 })
  assert.equal(sawPayload.method, 'session.list')
  assert.equal(sawPayload.body.method, 'session.list')
})

test('client rejects non-loopback origins and API errors with null', async () => {
  const client = createDshWebClient({ fetchImpl: async () => { throw new Error('unreachable') } })
  assert.equal(await client.aggregateTokenUsage('http://evil.example.com:43127'), null)
  const failing = createDshWebClient({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) })
  assert.equal(await failing.listSessions('http://127.0.0.1:43127'), null)
})

test('listSessions returns null on network error with a valid loopback origin', async () => {
  const client = createDshWebClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(await client.listSessions('http://127.0.0.1:43127'), null)
})

test('listSessions normalizes items to { sessionId, updatedAt, tokenUsage }', async () => {
  const fetchImpl = jsonFetch(() => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: {
          items: [
            { sessionId: 'a', updatedAt: 1, projections: { values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } } } }
          ]
        }
      }
    })
  }))
  const client = createDshWebClient({ fetchImpl })
  const items = await client.listSessions('http://127.0.0.1:43127')
  assert.deepEqual(items, [{ sessionId: 'a', updatedAt: 1, tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } }])
})
