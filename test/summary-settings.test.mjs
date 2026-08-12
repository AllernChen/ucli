import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseSfc } from '@vue/compiler-sfc'

import {
  DEFAULT_SUMMARY_SETTINGS,
  createLiveSummaryPipeline,
  updateSummarySettings
} from '../electron/summaries/summaryScheduler.js'

const available = id => ({ id, installed: true, summaryExecutorAvailable: true })
const unsafe = id => ({ id, installed: true, summaryExecutorAvailable: false })

test('summary settings expose the exact opt-in defaults', () => {
  assert.deepEqual(DEFAULT_SUMMARY_SETTINGS, {
    autoEnabled: false,
    autoPeriods: { day: true, week: true, month: false, quarter: false, year: false },
    defaultExecutorId: null,
    defaultProfileId: null,
    defaultModel: null,
    firstEnableDisclosureAcceptedAt: null,
    automaticCallLimit: 20
  })
})

test('automatic enablement requires an installed default executor and accepted disclosure', () => {
  assert.throws(
    () => updateSummarySettings({}, { autoEnabled: true, defaultExecutorId: 'codex' }, {
      availableExecutors: [available('claude')]
    }),
    error => error.code === 'SUMMARY_DISCLOSURE_REQUIRED'
  )
  assert.throws(
    () => updateSummarySettings({}, {
      autoEnabled: true,
      defaultExecutorId: 'claude',
      firstEnableDisclosureAcceptedAt: 123
    }, { availableExecutors: [available('opencode')] }),
    error => error.code === 'SUMMARY_EXECUTOR_UNAVAILABLE'
  )

  const enabled = updateSummarySettings({}, {
    autoEnabled: true,
    defaultExecutorId: 'claude',
    firstEnableDisclosureAcceptedAt: 123,
    autoPeriods: { month: true }
  }, { availableExecutors: [available('claude')] })
  assert.equal(enabled.autoEnabled, true)
  assert.equal(enabled.autoPeriods.day, true)
  assert.equal(enabled.autoPeriods.month, true)
})

test('enabled automation keeps a valid executor and clears stale executor-specific defaults', () => {
  const current = {
    autoEnabled: true,
    defaultExecutorId: 'claude',
    defaultProfileId: 'claude-profile',
    defaultModel: 'claude-model',
    firstEnableDisclosureAcceptedAt: 123
  }
  assert.throws(
    () => updateSummarySettings(current, { defaultExecutorId: null }, {
      availableExecutors: [available('claude')]
    }),
    error => error.code === 'SUMMARY_EXECUTOR_UNAVAILABLE'
  )
  assert.throws(
    () => updateSummarySettings(current, { defaultExecutorId: 'ucode' }, {
      availableExecutors: [available('claude'), unsafe('ucode')]
    }),
    error => error.code === 'SUMMARY_EXECUTOR_UNSAFE'
  )

  const changed = updateSummarySettings(current, { defaultExecutorId: 'opencode' }, {
    availableExecutors: [available('claude'), available('opencode')]
  })
  assert.equal(changed.defaultProfileId, null)
  assert.equal(changed.defaultModel, null)
})

test('automatic enablement is rejected when durable scheduling is unavailable', () => {
  assert.throws(
    () => updateSummarySettings({}, {
      autoEnabled: true,
      defaultExecutorId: 'claude',
      firstEnableDisclosureAcceptedAt: 123
    }, {
      availableExecutors: [available('claude')],
      automationAvailable: false
    }),
    error => error.code === 'SUMMARY_AUTOMATION_UNAVAILABLE'
  )
})

test('live summary pipeline reads the current automatic call limit for every run', async () => {
  let automaticCallLimit = 20
  const observed = []
  const pipeline = createLiveSummaryPipeline({
    runner: {},
    getSettings: () => ({ automaticCallLimit }),
    createPipeline: options => ({
      async run() { observed.push(options.automaticCallLimit); return {} }
    })
  })

  await pipeline.run({})
  automaticCallLimit = 7
  await pipeline.run({})
  assert.deepEqual(observed, [20, 7])
})

test('renderer settings expose automatic cadence, default CLI/profile/model, and disclosure controls', () => {
  const store = readFileSync(new URL('../src/stores/settings.js', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  const parsed = parseSfc(view)

  assert.deepEqual(parsed.errors, [])
  for (const field of [
    'autoEnabled', 'autoPeriods', 'defaultExecutorId', 'defaultProfileId',
    'defaultModel', 'firstEnableDisclosureAcceptedAt', 'automaticCallLimit'
  ]) {
    assert.match(store, new RegExp(field))
    assert.match(view, new RegExp(field))
  }
  for (const period of ['day', 'week', 'month', 'quarter', 'year']) {
    assert.match(view, new RegExp(`value="${period}"`))
  }
  assert.match(view, /onSummaryAutoChange/)
  assert.match(view, /tool\.installed\s*&&\s*tool\.summaryExecutorAvailable/)
  const dialog = readFileSync(new URL('../src/components/summaries/SummaryGenerateDialog.vue', import.meta.url), 'utf8')
  assert.match(dialog, /tool\.installed\s*&&\s*tool\.summaryExecutorAvailable/)
  assert.match(view, /会话材料/)
  assert.match(view, /配置的 CLI\/Provider/)
  assert.match(view, /可能产生费用/)
  assert.match(view, /手动生成时仍可逐次选择/)
})

test('orchestrator merges summary settings compatibly and owns scheduler startup and shutdown', () => {
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /createSummaryScheduler/)
  assert.match(source, /getSummarySettings\(\)/)
  assert.match(source, /setSummarySettings\(/)
  assert.match(source, /summaryScheduler\.start\(\)/)
  assert.match(source, /summaryScheduler\?\.stop\(\)/)
  assert.match(source, /summaryJobService\.subscribe\(\(report, pipelineProgress\) => \{[\s\S]*?scheduleFlush\(\)[\s\S]*?summary:progress/)
  assert.match(source, /updateSummarySettings/)
})
