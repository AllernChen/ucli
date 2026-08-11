import assert from 'node:assert/strict'
import test from 'node:test'

import { createUsageQueryService } from '../electron/usage/usageQueryService.js'

const ts = value => new Date(value).getTime()

function event(overrides = {}) {
  return {
    id: overrides.id || `${overrides.scope || 'session'}-${overrides.sessionId || 's1'}-${overrides.observedAt}`,
    sessionId: 's1',
    scope: 'session',
    projectPath: '/work/a',
    adapterId: 'claude',
    model: null,
    observedAt: ts('2026-08-11T23:59:00+08:00'),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    costAvailable: false,
    turns: 0,
    approvals: 0,
    ...overrides
  }
}

function fakeDb(events, overrides = {}) {
  return {
    queryUsageEvents() { return events },
    getLegacyUsageBaseline(_filters) {
      return { inputTokens: 900, outputTokens: 100, costUsd: 2, costAvailable: false, turns: 9 }
    },
    getUsageLedgerMetadata() {
      return { ledgerStartedAt: 10, exactSince: 20 }
    },
    ...overrides
  }
}

function filteringDb(events) {
  return fakeDb(events, {
    queryUsageEvents(filters) {
      const scopes = filters.models.length ? ['model', 'approval'] : ['session', 'approval']
      return events.filter(item =>
        item.observedAt >= filters.start &&
        item.observedAt < filters.endExclusive &&
        scopes.includes(item.scope) &&
        (!filters.projectPaths.length || filters.projectPaths.includes(item.projectPath)) &&
        (!filters.adapterIds.length || filters.adapterIds.includes(item.adapterId)) &&
        (!filters.models.length || filters.models.includes(item.model))
      )
    }
  })
}

test('pre-creates daily calendar buckets and aggregates usage without counting approval or zero-token events in cost coverage', () => {
  const events = [
    event({ id: 'known-before-midnight', sessionId: 's1', observedAt: ts('2026-08-11T23:59:00+08:00'), inputTokens: 100, outputTokens: 20, costUsd: 0.5, costAvailable: true, turns: 2 }),
    event({ id: 'unknown-after-midnight', sessionId: 's1', observedAt: ts('2026-08-12T00:01:00+08:00'), inputTokens: 10, outputTokens: 5, turns: 1 }),
    event({ id: 'known-after-midnight', sessionId: 's2', observedAt: ts('2026-08-12T12:00:00+08:00'), inputTokens: 20, costUsd: 0.2, costAvailable: true }),
    event({ id: 'turn-only', sessionId: 's3', observedAt: ts('2026-08-12T12:01:00+08:00'), turns: 1, costUsd: 0, costAvailable: true }),
    event({ id: 'approval', scope: 'approval', sessionId: 's2', model: 'sonnet', observedAt: ts('2026-08-12T12:02:00+08:00'), approvals: 1 })
  ]
  const service = createUsageQueryService({ db: fakeDb(events) })

  const result = service.queryUsage({
    granularity: 'day',
    start: ts('2026-08-11T00:00:00+08:00'),
    endExclusive: ts('2026-08-14T00:00:00+08:00'),
    timeZone: 'Asia/Shanghai'
  })

  assert.equal(result.granularity, 'day')
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.equal(result.exactSince, 20)
  assert.deepEqual(result.range, {
    start: ts('2026-08-11T00:00:00+08:00'),
    endExclusive: ts('2026-08-14T00:00:00+08:00')
  })
  assert.deepEqual(result.legacyBaseline, {
    available: true,
    metrics: { inputTokens: 900, outputTokens: 100, costUsd: 2, costAvailable: false, turns: 9 }
  })
  assert.deepEqual(result.buckets, [
    {
      start: ts('2026-08-11T00:00:00+08:00'), endExclusive: ts('2026-08-12T00:00:00+08:00'), label: '2026-08-11',
      coveredStart: ts('2026-08-11T00:00:00+08:00'), coveredEndExclusive: ts('2026-08-12T00:00:00+08:00'), partial: false,
      inputTokens: 100, outputTokens: 20, totalTokens: 120, knownCostUsd: 0.5,
      costCoverage: 1, turns: 2, activeSessions: 1, approvals: 0
    },
    {
      start: ts('2026-08-12T00:00:00+08:00'), endExclusive: ts('2026-08-13T00:00:00+08:00'), label: '2026-08-12',
      coveredStart: ts('2026-08-12T00:00:00+08:00'), coveredEndExclusive: ts('2026-08-13T00:00:00+08:00'), partial: false,
      inputTokens: 30, outputTokens: 5, totalTokens: 35, knownCostUsd: 0.2,
      costCoverage: 0.5, turns: 2, activeSessions: 3, approvals: 1
    },
    {
      start: ts('2026-08-13T00:00:00+08:00'), endExclusive: ts('2026-08-14T00:00:00+08:00'), label: '2026-08-13',
      coveredStart: ts('2026-08-13T00:00:00+08:00'), coveredEndExclusive: ts('2026-08-14T00:00:00+08:00'), partial: false,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, knownCostUsd: 0,
      costCoverage: null, turns: 0, activeSessions: 0, approvals: 0
    }
  ])
  assert.deepEqual(result.totals, {
    inputTokens: 130, outputTokens: 25, totalTokens: 155, knownCostUsd: 0.7,
    costCoverage: 2 / 3, turns: 4, activeSessions: 3, approvals: 1
  })
})

