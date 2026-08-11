import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

const trendRequests = []

globalThis.window = {
  ucli: {
    queryStats(query) {
      return new Promise((resolve, reject) => {
        trendRequests.push({ query, resolve, reject })
      })
    }
  }
}

const { useStatsStore } = await import(`../src/stores/stats.js?stats-store=${Date.now()}`)

function createStore() {
  trendRequests.length = 0
  setActivePinia(createPinia())
  return useStatsStore()
}

test('stats store starts with daily trend state and array filters', () => {
  const store = createStore()
  assert.equal(store.granularity, 'day')
  assert.equal(store.range, null)
  assert.deepEqual(store.filters, { projectPaths: [], adapterIds: [], models: [] })
  assert.equal(store.trend, null)
  assert.equal(store.trendLoading, false)
  assert.equal(store.trendError, null)
})

test('stats store loads trends with copied filters and tracks loading', async () => {
  const store = createStore()
  const projects = ['/work/a']
  store.setGranularity('week')
  store.setFilters({ projectPaths: projects, adapterIds: ['claude'], models: ['sonnet'] })
  projects.push('/work/mutated')

  const pending = store.loadTrend()
  assert.equal(store.trendLoading, true)
  assert.equal(store.trendError, null)
  assert.deepEqual(trendRequests[0].query, {
    granularity: 'week',
    projectPaths: ['/work/a'],
    adapterIds: ['claude'],
    models: ['sonnet']
  })

  trendRequests[0].resolve({ granularity: 'week', range: { start: 1, endExclusive: 2 }, buckets: [] })
  await pending
  assert.equal(store.trendLoading, false)
  assert.deepEqual(store.trend, {
    granularity: 'week', range: { start: 1, endExclusive: 2 }, buckets: []
  })
})

test('stats store includes an explicit range without changing filter array types', async () => {
  const store = createStore()
  store.range = { start: 10, endExclusive: 20, timeZone: 'UTC' }
  store.setFilters({ projectPaths: null, adapterIds: undefined, models: ['gpt-5'] })

  const pending = store.loadTrend()
  assert.deepEqual(trendRequests[0].query, {
    granularity: 'day',
    start: 10,
    endExclusive: 20,
    timeZone: 'UTC',
    projectPaths: [],
    adapterIds: [],
    models: ['gpt-5']
  })
  trendRequests[0].resolve({ buckets: [] })
  await pending
})

test('stats store exposes only safe typed trend errors', async () => {
  const store = createStore()
  const pending = store.loadTrend()
  trendRequests[0].reject(Object.assign(new Error('limited to 400 buckets'), {
    code: 'TOO_MANY_BUCKETS',
    suggestedGranularity: 'week',
    sql: 'SELECT private',
    stack: 'private stack'
  }))

  await pending
  assert.equal(store.trendLoading, false)
  assert.deepEqual(store.trendError, {
    code: 'TOO_MANY_BUCKETS',
    message: 'limited to 400 buckets',
    suggestedGranularity: 'week'
  })
})

test('stats store ignores stale success and failure responses', async () => {
  const store = createStore()
  const first = store.loadTrend()
  store.setGranularity('month')
  const second = store.loadTrend()

  trendRequests[1].resolve({ granularity: 'month', buckets: [{ label: '2026-08' }] })
  await second
  trendRequests[0].reject(new Error('stale failure'))
  await first

  assert.deepEqual(store.trend, {
    granularity: 'month', buckets: [{ label: '2026-08' }]
  })
  assert.equal(store.trendError, null)
  assert.equal(store.trendLoading, false)
})

test('changing granularity invalidates an in-flight success before another load starts', async () => {
  const store = createStore()
  store.trend = { granularity: 'day', buckets: [{ label: 'old' }] }
  store.trendError = { code: 'OLD_ERROR', message: 'old' }
  const stale = store.loadTrend()

  store.setGranularity('week')
  assert.equal(store.granularity, 'week')
  assert.equal(store.trend, null)
  assert.equal(store.trendError, null)
  assert.equal(store.trendLoading, false)

  trendRequests[0].resolve({ granularity: 'day', buckets: [{ label: 'stale' }] })
  await stale
  assert.equal(store.trend, null)
  assert.equal(store.trendError, null)
  assert.equal(store.trendLoading, false)

  const current = store.loadTrend()
  trendRequests[1].resolve({ granularity: 'week', buckets: [{ label: 'current' }] })
  await current
  assert.deepEqual(store.trend, {
    granularity: 'week', buckets: [{ label: 'current' }]
  })
})

test('changing filters invalidates an in-flight failure before another load starts', async () => {
  const store = createStore()
  const stale = store.loadTrend()

  store.setFilters({ projectPaths: ['/work/new'], adapterIds: ['codex'], models: [] })
  assert.deepEqual(store.filters, {
    projectPaths: ['/work/new'], adapterIds: ['codex'], models: []
  })
  assert.equal(store.trend, null)
  assert.equal(store.trendError, null)
  assert.equal(store.trendLoading, false)

  trendRequests[0].reject(Object.assign(new Error('stale failure'), {
    code: 'TOO_MANY_BUCKETS', suggestedGranularity: 'week'
  }))
  await stale
  assert.equal(store.trend, null)
  assert.equal(store.trendError, null)
  assert.equal(store.trendLoading, false)

  const current = store.loadTrend()
  assert.deepEqual(trendRequests[1].query.projectPaths, ['/work/new'])
  trendRequests[1].resolve({ granularity: 'day', buckets: [{ label: 'current' }] })
  await current
  assert.deepEqual(store.trend, {
    granularity: 'day', buckets: [{ label: 'current' }]
  })
})
