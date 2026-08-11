import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

const {
  createStatsQueryHandler,
  validateUsageQueryInput
} = await import(`../electron/orchestrator.js?stats-ipc=${Date.now()}`)

function loadPreloadApi(invoke) {
  const source = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
    .replace("import { contextBridge, ipcRenderer } from 'electron'", '')
  let api = null
  new Function('contextBridge', 'ipcRenderer', source)(
    { exposeInMainWorld: (_name, value) => { api = value } },
    { invoke, on: () => {}, removeListener: () => {} }
  )
  return api
}

function loadRendererIpc(ucli) {
  const source = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
    .replace('export const ipc =', 'const ipc =')
    .replace('export default ipc', '')
  return new Function('window', `${source}\nreturn ipc`)({ ucli })
}

test('stats query validation accepts default ranges and allowlists every contract field', async () => {
  assert.deepEqual(validateUsageQueryInput({ granularity: 'day' }), {
    granularity: 'day', projectPaths: [], adapterIds: [], models: []
  })

  const payload = {
    granularity: 'hour',
    start: 10,
    endExclusive: 20,
    timeZone: 'UTC',
    projectPaths: ['/work/a', '/work/a'],
    adapterIds: ['claude'],
    models: ['sonnet']
  }
  assert.deepEqual(validateUsageQueryInput(payload), {
    granularity: 'hour',
    start: 10,
    endExclusive: 20,
    timeZone: 'UTC',
    projectPaths: ['/work/a'],
    adapterIds: ['claude'],
    models: ['sonnet']
  })

  assert.throws(
    () => validateUsageQueryInput({ granularity: 'day', sql: 'SELECT secret' }),
    { code: 'INVALID_USAGE_QUERY', message: 'Invalid usage query' }
  )
  assert.throws(
    () => validateUsageQueryInput({ granularity: 'day', start: 10 }),
    { code: 'INVALID_USAGE_QUERY', message: 'Invalid usage query' }
  )
})

test('stats query handler delegates normalized default queries and serializes typed errors safely', async () => {
  const calls = []
  const handler = createStatsQueryHandler(() => ({
    queryUsage(query) {
      calls.push(query)
      if (query.granularity === 'hour') {
        throw Object.assign(new RangeError('limited to 400 buckets'), {
          code: 'TOO_MANY_BUCKETS',
          suggestedGranularity: 'day',
          sql: 'SELECT * FROM usage_events',
          stack: 'private stack'
        })
      }
      return { granularity: query.granularity, buckets: [] }
    }
  }))

  assert.deepEqual(await handler({}, { granularity: 'day' }), {
    ok: true,
    value: { granularity: 'day', buckets: [] }
  })
  assert.deepEqual(calls[0], {
    granularity: 'day', projectPaths: [], adapterIds: [], models: []
  })

  const failed = await handler({}, { granularity: 'hour' })
  assert.deepEqual(failed, {
    ok: false,
    error: {
      code: 'TOO_MANY_BUCKETS',
      message: 'limited to 400 buckets',
      suggestedGranularity: 'day'
    }
  })
  assert.equal(JSON.stringify(failed).includes('SELECT'), false)
  assert.equal(JSON.stringify(failed).includes('private stack'), false)
})

test('stats query handler converts invalid and internal failures to safe typed payloads', async () => {
  const invalid = createStatsQueryHandler(() => ({ queryUsage() { throw new Error('unused') } }))
  assert.deepEqual(await invalid({}, { granularity: 'day', unexpected: true }), {
    ok: false,
    error: { code: 'INVALID_USAGE_QUERY', message: 'Invalid usage query' }
  })

  const internal = createStatsQueryHandler(() => ({
    queryUsage() {
      throw Object.assign(new Error('SQLITE failure at C:\\private\\ucli.db'), {
        code: 'SQLITE_ERROR',
        sql: 'SELECT * FROM usage_events'
      })
    }
  }))
  assert.deepEqual(await internal({}, { granularity: 'day' }), {
    ok: false,
    error: { code: 'USAGE_QUERY_FAILED', message: 'Unable to query usage' }
  })
})

test('preload exposes only named stats calls and unwraps safe stats query envelopes', async () => {
  const calls = []
  const api = loadPreloadApi(async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'stats:query') {
      if (args[0].granularity === 'hour') {
        return {
          ok: false,
          error: {
            code: 'TOO_MANY_BUCKETS',
            message: 'limited to 400 buckets',
            suggestedGranularity: 'day'
          }
        }
      }
      return { ok: true, value: { buckets: [] } }
    }
    return { total: {} }
  })

  assert.equal(typeof api.getStats, 'function')
  assert.equal(typeof api.queryStats, 'function')
  assert.equal(api.invoke, undefined)
  await api.getStats()
  assert.deepEqual(await api.queryStats({ granularity: 'day' }), { buckets: [] })
  await assert.rejects(
    api.queryStats({ granularity: 'hour' }),
    { code: 'TOO_MANY_BUCKETS', message: 'limited to 400 buckets', suggestedGranularity: 'day' }
  )
  assert.deepEqual(calls, [
    ['stats:get'],
    ['stats:query', { granularity: 'day' }],
    ['stats:query', { granularity: 'hour' }]
  ])
})

test('renderer IPC delegates stats queries to the named preload method', async () => {
  const calls = []
  const ipc = loadRendererIpc({
    getStats: () => { calls.push(['getStats']); return 'legacy' },
    queryStats: (query) => { calls.push(['queryStats', query]); return 'trend' }
  })

  assert.equal(ipc.getStats(), 'legacy')
  assert.equal(ipc.queryStats({ granularity: 'week' }), 'trend')
  assert.deepEqual(calls, [
    ['getStats'],
    ['queryStats', { granularity: 'week' }]
  ])
})