test('defaults to the current partial bucket plus the preceding calendar buckets', () => {
  const now = ts('2026-08-12T10:30:00+08:00')
  const seenQueries = []
  const db = fakeDb([], {
    queryUsageEvents(query) {
      seenQueries.push(query)
      return []
    }
  })
  const service = createUsageQueryService({
    db,
    now: () => now,
    defaultTimeZone: 'Asia/Shanghai'
  })
  const cases = [
    ['hour', 24, '2026-08-11T11:00:00+08:00', '2026-08-12T11:00:00+08:00'],
    ['day', 30, '2026-07-14T00:00:00+08:00', '2026-08-13T00:00:00+08:00'],
    ['week', 12, '2026-05-25T00:00:00+08:00', '2026-08-17T00:00:00+08:00'],
    ['month', 12, '2025-09-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00']
  ]

  for (const [granularity, count, firstStart, lastNaturalEnd] of cases) {
    const result = service.queryUsage({ granularity })
    assert.equal(result.timezone, 'Asia/Shanghai')
    assert.equal(result.buckets.length, count)
    assert.equal(result.buckets[0].start, ts(firstStart))
    assert.equal(result.buckets.at(-1).endExclusive, ts(lastNaturalEnd))
    assert.deepEqual(result.range, { start: ts(firstStart), endExclusive: now })
    assert.equal(result.buckets[0].partial, false)
    assert.equal(result.buckets.at(-1).coveredEndExclusive, now)
    assert.equal(result.buckets.at(-1).partial, true)
  }
  assert.deepEqual(seenQueries.map(query => query.endExclusive), [now, now, now, now])
})

test('preserves natural bucket boundaries while marking non-aligned query coverage as partial', () => {
  const service = createUsageQueryService({ db: fakeDb([]) })
  const start = ts('2026-08-11T10:15:00+08:00')
  const endExclusive = ts('2026-08-12T12:30:00+08:00')
  const result = service.queryUsage({
    granularity: 'day', start, endExclusive, timeZone: 'Asia/Shanghai'
  })

  assert.deepEqual(result.range, { start, endExclusive })
  assert.deepEqual(result.buckets.map(bucket => ({
    start: bucket.start,
    endExclusive: bucket.endExclusive,
    coveredStart: bucket.coveredStart,
    coveredEndExclusive: bucket.coveredEndExclusive,
    partial: bucket.partial
  })), [
    {
      start: ts('2026-08-11T00:00:00+08:00'),
      endExclusive: ts('2026-08-12T00:00:00+08:00'),
      coveredStart: start,
      coveredEndExclusive: ts('2026-08-12T00:00:00+08:00'),
      partial: true
    },
    {
      start: ts('2026-08-12T00:00:00+08:00'),
      endExclusive: ts('2026-08-13T00:00:00+08:00'),
      coveredStart: ts('2026-08-12T00:00:00+08:00'),
      coveredEndExclusive: endExclusive,
      partial: true
    }
  ])
})

test('filters the legacy baseline by project and CLI but declares model history unavailable', () => {
  const seenFilters = []
  const db = fakeDb([], {
    getLegacyUsageBaseline(filters) {
      seenFilters.push(filters)
      return { inputTokens: 12, outputTokens: 3, costUsd: 0.4, costAvailable: true, turns: 2 }
    }
  })
  const service = createUsageQueryService({ db })
  const base = {
    granularity: 'day', start: 1, endExclusive: 2, timeZone: 'UTC',
    projectPaths: ['/work/a'], adapterIds: ['claude']
  }

  const available = service.queryUsage(base).legacyBaseline
  assert.deepEqual(available, {
    available: true,
    metrics: { inputTokens: 12, outputTokens: 3, costUsd: 0.4, costAvailable: true, turns: 2 }
  })
  assert.deepEqual(seenFilters, [{ projectPaths: ['/work/a'], adapterIds: ['claude'] }])

  const unavailable = service.queryUsage({ ...base, models: ['sonnet'] }).legacyBaseline
  assert.deepEqual(unavailable, {
    available: false,
    reason: 'MODEL_BREAKDOWN_UNAVAILABLE_BEFORE_EXACT_SINCE',
    metrics: null
  })
  assert.equal(seenFilters.length, 1)
})

