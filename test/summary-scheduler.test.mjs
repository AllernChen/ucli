import assert from 'node:assert/strict'
import test from 'node:test'

import { createSummaryScheduler } from '../electron/summaries/summaryScheduler.js'

const NOW = Date.parse('2026-08-12T08:30:00.000Z')

function enabledSettings(overrides = {}) {
  return {
    autoEnabled: true,
    autoPeriods: { day: true, week: true, month: true, quarter: true, year: true },
    defaultExecutorId: 'claude',
    defaultProfileId: null,
    defaultModel: null,
    firstEnableDisclosureAcceptedAt: 1,
    automaticCallLimit: 20,
    ...overrides
  }
}

test('startup reminds the latest missing completed period in cadence order', async () => {
  const reminded = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings(),
    listReports: () => [],
    onReminder: (reminder) => { reminded.push(reminder) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()

  assert.deepEqual(reminded.map(item => item.periodType), ['day', 'week', 'month', 'quarter', 'year'])
  assert.equal(reminded.filter(item => item.periodType === 'day').length, 1)
  assert.ok(reminded.every(item =>
    item.timezone === 'UTC' &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.endExclusive) &&
    item.endExclusive > item.start
  ))
  assert.equal(reminded.find(item => item.periodType === 'day').start, Date.parse('2026-08-11T00:00:00.000Z'))
  scheduler.stop()
})

test('duplicate ticks are single-flight while a crossed boundary reminds one new period', async () => {
  let current = NOW
  const reminded = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: async () => [],
    onReminder: async reminder => { reminded.push(reminder) },
    now: () => current,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await Promise.all([scheduler.start(), scheduler.tick(), scheduler.tick()])
  assert.equal(reminded.length, 1)

  current = Date.parse('2026-08-13T00:01:00.000Z')
  await Promise.all([scheduler.tick(), scheduler.tick()])
  assert.equal(reminded.length, 2)
  assert.equal(reminded[1].start, Date.parse('2026-08-12T00:00:00.000Z'))
})

test('master and per-period switches suppress reminders', async () => {
  let settings = enabledSettings({ autoEnabled: false })
  const reminded = []
  const scheduler = createSummaryScheduler({
    getSettings: () => settings,
    listReports: () => [],
    onReminder: reminder => { reminded.push(reminder) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.deepEqual(reminded, [])

  settings = enabledSettings({
    autoPeriods: { day: false, week: true, month: false, quarter: false, year: false }
  })
  await scheduler.tick()
  assert.deepEqual(reminded.map(item => item.periodType), ['week'])
})

test('persisted unsafe executors no longer suppress reminders', async () => {
  const reminded = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({ defaultExecutorId: 'codex' }),
    listReports: () => [],
    onReminder: reminder => { reminded.push(reminder) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.equal(reminded.length, 5)
})

test('completed, current, and skipped empty periods are not reminded again', async () => {
  const reminded = []
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
    onReminder: reminder => { reminded.push(reminder) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.deepEqual(reminded.map(item => item.periodType), ['quarter'])
})

test('the in-app timer ticks every 15 minutes and stop clears it', async () => {
  let current = NOW
  let callback = null
  let delay = null
  let cleared = null
  const reminded = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    onReminder: reminder => { reminded.push(reminder) },
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
  assert.equal(reminded.length, 2)

  scheduler.stop()
  assert.equal(cleared, 42)
})

test('several missed periods remind only the latest completed day', async () => {
  const reminded = []
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
    onReminder: reminder => { reminded.push(reminder) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  assert.equal(reminded.length, 1)
  assert.equal(reminded[0].start, Date.parse('2026-08-11T00:00:00.000Z'))
})

test('a failed reminder delivery is not retried every tick but refires after restart', async () => {
  const attempts = []
  let failed = true
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    onReminder: () => {
      attempts.push(1)
      if (failed) throw new Error('notification delivery failed')
    },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })

  await scheduler.start()
  await scheduler.tick()
  assert.equal(attempts.length, 1)

  // A fresh scheduler forgets the in-memory dedup and reminds again.
  const restarted = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    onReminder: () => { attempts.push(1) },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })
  await restarted.start()

  assert.equal(attempts.length, 2)
})

test('stop clears the timer and awaits the in-flight tick', async () => {
  let cleared = null
  let releaseReminder
  let signalReminderStarted
  const reminderStarted = new Promise(resolve => { signalReminderStarted = resolve })
  const reminderGate = new Promise(resolve => { releaseReminder = resolve })
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    onReminder: () => { signalReminderStarted(); return reminderGate },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 42,
    clearIntervalFn: id => { cleared = id }
  })

  const starting = scheduler.start()
  await reminderStarted

  let stopped = false
  const stopping = scheduler.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)

  releaseReminder()
  await stopping
  await starting
  assert.equal(stopped, true)
  assert.equal(cleared, 42)
})

test('daily maintenance removes expired workspaces before cache LRU and does not hang timers', async () => {
  const events = []
  let interval
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({ autoEnabled: false }),
    listReports: () => [],
    onReminder: () => ({}),
    maintain: async () => {
      events.push('workspace-expired')
      events.push('cache-lru')
      return { failedWorkspacesRemoved: 2, cacheEntriesRemoved: 3, cacheBytes: 64 }
    },
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: (callback, delay) => { interval = { callback, delay }; return 42 },
    clearIntervalFn: () => {}
  })
  await scheduler.start()
  assert.equal(interval.delay, 15 * 60 * 1000)
  assert.deepEqual(events, ['workspace-expired', 'cache-lru'])
  await scheduler.tick()
  assert.deepEqual(events, ['workspace-expired', 'cache-lru'])
  await scheduler.stop()
})

test('maintenance runs before reminders and failures do not block catch-up', async () => {
  const events = []
  const failures = []
  const scheduler = createSummaryScheduler({
    getSettings: () => enabledSettings({
      autoPeriods: { day: true, week: false, month: false, quarter: false, year: false }
    }),
    listReports: () => [],
    onReminder: () => { events.push('remind') },
    maintain: async () => {
      events.push('maintain')
      throw Object.assign(new Error('prompt C:\\private'), { code: 'SUMMARY_CACHE_PRUNE_FAILED' })
    },
    onMaintenanceError: event => failures.push(event),
    now: () => NOW,
    timeZone: 'UTC',
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  })
  await scheduler.start()
  assert.deepEqual(events, ['maintain', 'remind'])
  assert.deepEqual(failures, [{ phase: 'daily-maintenance', code: 'SUMMARY_CACHE_PRUNE_FAILED' }])
  assert.doesNotMatch(JSON.stringify(failures), /prompt|private/i)
})
