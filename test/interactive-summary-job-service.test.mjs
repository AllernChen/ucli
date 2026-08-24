import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { REQUIRED_HEADINGS } from '../electron/summaries/interactiveSummaryArtifact.js'
import { createInteractiveSummaryJobService } from '../electron/summaries/interactiveSummaryJobService.js'
import { createReportRepository } from '../electron/summaries/reportRepository.js'
import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'
import { createSummaryFakeAdapterHarness } from './fixtures/summaryFakeAdapter.js'

const START = Date.UTC(2026, 7, 10)
const WEEK = 7 * 24 * 60 * 60 * 1000
const VALID_MARKDOWN = `${REQUIRED_HEADINGS.map(heading => `${heading}\n\n内容`).join('\n\n')}\n`

function request(overrides = {}) {
  return {
    periodType: 'week', start: START, endExclusive: START + WEEK,
    timezone: 'Asia/Shanghai', partial: false,
    executorId: 'claude', profileId: 'p1', model: 'm1',
    ...overrides
  }
}

function timerTracker() {
  const active = new Set()
  return {
    setTimeout(callback, delay) {
      const handle = setTimeout(() => {
        active.delete(handle)
        callback()
      }, delay)
      active.add(handle)
      return handle
    },
    clearTimeout(handle) {
      active.delete(handle)
      clearTimeout(handle)
    },
    get activeCount() { return active.size }
  }
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

async function quickArtifact({ workspacePath, signal, deadlineMs }) {
  const target = join(workspacePath, 'output', 'report.md')
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) throw abortError()
    try {
      const markdown = await readFile(target, 'utf8')
      const buffer = Buffer.from(markdown)
      return {
        markdown,
        bytes: buffer.byteLength,
        sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw Object.assign(new Error('deadline'), { code: 'SUMMARY_ARTIFACT_INVALID' })
}

async function fixture(t, {
  realArtifact = false,
  timeouts = {}
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ucli-interactive-job-'))
  const db = await openDb(join(root, 'ucli.db'))
  const repository = createReportRepository({ db })
  const workspaceService = createSummaryWorkspaceService({ root: join(root, 'summaries') })
  const fake = createSummaryFakeAdapterHarness({ workspaceService })
  const timers = timerTracker()
  const service = createInteractiveSummaryJobService({
    repository,
    workspaceService,
    preparationService: {
      async prepare({ report, workspace }) {
        await workspaceService.writeArtifact(report.id, 'input/data.json', '{}\n')
        return { coverage: { sessionsIncluded: 1 }, usageSnapshot: {}, workspace }
      }
    },
    sessionRuntime: fake.runtime,
    waitForArtifact: realArtifact ? undefined : quickArtifact,
    timers,
    timeouts: {
      readyMs: 40,
      deliveryMs: 40,
      runMs: realArtifact ? 2_500 : 150,
      missingMs: 40,
      ...timeouts
    }
  })
  t.after(async () => {
    await service.interruptAll('SUMMARY_APP_SHUTDOWN')
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, db, repository, workspaceService, fake, timers, service }
}

async function beginRunning(state, run, turnId = 'turn-1') {
  state.fake.emitReady(run.sessionId)
  await state.fake.waitForSend(run.sessionId)
  state.fake.emitTurnStarted(run.sessionId, turnId)
  await new Promise(resolve => setImmediate(resolve))
}

async function manifest(state, reportId) {
  return JSON.parse(await readFile(
    join(state.root, 'summaries', 'workspaces', reportId, 'manifest.json'),
    'utf8'
  ))
}

async function assertSettled(state, run, { status, phase, code = null }) {
  const settled = await run.done
  const persisted = state.repository.get(run.report.id)
  const workspace = await manifest(state, run.report.id)
  assert.equal(settled.status, status)
  assert.equal(settled.runPhase, phase)
  assert.equal(persisted.status, status)
  assert.equal(persisted.runPhase, phase)
  assert.equal(persisted.errorText, code)
  assert.equal(workspace.status, status)
  assert.equal(workspace.stage, phase)
  assert.equal(workspace.errorCode ?? null, code)
  assert.equal(state.service.isActive(run.report.id), false)
  assert.equal(state.fake.listenerCount(run.sessionId), 0)
  assert.equal(state.fake.stopped.filter(sessionId => sessionId === run.sessionId).length, 1)
  assert.equal(state.timers.activeCount, 0)
  return settled
}

async function completeRun(state, run, markdown = VALID_MARKDOWN, turnId = 'turn-1') {
  await beginRunning(state, run, turnId)
  await state.fake.writeCanonicalMarkdown(run.report.id, markdown)
  return assertSettled(state, run, { status: 'completed', phase: 'completed' })
}

test('interactive run owns report workspace session artifact and atomic completion', async t => {
  const state = await fixture(t, { realArtifact: true })
  const progress = []
  const unsubscribe = state.service.subscribe(event => progress.push(event))
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
  const completed = await assertSettled(state, run, { status: 'completed', phase: 'completed' })
  unsubscribe()

  assert.equal(completed.executionMode, 'interactive-cli')
  assert.equal(completed.sessionId, run.sessionId)
  assert.equal(completed.version, 1)
  assert.equal(completed.isCurrent, true)
  assert.equal(completed.markdown, VALID_MARKDOWN)
  assert.deepEqual(progress.map(item => item.phase), [
    'starting', 'awaiting-delivery', 'running', 'validating', 'completed'
  ])
  assert.deepEqual(state.fake.config(run.sessionId), {
    adapterId: 'claude', profileId: 'p1', model: 'm1',
    name: '工作总结（每周）v1',
    cwd: join(state.root, 'summaries', 'workspaces', run.report.id, 'work')
  })
})

test('ready timeout settles failed and releases workspace session resources', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_READY_TIMEOUT'
  })
})

test('send false fails closed before a confirmed turn', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  state.fake.setSendAccepted(run.sessionId, false)
  state.fake.emitReady(run.sessionId)
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_TURN_NOT_CONFIRMED'
  })
})

