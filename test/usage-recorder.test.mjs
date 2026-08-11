import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../electron/persistence/db.js'
import {
  createUsageRecorder,
  normalizeAdapterStatsEvent,
  normalizeUsageUpdate
} from '../electron/usage/usageRecorder.js'
import { createUsageQueryService } from '../electron/usage/usageQueryService.js'

function realAdapterUpdate(overrides = {}) {
  return {
    sessionId: 'session-1',
    projectPath: 'F:/projects/ucli',
    adapterId: 'claude',
    usage: { inputTokens: 120, outputTokens: 30 },
    costUsd: 0.42,
    turns: 4,
    model: 'claude-sonnet',
    modelBreakdown: [
      { model: 'claude-sonnet', inputTokens: 100, outputTokens: 20, costUsd: 0.32 },
      { model: 'claude-haiku', inputTokens: 20, outputTokens: 10, costUsd: 0.1 }
    ],
    ...overrides
  }
}

async function withDb(prefix, work) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const db = await openDb(join(dir, 'ucli.db'))
  try {
    return await work(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('normalizes real adapter fields into one session total and model-only details', () => {
  const normalized = normalizeUsageUpdate(realAdapterUpdate(), 5000)

  assert.deepEqual(normalized, {
    observedAt: 5000,
    session: {
      sessionId: 'session-1', scope: 'session', projectPath: 'F:/projects/ucli',
      adapterId: 'claude', model: null, observedAt: 5000,
      inputTokens: 120, outputTokens: 30, costUsd: 0.42,
      costAvailable: true, turns: 4
    },
    models: [
      {
        sessionId: 'session-1', scope: 'model', projectPath: 'F:/projects/ucli',
        adapterId: 'claude', model: 'claude-sonnet', observedAt: 5000,
        inputTokens: 100, outputTokens: 20, costUsd: 0.32,
        costAvailable: true, turns: 0
      },
      {
        sessionId: 'session-1', scope: 'model', projectPath: 'F:/projects/ucli',
        adapterId: 'claude', model: 'claude-haiku', observedAt: 5000,
        inputTokens: 20, outputTokens: 10, costUsd: 0.1,
        costAvailable: true, turns: 0
      }
    ]
  })
})

test('supports parser-style totals and uses unknown only for an unnamed breakdown row', () => {
  const normalized = normalizeUsageUpdate({
    sessionId: 's2', projectPath: '/work/a', adapterId: 'opencode',
    inputTokens: 80, outputTokens: 12, turnsCount: 2,
    costUsd: null, costAvailable: false, lastModel: 'named-session-model',
    models: [{ model: '  ', inputTokens: 80, outputTokens: 12, costAvailable: false }]
  }, 6000)

  assert.equal(normalized.session.model, null)
  assert.equal(normalized.session.turns, 2)
  assert.equal(normalized.session.costAvailable, false)
  assert.equal(normalized.session.costUsd, null)
  assert.equal(normalized.models[0].model, 'unknown')
  assert.equal(normalized.models[0].turns, 0)

  const withoutBreakdown = normalizeUsageUpdate({
    sessionId: 's3', adapterId: 'codex', inputTokens: 10, outputTokens: 2,
    costUsd: 0, costAvailable: true, turnsCount: 1, lastModel: 'gpt-5.5'
  }, 7000)
  assert.deepEqual(withoutBreakdown.models, [{
    sessionId: 's3', scope: 'model', projectPath: null,
    adapterId: 'codex', model: 'gpt-5.5', observedAt: 7000,
    inputTokens: 10, outputTokens: 2, costUsd: 0,
    costAvailable: true, turns: 0
  }])

  const withoutModelIdentity = normalizeUsageUpdate({
    sessionId: 's4', adapterId: 'codex', inputTokens: 10, outputTokens: 2
  }, 7100)
  assert.deepEqual(withoutModelIdentity.models, [])
})

test('explicit unavailable cost wins over a numeric provider placeholder', () => {
  const normalized = normalizeUsageUpdate(realAdapterUpdate({
    costUsd: 0,
    costAvailable: false,
    modelBreakdown: [{ model: 'gpt-5', inputTokens: 9, outputTokens: 1, costUsd: 0, costAvailable: false }]
  }), 8000)

  assert.equal(normalized.session.costAvailable, false)
  assert.equal(normalized.session.costUsd, null)
  assert.equal(normalized.models[0].costAvailable, false)
  assert.equal(normalized.models[0].costUsd, null)
})

test('Codex token events remain unknown-cost through the recorder and trend query', async () => {
  await withDb('ucli-codex-unknown-cost-', async (db) => {
    const exactSince = db.getUsageLedgerMetadata().exactSince
    const observedAt = exactSince + 60_000
    const event = normalizeAdapterStatsEvent({
      type: 'stats_update',
      usage: { inputTokens: 40, outputTokens: 8 },
      costUsd: null,
      costAvailable: false,
      turns: 1,
      model: 'gpt-5.5'
    })
    assert.equal(event.costAvailable, false)
    assert.equal(event.costUsd, null)

    const recorder = createUsageRecorder({ db, now: () => observedAt })
    await recorder.observe({
      ...event,
      sessionId: 'codex-session',
      projectPath: 'F:/projects/ucli',
      adapterId: 'codex'
    })
    const result = createUsageQueryService({ db }).queryUsage({
      granularity: 'hour',
      start: exactSince,
      endExclusive: observedAt + 60_000,
      timeZone: 'UTC',
      adapterIds: ['codex']
    })

    assert.equal(result.totals.inputTokens, 40)
    assert.equal(result.totals.outputTokens, 8)
    assert.equal(result.totals.knownCostUsd, 0)
    assert.equal(result.totals.costCoverage, 0)
  })
})

test('synthetic adapter startup zeroes never reset persisted usage checkpoints', async () => {
  await withDb('ucli-synthetic-startup-', async (db) => {
    const exactSince = db.getUsageLedgerMetadata().exactSince
    let tick = 0
    const recorder = createUsageRecorder({ db, now: () => exactSince + (++tick * 1000) })

    for (const adapterId of ['claude', 'codex', 'opencode']) {
      const sessionId = `${adapterId}-session`
      const update = (inputTokens, outputTokens, synthetic = false) => ({
        sessionId,
        projectPath: 'F:/projects/ucli',
        adapterId,
        usage: { inputTokens, outputTokens },
        costUsd: null,
        costAvailable: false,
        turns: 0,
        synthetic
      })
      await recorder.observe(update(100, 20))
      const skipped = await recorder.observe(update(0, 0, true))
      assert.equal(skipped.skipped, true)
      await recorder.observe(update(100, 20))
      await recorder.observe(update(110, 25))

      const result = createUsageQueryService({ db }).queryUsage({
        granularity: 'hour',
        start: exactSince,
        endExclusive: exactSince + 60_000,
        timeZone: 'UTC',
        adapterIds: [adapterId]
      })
      assert.equal(result.totals.inputTokens, 110, adapterId)
      assert.equal(result.totals.outputTokens, 25, adapterId)
    }
  })
})

test('records session and model scopes without assigning turns to model detail', async () => {
  const observations = []
  const recorder = createUsageRecorder({
    db: { observeUsage: async (snapshot) => { observations.push(snapshot); return snapshot } },
    now: () => 9000
  })

  const result = await recorder.observe(realAdapterUpdate())

  assert.deepEqual(observations.map(({ scope, model, turns }) => [scope, model, turns]), [
    ['session', null, 4],
    ['model', 'claude-sonnet', 0],
    ['model', 'claude-haiku', 0]
  ])
  assert.equal(result.observedAt, 9000)
  assert.equal(result.session.scope, 'session')
  assert.equal(result.models.length, 2)
})

test('database owns duplicate and counter-reset semantics', async () => {
  await withDb('ucli-usage-recorder-reset-', async (db) => {
    const exactSince = db.getUsageLedgerMetadata().exactSince
    let tick = 0
    const recorder = createUsageRecorder({ db, now: () => exactSince + (++tick) })
    const update = (inputTokens) => realAdapterUpdate({
      usage: { inputTokens, outputTokens: Math.floor(inputTokens / 5) },
      turns: Math.floor(inputTokens / 20),
      modelBreakdown: []
    })

    await recorder.observe(update(100))
    await recorder.observe(update(100))
    await recorder.observe(update(10))
    await recorder.observe(update(20))

    const events = db.queryUsageEvents({ scopes: ['session'] })
    assert.deepEqual(events.map(({ inputTokens, outputTokens, turns }) => (
      { inputTokens, outputTokens, turns }
    )), [
      { inputTokens: 100, outputTokens: 20, turns: 5 },
      { inputTokens: 10, outputTokens: 2, turns: 1 }
    ])
  })
})

test('serializes concurrent observations in invocation order', async () => {
  const started = []
  const releases = []
  const recorder = createUsageRecorder({
    db: {
      observeUsage(snapshot) {
        started.push(snapshot.inputTokens)
        return new Promise((resolve) => releases.push(resolve))
      }
    },
    now: (() => { let value = 1000; return () => ++value })()
  })

  const first = recorder.observe(realAdapterUpdate({
    usage: { inputTokens: 1, outputTokens: 0 }, model: null, modelBreakdown: []
  }))
  const second = recorder.observe(realAdapterUpdate({
    usage: { inputTokens: 2, outputTokens: 0 }, model: null, modelBreakdown: []
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [1])

  releases.shift()({ ok: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [1, 2])
  releases.shift()({ ok: 2 })
  await Promise.all([first, second])
})

test('records approvals only with a stable decision identity and replays safely', async () => {
  await withDb('ucli-usage-recorder-approval-', async (db) => {
    const recorder = createUsageRecorder({ db, now: () => 11000 })
    const approval = {
      requestId: 'permission-request-1', sessionId: 'session-1',
      projectPath: 'F:/projects/ucli', adapterId: 'claude', model: 'claude-sonnet'
    }

    await recorder.recordApproval(approval)
    await recorder.recordApproval(approval)
    assert.equal(db.queryUsageEvents({ scopes: ['approval'] }).length, 1)

    await assert.rejects(
      recorder.recordApproval({ ...approval, requestId: '' }),
      (error) => error?.code === 'INVALID_APPROVAL_ID'
    )
  })
})
