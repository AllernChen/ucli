import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SUMMARY_PERIOD_TYPES,
  USAGE_GRANULARITIES,
  assertUsageQuery
} from '../electron/usage/contracts.js'
import {
  bucketStart,
  completedPeriod,
  enumerateBuckets,
  manualPeriod,
  nextBucketStart
} from '../electron/usage/periods.js'

const iso = value => new Date(value).toISOString()

test('usage queries validate ranges and de-duplicate filters', () => {
  assert.deepEqual([...USAGE_GRANULARITIES], ['hour', 'day', 'week', 'month'])
  assert.deepEqual([...SUMMARY_PERIOD_TYPES], ['day', 'week', 'month', 'quarter', 'year'])

  assert.deepEqual(assertUsageQuery({
    granularity: 'day',
    start: 1000,
    endExclusive: 2000,
    projectPaths: ['/work/a', '/work/a', '/work/b'],
    adapterIds: ['codex', 'codex'],
    models: ['gpt-5', 'gpt-5']
  }), {
    granularity: 'day',
    start: 1000,
    endExclusive: 2000,
    projectPaths: ['/work/a', '/work/b'],
    adapterIds: ['codex'],
    models: ['gpt-5']
  })

  assert.throws(
    () => assertUsageQuery({ granularity: 'quarter', start: 1000, endExclusive: 2000 }),
    /Unsupported granularity/
  )
  assert.throws(
    () => assertUsageQuery({ granularity: 'day', start: 2000, endExclusive: 2000 }),
    /Invalid time range/
  )
})

test('weekly buckets start on local Monday', () => {
  const value = new Date('2026-08-12T12:00:00+08:00').getTime()
  assert.equal(
    iso(bucketStart(value, 'week', { timeZone: 'Asia/Shanghai' })),
    '2026-08-09T16:00:00.000Z'
  )
})

test('completed daily period excludes the current day', () => {
  const now = new Date('2026-08-12T10:30:00+08:00').getTime()
  const period = completedPeriod('day', now, { timeZone: 'Asia/Shanghai' })

  assert.deepEqual({
    ...period,
    start: iso(period.start),
    endExclusive: iso(period.endExclusive)
  }, {
    periodType: 'day',
    start: '2026-08-10T16:00:00.000Z',
    endExclusive: '2026-08-11T16:00:00.000Z',
    partial: false,
    timeZone: 'Asia/Shanghai'
  })
})

test('enumeration returns natural bucket intervals and rejects more than 400 buckets', () => {
  const buckets = enumerateBuckets({
    granularity: 'hour',
    start: new Date('2026-08-12T10:15:00+08:00').getTime(),
    endExclusive: new Date('2026-08-12T12:00:00+08:00').getTime(),
    timeZone: 'Asia/Shanghai'
  })

  assert.deepEqual(buckets.map(item => ({
    start: iso(item.start),
    endExclusive: iso(item.endExclusive)
  })), [
    { start: '2026-08-12T02:00:00.000Z', endExclusive: '2026-08-12T03:00:00.000Z' },
    { start: '2026-08-12T03:00:00.000Z', endExclusive: '2026-08-12T04:00:00.000Z' }
  ])

  assert.throws(
    () => enumerateBuckets({
      granularity: 'hour',
      start: 0,
      endExclusive: 401 * 3600000,
      timeZone: 'UTC'
    }),
    /400/
  )
})

test('month boundaries follow the calendar across short and leap-year Februaries', () => {
  const shanghai = { timeZone: 'Asia/Shanghai' }

  assert.equal(
    iso(nextBucketStart(new Date('2025-01-31T12:00:00+08:00').getTime(), 'month', shanghai)),
    '2025-01-31T16:00:00.000Z'
  )

  const leapFebruary = completedPeriod(
    'month',
    new Date('2024-03-15T12:00:00+08:00').getTime(),
    shanghai
  )
  assert.equal(iso(leapFebruary.start), '2024-01-31T16:00:00.000Z')
  assert.equal(iso(leapFebruary.endExclusive), '2024-02-29T16:00:00.000Z')

  const commonFebruary = completedPeriod(
    'month',
    new Date('2025-03-15T12:00:00+08:00').getTime(),
    shanghai
  )
  assert.equal(iso(commonFebruary.start), '2025-01-31T16:00:00.000Z')
  assert.equal(iso(commonFebruary.endExclusive), '2025-02-28T16:00:00.000Z')
})