test('delivery without turn_started times out after the bounded confirmation window', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  state.fake.emitReady(run.sessionId)
  await state.fake.waitForSend(run.sessionId)
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_TURN_NOT_CONFIRMED'
  })
})

test('turn_completed without a file uses the stable window then reports artifact missing', async t => {
  const state = await fixture(t, { timeouts: { runMs: 500, missingMs: 30 } })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  state.fake.emitTurnCompleted(run.sessionId)
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_ARTIFACT_MISSING'
  })
})

for (const [kind, emit] of [
  ['process exit', fake => fake.emitExit],
  ['process error', fake => fake.emitError]
]) {
  test(`${kind} settles the run as failed`, async t => {
    const state = await fixture(t)
    const run = await state.service.start(request())
    await beginRunning(state, run)
    emit(state.fake)(run.sessionId)
    await assertSettled(state, run, {
      status: 'failed', phase: 'failed', code: 'SUMMARY_RUN_FAILED'
    })
  })
}

for (const [kind, emit, status, phase] of [
  ['same-turn failure', (fake, sessionId) => fake.emitTurnFailed(sessionId), 'failed', 'failed'],
  ['same-turn interruption', (fake, sessionId) => fake.emitTurnInterrupted(sessionId), 'interrupted', 'interrupted'],
  ['session stopped', (fake, sessionId) => fake.emitSessionStopped(sessionId), 'interrupted', 'interrupted']
]) {
  test(`${kind} settles the matching active run`, async t => {
    const state = await fixture(t)
    const run = await state.service.start(request())
    await beginRunning(state, run)
    emit(state.fake, run.sessionId)
    await assertSettled(state, run, {
      status, phase, code: 'SUMMARY_RUN_FAILED'
    })
  })
}