test('allows exactly 400 buckets and returns a typed coarser-granularity suggestion above the limit', () => {
  const service = createUsageQueryService({ db: fakeDb([]) })
  const hour = 60 * 60 * 1000

  assert.equal(service.queryUsage({
    granularity: 'hour', start: 0, endExclusive: 400 * hour, timeZone: 'UTC'
  }).buckets.length, 400)

  assert.throws(
    () => service.queryUsage({
      granularity: 'hour', start: 0, endExclusive: 401 * hour, timeZone: 'UTC'
    }),
    error => error.code === 'TOO_MANY_BUCKETS' && error.suggestedGranularity === 'day'
  )
})

test('relies on the ledger scope defaults so session totals and model details are never double counted', () => {
  const observedAt = ts('2026-08-12T09:00:00+08:00')
  const events = [
    event({ id: 'session-a', sessionId: 's1', observedAt, inputTokens: 10, outputTokens: 2, costUsd: 0.1, costAvailable: true, turns: 1 }),
    event({ id: 'model-a', scope: 'model', sessionId: 's1', model: 'sonnet', observedAt, inputTokens: 10, outputTokens: 2, costUsd: 0.1, costAvailable: true }),
    event({ id: 'approval-sonnet', scope: 'approval', sessionId: 's1', model: 'sonnet', observedAt, approvals: 1 }),
    event({ id: 'approval-opus', scope: 'approval', sessionId: 's1', model: 'opus', observedAt, approvals: 1 }),
    event({ id: 'other-project-session', sessionId: 's2', projectPath: '/work/b', observedAt, inputTokens: 50 }),
    event({ id: 'other-adapter-session', sessionId: 's3', adapterId: 'codex', observedAt, inputTokens: 60 }),
    event({ id: 'outside-range', sessionId: 's4', observedAt: ts('2026-08-13T00:00:00+08:00'), inputTokens: 70 })
  ]
  const service = createUsageQueryService({ db: filteringDb(events) })
  const base = {
    granularity: 'day',
    start: ts('2026-08-12T00:00:00+08:00'),
    endExclusive: ts('2026-08-13T00:00:00+08:00'),
    timeZone: 'Asia/Shanghai',
    projectPaths: ['/work/a'],
    adapterIds: ['claude']
  }

  const unfilteredModel = service.queryUsage(base)
  assert.deepEqual(unfilteredModel.totals, {
    inputTokens: 10, outputTokens: 2, totalTokens: 12, knownCostUsd: 0.1,
    costCoverage: 1, turns: 1, activeSessions: 1, approvals: 2
  })

  const sonnetOnly = service.queryUsage({ ...base, models: ['sonnet'] })
  assert.deepEqual(sonnetOnly.totals, {
    inputTokens: 10, outputTokens: 2, totalTokens: 12, knownCostUsd: 0.1,
    costCoverage: 1, turns: 0, activeSessions: 1, approvals: 1
  })
})

test('keeps both repeated local hours distinguishable across DST fallback', () => {
  const service = createUsageQueryService({ db: fakeDb([]) })
  const result = service.queryUsage({
    granularity: 'hour',
    start: ts('2026-11-01T05:00:00Z'),
    endExclusive: ts('2026-11-01T07:00:00Z'),
    timeZone: 'America/New_York'
  })

  assert.deepEqual(result.buckets.map(bucket => ({
    start: bucket.start,
    endExclusive: bucket.endExclusive,
    label: bucket.label
  })), [
    {
      start: ts('2026-11-01T05:00:00Z'), endExclusive: ts('2026-11-01T06:00:00Z'),
      label: '2026-11-01 01:00 GMT-04:00'
    },
    {
      start: ts('2026-11-01T06:00:00Z'), endExclusive: ts('2026-11-01T07:00:00Z'),
      label: '2026-11-01 01:00 GMT-05:00'
    }
  ])
})

test('uses Monday and calendar-month boundaries when pre-creating empty buckets', () => {
  const service = createUsageQueryService({ db: fakeDb([]) })
  const weekly = service.queryUsage({
    granularity: 'week',
    start: ts('2026-08-12T12:00:00+08:00'),
    endExclusive: ts('2026-08-25T00:00:00+08:00'),
    timeZone: 'Asia/Shanghai'
  })
  assert.deepEqual(weekly.buckets.map(bucket => bucket.label), ['2026-08-10', '2026-08-17', '2026-08-24'])

  const monthly = service.queryUsage({
    granularity: 'month',
    start: ts('2024-01-31T23:00:00+08:00'),
    endExclusive: ts('2024-03-01T00:00:00+08:00'),
    timeZone: 'Asia/Shanghai'
  })
  assert.deepEqual(monthly.buckets.map(bucket => [bucket.label, bucket.endExclusive]), [
    ['2024-01', ts('2024-02-01T00:00:00+08:00')],
    ['2024-02', ts('2024-03-01T00:00:00+08:00')]
  ])
})