test('completed quarter and year periods use calendar boundaries', () => {
  const shanghai = { timeZone: 'Asia/Shanghai' }
  const now = new Date('2026-08-12T12:00:00+08:00').getTime()

  const quarter = completedPeriod('quarter', now, shanghai)
  assert.equal(iso(quarter.start), '2026-03-31T16:00:00.000Z')
  assert.equal(iso(quarter.endExclusive), '2026-06-30T16:00:00.000Z')

  const year = completedPeriod('year', now, shanghai)
  assert.equal(iso(year.start), '2024-12-31T16:00:00.000Z')
  assert.equal(iso(year.endExclusive), '2025-12-31T16:00:00.000Z')
})

test('bucket starts support non-hour-aligned timezone offsets', () => {
  const kathmandu = { timeZone: 'Asia/Kathmandu' }
  const value = new Date('2026-08-12T10:37:45+05:45').getTime()

  assert.equal(iso(bucketStart(value, 'hour', kathmandu)), '2026-08-12T04:15:00.000Z')
  assert.equal(iso(bucketStart(value, 'day', kathmandu)), '2026-08-11T18:15:00.000Z')
})

test('daily enumeration follows DST days instead of assuming 24 hours', () => {
  const buckets = enumerateBuckets({
    granularity: 'day',
    start: new Date('2026-03-07T00:00:00-05:00').getTime(),
    endExclusive: new Date('2026-03-10T00:00:00-04:00').getTime(),
    timeZone: 'America/New_York'
  })

  assert.deepEqual(
    buckets.map(item => (item.endExclusive - item.start) / 3600000),
    [24, 23, 24]
  )
})

test('hour buckets distinguish both repeated hours during DST fallback', () => {
  const options = { timeZone: 'America/New_York' }
  const daylightOccurrence = new Date('2026-11-01T05:30:00Z').getTime()
  const standardOccurrence = new Date('2026-11-01T06:30:00Z').getTime()

  assert.equal(iso(bucketStart(daylightOccurrence, 'hour', options)), '2026-11-01T05:00:00.000Z')
  assert.equal(iso(bucketStart(standardOccurrence, 'hour', options)), '2026-11-01T06:00:00.000Z')

  const buckets = enumerateBuckets({
    granularity: 'day',
    start: new Date('2026-10-31T00:00:00-04:00').getTime(),
    endExclusive: new Date('2026-11-03T00:00:00-05:00').getTime(),
    timeZone: 'America/New_York'
  })
  assert.deepEqual(
    buckets.map(item => (item.endExclusive - item.start) / 3600000),
    [24, 25, 24]
  )
})

test('manual periods mark only the current selected period as partial', () => {
  const options = {
    timeZone: 'Asia/Shanghai',
    now: new Date('2026-08-12T10:30:00+08:00').getTime()
  }

  const current = manualPeriod(
    'day',
    new Date('2026-08-12T08:00:00+08:00').getTime(),
    options
  )
  assert.equal(iso(current.start), '2026-08-11T16:00:00.000Z')
  assert.equal(iso(current.endExclusive), '2026-08-12T02:30:00.000Z')
  assert.equal(current.partial, true)

  const past = manualPeriod(
    'day',
    new Date('2026-08-11T08:00:00+08:00').getTime(),
    options
  )
  assert.equal(iso(past.start), '2026-08-10T16:00:00.000Z')
  assert.equal(iso(past.endExclusive), '2026-08-11T16:00:00.000Z')
  assert.equal(past.partial, false)

  assert.throws(
    () => manualPeriod(
      'day',
      new Date('2026-08-13T08:00:00+08:00').getTime(),
      options
    ),
    /future/
  )
})