test('terminal event for another turn cannot settle the current run', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await beginRunning(state, run, 'turn-current')
  state.fake.emitTurnFailed(run.sessionId, 'turn-other')
  await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
  await assertSettled(state, run, { status: 'completed', phase: 'completed' })
})

test('total run timeout bounds a running CLI that produces no artifact or terminal event', async t => {
  const state = await fixture(t, { timeouts: { runMs: 35 } })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_RUN_TIMEOUT'
  })
})

test('invalid canonical artifact fails without completing the report', async t => {
  const state = await fixture(t, { realArtifact: true })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await state.fake.writeCanonicalMarkdown(run.report.id, '# 错误报告\n')
  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_ARTIFACT_INVALID'
  })
})

test('cancel aborts validation stops the CLI and settles cancelled', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await beginRunning(state, run)
  assert.equal(await state.service.cancel(run.report.id), true)
  await assertSettled(state, run, {
    status: 'cancelled', phase: 'cancelled', code: 'SUMMARY_CANCELLED'
  })
})

test('app shutdown interrupts every active run with the exact safe code', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await beginRunning(state, run)
  assert.equal(await state.service.interruptAll('SUMMARY_APP_SHUTDOWN'), 1)
  await assertSettled(state, run, {
    status: 'interrupted', phase: 'interrupted', code: 'SUMMARY_APP_SHUTDOWN'
  })
})

test('renderer subscription can disappear while the main-process run still completes', async t => {
  const state = await fixture(t)
  const unsubscribe = state.service.subscribe(() => {})
  const run = await state.service.start(request())
  unsubscribe()
  await completeRun(state, run)
})

test('same-period reruns create immutable v1 and v2 with unique sessions', async t => {
  const state = await fixture(t)
  const first = await state.service.start(request())
  await completeRun(state, first, VALID_MARKDOWN.replaceAll('内容', 'v1'))
  const second = await state.service.start(request({ profileId: 'p2', model: 'm2' }))
  await completeRun(state, second, VALID_MARKDOWN.replaceAll('内容', 'v2'), 'turn-2')

  const storedFirst = state.repository.get(first.report.id)
  const storedSecond = state.repository.get(second.report.id)
  assert.deepEqual([storedFirst.version, storedSecond.version], [1, 2])
  assert.equal(storedFirst.markdown.includes('v1'), true)
  assert.equal(storedSecond.markdown.includes('v2'), true)
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(storedFirst.isCurrent, false)
  assert.equal(storedSecond.isCurrent, true)
})

test('day and week runs execute concurrently without sharing report workspace or session', async t => {
  const state = await fixture(t)
  const [week, day] = await Promise.all([
    state.service.start(request()),
    state.service.start(request({ periodType: 'day', endExclusive: START + 24 * 60 * 60 * 1000 }))
  ])
  assert.notEqual(week.report.id, day.report.id)
  assert.notEqual(week.sessionId, day.sessionId)
  assert.notEqual(state.fake.config(week.sessionId).cwd, state.fake.config(day.sessionId).cwd)
  await Promise.all([completeRun(state, week), completeRun(state, day, VALID_MARKDOWN, 'turn-2')])
})

test('different profile and model inputs are forwarded to distinct native sessions', async t => {
  const state = await fixture(t)
  const first = await state.service.start(request({ profileId: 'profile-a', model: 'model-a' }))
  const second = await state.service.start(request({ profileId: 'profile-b', model: 'model-b' }))
  assert.notEqual(first.sessionId, second.sessionId)
  assert.deepEqual(
    [state.fake.config(first.sessionId), state.fake.config(second.sessionId)].map(config =>
      [config.profileId, config.model]),
    [['profile-a', 'model-a'], ['profile-b', 'model-b']]
  )
  await Promise.all([completeRun(state, first), completeRun(state, second, VALID_MARKDOWN, 'turn-2')])
})
