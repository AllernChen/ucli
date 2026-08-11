import assert from 'node:assert/strict'
import test from 'node:test'

import { createSummaryScheduler } from '../electron/summaries/summaryScheduler.js'

const NOW = Date.parse('2026-08-12T08:30:00.000Z')

function enabledSettings(overrides = {}) {
  return {
    autoEnabled: true,
    autoPeriods: { day: true, week: true, month: true, quarter: true, year: true },
    defaultExecutorId: 'codex',
    defaultProfileId: null,
    defaultModel: null,
    firstEnableDisclosureAcceptedAt: 1,
    automaticCallLimit: 20,
    ...overrides
  }
}

test('startup enqueues the latest missing completed period in cadence order', async () => {
  const enqueued = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings(),
    listReports: () => [],
    generate: (request) => { enqueued.push(request); return { reportId: `r${enqueued.length}` } },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()

  assert.deepEqual(enqueued.map(item => item.periodType), ['day', 'week', 'month', 'quarter', 'year'])
  assert.equal(enqueued.filter(item => item.periodType === 'day').length, 1)
  assert.ok(enqueued.every(item => item.generatedBy === 'automatic'))
  assert.ok(enqueued.every(item => item.executorId === 'codex'))
  scheduler.stop()
})

test('duplicate ticks are single-flight while a crossed boundary enqueues one new period', async () => {
  let current = NOW
  const enqueued = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: async () => [],
    generate: async request => { enqueued.push(request); return { reportId: `r${enqueued.length}` } },
    now: () => current,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await Promise.all([scheduler.start(), scheduler.tick(), scheduler.tick()])
  assert.equal(enqueued.length, 1)

  current = Date.parse('2026-08-13T00:01:00.000Z')
  await Promise.all([scheduler.tick(), scheduler.tick()])
  assert.equal(enqueued.length, 2)
  assert.equal(enqueued[1].start, Date.parse('2026-08-12T00:00:00.000Z'))
})

test('master and per-period switches suppress automatic work', async () => {
  let settings = enabledSettings({ autoEnabled: false })
  const enqueued = []
  const scheduler = createSummaryScheduler({
    getSettings: () => settings,
    listReports: () => [],
    generate: request => { enqueued.push(request); return {} },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.deepEqual(enqueued, [])

  settings = enabledSettings({
    autoPeriods: { day: false, week: true, month: false, quarter: false, year: false }
  })
  await scheduler.tick()
  assert.deepEqual(enqueued.map(item => item.periodType), ['week'])
})

test('completed, current, and skipped empty periods are not enqueued again', async () => {
  const enqueued = []
  const statusByPeriod = {
    day: [{ status: 'completed', isCurrent: false }],
    week: [{ status: 'skipped_empty', isCurrent: false }],
    month: [{ status: 'completed', isCurrent: true }],
    quarter: [{ status: 'failed', isCurrent: false }]
  }
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: true, month: true, quarter: true, year: false }
    }),
    listReports: filters => statusByPeriod[filters.periodType] || [],
    generate: request => { enqueued.push(request); return {} },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.deepEqual(enqueued.map(item => item.periodType), ['quarter'])
})

test('the in-app timer ticks every 15 minutes and stop clears it', async () => {
  let current = NOW
  let callback = null
  let delay = null
  let cleared = null
  const enqueued = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    generate: request => { enqueued.push(request); return {} },
    now: () => current,
    timeZone: 'UTC',
    setIntervalFn: (fn, ms) => { callback = fn; delay = ms; return 42 },
    clearIntervalFn: id => { cleared = id }
  })

  await scheduler.start()
  assert.equal(delay, 15 * 60 * 1000)
  current = Date.parse('2026-08-13T00:01:00.000Z')
  callback()
  await scheduler.tick()
  assert.equal(enqueued.length, 2)

  scheduler.stop()
  assert.equal(cleared, 42)
})

test('several missed periods enqueue only the latest completed day', async () => {
  const enqueued = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [
      {
        periodType: 'day',
        periodStart: Date.parse('2026-08-01T00:00:00.000Z'),
        periodEndExclusive: Date.parse('2026-08-02T00:00:00.000Z'),
        status: 'completed'
      }
    ],
    generate: request => { enqueued.push(request); return {} },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].start, Date.parse('2026-08-11T00:00:00.000Z'))
})

test('a failed automatic job is not retried every tick but can retry after restart', async () => {
  const enqueued = []
  let resolveFirst
  const firstCompletion = new Promise(resolve => { resolveFirst = resolve })
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    generate: request => {
      enqueued.push(request)
      return enqueued.length === 1 ? { completion: firstCompletion } : {}
    },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  resolveFirst({ status: 'failed' })
  await firstCompletion
  await scheduler.tick()

  assert.equal(enqueued.length, 1)

  const restarted = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [{ status: 'failed', isCurrent: false }],
    generate: request => { enqueued.push(request); return {} },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })
  await restarted.start()

  assert.equal(enqueued.length, 2)
})

test('stop cancels and waits for automatic jobs before shutdown can flush', async () => {
  let resolveCompletion
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  const cancelled = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    generate: () => ({ reportId: 'report-1', completion }),
    cancel: reportId => { cancelled.push(reportId) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })
  await scheduler.start()

  let stopped = false
  const stopping = scheduler.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.deepEqual(cancelled, ['report-1'])
  assert.equal(stopped, false)

  resolveCompletion({ status: 'cancelled' })
  await stopping
  assert.equal(stopped, true)
})
