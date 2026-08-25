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

function artifactMetadata(markdown) {
  return {
    canonical: 'markdown',
    bytes: Buffer.byteLength(markdown),
    sha256: `sha256:${createHash('sha256').update(markdown).digest('hex')}`
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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function captureUnhandledRejections(t) {
  const errors = []
  const listener = error => errors.push(error)
  process.prependListener('unhandledRejection', listener)
  t.after(() => process.removeListener('unhandledRejection', listener))
  return errors
}

async function watchdog(promise, timeoutMs = 2_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('external watchdog expired')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntil(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition wait expired')
    await new Promise(resolve => setTimeout(resolve, 2))
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
  timeouts = {},
  fakeOptions = {},
  workspaceRunningGate = null,
  workspaceRemoveTree = undefined,
  workspaceCreateError = null,
  workspaceCompleteError = null,
  workspaceFailGate = null,
  repositoryCompleteGate = null,
  repositoryCompleteMode = 'real',
  repositoryGetError = null,
  terminalUpdateError = null,
  preparationGate = null,
  latePreparationStage = null,
  preparationError = null,
  sessionIdPatchError = null,
  buildPromptError = null,
  operationalHandler = null
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ucli-interactive-job-'))
  const db = await openDb(join(root, 'ucli.db'))
  const repository = createReportRepository({ db })
  const workspaceService = createSummaryWorkspaceService({
    root: join(root, 'summaries'),
    ...(workspaceRemoveTree ? { removeTree: workspaceRemoveTree } : {})
  })
  const order = []
  const operational = []
  const workspaceObservations = []
  const repositoryCompleteSettled = deferred()
  const repositoryCanonicalCommitted = deferred()
  const preparationSettled = deferred()
  const fake = createSummaryFakeAdapterHarness({
    workspaceService,
    ...fakeOptions,
    onStop(sessionId) {
      order.push('session.stop')
      fakeOptions.onStop?.(sessionId)
    }
  })
  const timers = timerTracker()
  const jobRepository = {
    ...repository,
    get(reportId) {
      if (repositoryGetError) throw repositoryGetError
      return repository.get(reportId)
    },
    async update(reportId, patch) {
      if (sessionIdPatchError && Object.hasOwn(patch, 'sessionId')) throw sessionIdPatchError
      if (terminalUpdateError && ['failed', 'cancelled', 'interrupted'].includes(patch.runPhase)) {
        throw terminalUpdateError
      }
      return repository.update(reportId, patch)
    },
    async complete(...args) {
      order.push('repository.complete')
      try {
        if (repositoryCompleteMode === 'commit-then-hang') {
          const completed = await repository.complete(...args)
          repositoryCanonicalCommitted.resolve(completed)
          await repositoryCompleteGate?.promise
          return completed
        }
        await repositoryCompleteGate?.promise
        if (repositoryCompleteMode === 'resolve-stale') {
          return {
            ...repository.get(args[0]),
            status: 'completed',
            runPhase: 'completed',
            errorText: null
          }
        }
        if (repositoryCompleteMode === 'reject-late') {
          throw new Error('C:\\private\\late-complete')
        }
        return await repository.complete(...args)
      } finally {
        repositoryCompleteSettled.resolve()
      }
    }
  }
  const jobWorkspaceService = {
    ...workspaceService,
    async create(...args) {
      if (workspaceCreateError) throw workspaceCreateError
      return workspaceService.create(...args)
    },
    async complete(...args) {
      order.push('workspace.complete')
      if (workspaceCompleteError) throw workspaceCompleteError
      return workspaceService.complete(...args)
    },
    async markStage(...args) {
      order.push(`workspace.mark:${args[1]}:start`)
      if (args[1] === 'running') await workspaceRunningGate?.promise
      const value = await workspaceService.markStage(...args)
      workspaceObservations.push({ requested: args[1], status: value.status, stage: value.stage })
      order.push(`workspace.mark:${args[1]}:end`)
      return value
    },
    async fail(...args) {
      order.push(`workspace.fail:${args[2]?.status || 'failed'}:start`)
      await workspaceFailGate?.promise
      const value = await workspaceService.fail(...args)
      order.push(`workspace.fail:${args[2]?.status || 'failed'}:end`)
      return value
    }
  }
  const service = createInteractiveSummaryJobService({
    repository: jobRepository,
    workspaceService: jobWorkspaceService,
    preparationService: {
      async prepare({ report, workspace }) {
        try {
          await preparationGate?.promise
          if (preparationError) throw preparationError
          await workspaceService.writeArtifact(report.id, 'input/data.json', '{}\n')
          if (latePreparationStage) {
            await workspaceService.markStage(report.id, latePreparationStage)
          }
          return { coverage: { sessionsIncluded: 1 }, usageSnapshot: {}, workspace }
        } finally {
          preparationSettled.resolve()
        }
      }
    },
    sessionRuntime: fake.runtime,
    waitForArtifact: realArtifact ? undefined : quickArtifact,
    buildPrompt: buildPromptError
      ? () => { throw buildPromptError }
      : undefined,
    timers,
    onOperationalEvent: event => {
      operational.push(event)
      return operationalHandler?.(event)
    },
    timeouts: {
      readyMs: 40,
      deliveryMs: 40,
      runMs: 4_000,
      missingMs: 40,
      cleanupMs: 1_000,
      ...timeouts
    }
  })
  t.after(async () => {
    await watchdog(service.interruptAll('SUMMARY_APP_SHUTDOWN'), 100).catch(() => {})
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    db,
    repository,
    workspaceService,
    fake,
    timers,
    service,
    order,
    operational,
    workspaceObservations,
    repositoryCompleteSettled,
    repositoryCanonicalCommitted,
    preparationSettled
  }
}

async function beginRunning(state, run, turnId = 'turn-1') {
  state.fake.emitReady(run.sessionId)
  try {
    await watchdog(state.fake.waitForSend(run.sessionId), 2_000)
  } catch (error) {
    const persisted = state.repository.get(run.report.id)
    throw new Error(`${error.message}: send db=${persisted?.runPhase}/${persisted?.errorText} order=${state.order.join(',')}`)
  }
  state.fake.emitTurnStarted(run.sessionId, turnId)
  try {
    await waitUntil(() => {
      const persisted = state.repository.get(run.report.id)
      return persisted?.runPhase === 'running'
    }, 3_000)
  } catch (error) {
    const persisted = state.repository.get(run.report.id)
    throw new Error(`${error.message}: db=${persisted?.runPhase} order=${state.order.join(',')}`)
  }
}

async function manifest(state, reportId) {
  return JSON.parse(await readFile(
    join(state.root, 'summaries', 'workspaces', reportId, 'manifest.json'),
    'utf8'
  ))
}

async function assertSettled(state, run, {
  status,
  phase,
  code = null,
  expectNoTimers = true
}) {
  let settled
  try {
    settled = await watchdog(run.done, 6_000)
  } catch (error) {
    const persisted = state.repository.get(run.report.id)
    const workspace = await manifest(state, run.report.id)
    throw new Error(`${error.message}: db=${persisted?.runPhase} workspace=${workspace.stage} order=${state.order.join(',')}`)
  }
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
  assert.equal(state.fake.stopRequests.filter(sessionId => sessionId === run.sessionId).length, 1)
  assert.equal(state.fake.stopped.filter(sessionId => sessionId === run.sessionId).length <= 1, true)
  if (expectNoTimers) assert.equal(state.timers.activeCount, 0)
  return settled
}

async function completeRun(
  state,
  run,
  markdown = VALID_MARKDOWN,
  turnId = 'turn-1',
  expectNoTimers = true
) {
  await beginRunning(state, run, turnId)
  await state.fake.writeCanonicalMarkdown(run.report.id, markdown)
  return assertSettled(state, run, {
    status: 'completed', phase: 'completed', expectNoTimers
  })
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

test('a resolved system selection cannot be replaced by profile bindings during session creation', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request({ profileId: null, model: 'system-model' }))
  assert.equal(run.report.profileId, null)
  assert.equal(run.report.model, 'system-model')
  assert.deepEqual(state.fake.config(run.sessionId), {
    adapterId: 'claude',
    profileId: null,
    profileSelection: 'system',
    model: 'system-model',
    name: '工作总结（每周）v1',
    cwd: join(state.root, 'summaries', 'workspaces', run.report.id, 'work')
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

test('terminal event during a pending running workspace transition cannot be overwritten', async t => {
  const workspaceRunningGate = deferred()
  const state = await fixture(t, { workspaceRunningGate })
  const run = await state.service.start(request())
  state.fake.emitReady(run.sessionId)
  await state.fake.waitForSend(run.sessionId)
  state.fake.emitTurnStarted(run.sessionId)
  await waitUntil(() => state.order.includes('workspace.mark:running:start'))

  state.fake.emitExit(run.sessionId)
  workspaceRunningGate.resolve()

  await assertSettled(state, run, {
    status: 'failed', phase: 'failed', code: 'SUMMARY_RUN_FAILED'
  })
})

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
  const state = await fixture(t, { timeouts: { runMs: 1_000 } })
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

test('deletion cancellation leaves a report-bound shared session for database ownership', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await beginRunning(state, run)
  state.db.insertSession({
    id: run.sessionId, project_path: 'F:\\summary', adapter_id: 'claude',
    name: 'interactive summary', task_note: '', tier: 'safety-rules',
    status: 'running', created_at: Date.now()
  })
  const shared = await state.repository.createQueued({
    ...request({ start: START + WEEK, endExclusive: START + (2 * WEEK) }),
    generatedBy: 'manual', executionMode: 'interactive-cli'
  })
  await state.repository.update(shared.id, { sessionId: run.sessionId })

  assert.equal(await state.service.cancelForDeletion(run.report.id), true)
  const deleted = await state.repository.delete(run.report.id)

  assert.equal(deleted.removedSessionId, null)
  assert.equal(state.db.getSession(run.sessionId).removedAt, null)
  assert.ok(state.fake.config(run.sessionId))
  assert.deepEqual(state.fake.removeRequests, [])
})

test('deletion cancellation retains construction ownership until its late session is removed', async t => {
  const createGate = deferred()
  const stopGate = deferred()
  t.after(() => {
    createGate.resolve()
    stopGate.resolve()
  })
  const state = await fixture(t, {
    fakeOptions: { createGate, stopGate },
    timeouts: { cleanupMs: 100 }
  })
  const starting = state.service.start(request())
  await waitUntil(() => state.fake.createRequests.length === 1)
  const [queued] = state.repository.list()
  let cancelled = false
  const cancelling = state.service.cancelForDeletion(queued.id).then(value => {
    cancelled = value
    return value
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, false)
  assert.equal(state.repository.get(queued.id).status, 'running')
  assert.equal((await manifest(state, queued.id)).status, 'running')
  assert.equal(state.service.isActive(queued.id), true)

  createGate.resolve()
  await waitUntil(() => state.fake.stopRequests.length === 1)
  assert.equal(cancelled, false)
  stopGate.resolve()

  assert.equal(await watchdog(cancelling), true)
  await assert.rejects(starting, error => error?.code === 'SUMMARY_CANCELLED')
  assert.deepEqual(state.fake.removeRequests, ['summary-session-1'])
  assert.equal(state.service.isActive(queued.id), false)
})

test('failed late projection removal preserves the deletion target for a retry', async t => {
  const createGate = deferred()
  let removalAttempts = 0
  t.after(() => createGate.resolve())
  const state = await fixture(t, {
    fakeOptions: {
      createGate,
      removeError: () => {
        removalAttempts += 1
        return removalAttempts === 1 ? new Error('private projection removal') : null
      }
    },
    timeouts: { cleanupMs: 100 }
  })
  const starting = state.service.start(request())
  await waitUntil(() => state.fake.createRequests.length === 1)
  const [queued] = state.repository.list()
  const cancelling = state.service.cancelForDeletion(queued.id)

  createGate.resolve()
  await assert.rejects(
    watchdog(cancelling),
    error => error?.code === 'SUMMARY_DELETE_DRAIN_FAILED'
  )
  assert.equal(state.repository.get(queued.id).status, 'running')
  assert.equal((await manifest(state, queued.id)).status, 'running')
  assert.equal(state.service.isActive(queued.id), true)

  assert.equal(await watchdog(state.service.cancelForDeletion(queued.id)), true)
  await assert.rejects(starting, error => error?.code === 'SUMMARY_CANCELLED')
  assert.deepEqual(state.fake.removeRequests, ['summary-session-1', 'summary-session-1'])
  assert.equal(state.service.isActive(queued.id), false)
})

for (const [label, fakeOptions] of [
  ['rejecting', { stopError: new Error('private stop rejection') }],
  ['timed-out', { stopGate: deferred() }]
]) {
  test(`deletion cancellation preserves an active interactive task when session stop is ${label}`, async t => {
    const stopGate = fakeOptions.stopGate
    t.after(() => stopGate?.resolve())
    const state = await fixture(t, {
      fakeOptions,
      timeouts: { cleanupMs: 20 }
    })
    const run = await state.service.start(request())
    await beginRunning(state, run)

    await assert.rejects(
      watchdog(state.service.cancelForDeletion(run.report.id), 1_000),
      error => error?.code === 'SUMMARY_DELETE_DRAIN_FAILED'
    )

    assert.equal(state.repository.get(run.report.id).status, 'running')
    assert.equal((await manifest(state, run.report.id)).status, 'running')
    assert.equal(state.service.isActive(run.report.id), true)
  })
}

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
  const state = await fixture(t, { timeouts: { readyMs: 1_000 } })
  const [week, day] = await Promise.all([
    state.service.start(request()),
    state.service.start(request({ periodType: 'day', endExclusive: START + 24 * 60 * 60 * 1000 }))
  ])
  assert.notEqual(week.report.id, day.report.id)
  assert.notEqual(week.sessionId, day.sessionId)
  assert.notEqual(state.fake.config(week.sessionId).cwd, state.fake.config(day.sessionId).cwd)
  await Promise.all([
    completeRun(state, week, VALID_MARKDOWN, 'turn-1', false),
    completeRun(state, day, VALID_MARKDOWN, 'turn-2', false)
  ])
  assert.equal(state.timers.activeCount, 0)
})

test('different profile and model inputs are forwarded to distinct native sessions', async t => {
  const state = await fixture(t, { timeouts: { readyMs: 1_000 } })
  const first = await state.service.start(request({ profileId: 'profile-a', model: 'model-a' }))
  const second = await state.service.start(request({ profileId: 'profile-b', model: 'model-b' }))
  assert.notEqual(first.sessionId, second.sessionId)
  assert.deepEqual(
    [state.fake.config(first.sessionId), state.fake.config(second.sessionId)].map(config =>
      [config.profileId, config.model]),
    [['profile-a', 'model-a'], ['profile-b', 'model-b']]
  )
  try {
    await Promise.all([
      watchdog(completeRun(state, first, VALID_MARKDOWN, 'turn-1', false), 5_000),
      watchdog(completeRun(state, second, VALID_MARKDOWN, 'turn-2', false), 5_000)
    ])
  } catch (error) {
    const firstManifest = await manifest(state, first.report.id)
    const secondManifest = await manifest(state, second.report.id)
    throw new Error(`${error.message}: first=${state.repository.get(first.report.id)?.runPhase}/${firstManifest.stage} second=${state.repository.get(second.report.id)?.runPhase}/${secondManifest.stage} order=${state.order.join(',')}`)
  }
  assert.equal(state.timers.activeCount, 0)
})

test('hung runtime start is bounded by the total deadline and settles every owner', async t => {
  const startGate = deferred()
  const state = await fixture(t, {
    fakeOptions: { startGate },
    timeouts: { runMs: 1_000, cleanupMs: 500 }
  })
  const run = await watchdog(state.service.start(request()))
  await waitUntil(() => state.fake.startRequests.length === 1, 1_000)
  const completed = await watchdog(run.done, 2_000)

  assert.equal(completed.status, 'failed')
  assert.equal(completed.errorText, 'SUMMARY_RUN_TIMEOUT')
  assert.equal((await manifest(state, run.report.id)).status, 'failed')
  assert.equal(state.service.isActive(run.report.id), false)
  assert.equal(state.fake.listenerCount(run.sessionId), 0)
  assert.equal(state.fake.stopRequests.filter(id => id === run.sessionId).length, 1)
  assert.equal(state.timers.activeCount, 0)
})

for (const [label, terminal] of [
  ['completion', 'completed'],
  ['cancel', 'cancelled'],
  ['shutdown interrupt', 'interrupted']
]) {
  test(`hung native stop cannot block ${label} settlement`, async t => {
    const stopGate = deferred()
    const state = await fixture(t, {
      fakeOptions: { stopGate },
      timeouts: { cleanupMs: 500 }
    })
    const run = await watchdog(state.service.start(request()))
    await beginRunning(state, run)
    if (terminal === 'completed') {
      await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
    } else if (terminal === 'cancelled') {
      await watchdog(state.service.cancel(run.report.id))
    } else {
      await watchdog(state.service.interruptAll('SUMMARY_APP_SHUTDOWN'))
    }
    const completed = await watchdog(run.done)

    assert.equal(completed.status, terminal)
    assert.equal(state.repository.get(run.report.id).status, terminal)
    assert.equal((await manifest(state, run.report.id)).status, terminal)
    assert.equal(state.service.isActive(run.report.id), false)
    assert.equal(state.fake.listenerCount(run.sessionId), 0)
    assert.equal(state.fake.stopRequests.filter(id => id === run.sessionId).length, 1)
    assert.equal(state.timers.activeCount, 0)
  })
}

for (const [label, options, hasWorkspace, hasSession] of [
  ['workspace create', { workspaceCreateError: new Error('private workspace path') }, false, false],
  ['preparation', { preparationError: new Error('private evidence') }, true, false],
  ['session create', { fakeOptions: { createError: new Error('private session') } }, true, false],
  ['session id persistence', { sessionIdPatchError: new Error('private database') }, true, true]
]) {
  test(`${label} initialization failure leaves no queued or running orphan`, async t => {
    const state = await fixture(t, options)
    await assert.rejects(
      watchdog(state.service.start(request())),
      error => error?.code === 'SUMMARY_RUN_FAILED'
    )
    const [report] = state.repository.list()
    assert.equal(report.status, 'failed')
    assert.equal(report.runPhase, 'failed')
    assert.equal(report.errorText, 'SUMMARY_RUN_FAILED')
    assert.equal(state.service.isActive(report.id), false)
    assert.equal(state.timers.activeCount, 0)
    if (hasWorkspace) assert.equal((await manifest(state, report.id)).status, 'failed')
    if (hasSession) assert.equal(state.fake.stopRequests.length, 1)
  })
}

test('interruptAll owns a start that is still waiting for native session creation', async t => {
  const createGate = deferred()
  const state = await fixture(t, {
    fakeOptions: { createGate },
    timeouts: { runMs: 1_500, cleanupMs: 1_000 }
  })
  const starting = state.service.start(request())
  await waitUntil(() => state.fake.createRequests.length === 1)
  const [queued] = state.repository.list()
  assert.equal(state.service.isActive(queued.id), true)
  assert.equal(await watchdog(state.service.interruptAll('SUMMARY_APP_SHUTDOWN')), 1)
  await assert.rejects(
    watchdog(starting),
    error => error?.code === 'SUMMARY_APP_SHUTDOWN'
  )
  assert.equal(state.repository.get(queued.id).status, 'interrupted')
  assert.equal((await manifest(state, queued.id)).status, 'interrupted')
  assert.equal(state.service.isActive(queued.id), false)
  assert.equal(state.timers.activeCount, 0)
})

test('completed database state survives workspace finalization failure with one safe operational event', async t => {
  const state = await fixture(t, {
    workspaceCompleteError: new Error('C:\\private\\locked-work')
  })
  const progress = []
  state.service.subscribe(event => progress.push(event))
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
  const completed = await watchdog(run.done)

  assert.equal(completed.status, 'completed')
  assert.equal(state.repository.get(run.report.id).status, 'completed')
  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: run.report.id, code: 'SUMMARY_RUN_FAILED'
  }])
  assert.equal(JSON.stringify(state.operational).includes('private'), false)
  assert.equal(progress.filter(event => event.phase === 'completed').length, 1)
  assert.equal(progress.some(event => event.status === 'failed'), false)
})

test('completion commits the database then releases native cwd before workspace compaction', async t => {
  const state = await fixture(t)
  const run = await state.service.start(request())
  await completeRun(state, run)
  assert.deepEqual(state.order.filter(value => [
    'repository.complete', 'session.stop', 'workspace.complete'
  ].includes(value)), [
    'repository.complete', 'session.stop', 'workspace.complete'
  ])
})

test('canonical completion handoff keeps cleanup deadlines owned until done settles', async t => {
  const repositoryCompleteGate = deferred()
  const stopGate = deferred()
  t.after(() => {
    repositoryCompleteGate.resolve()
    stopGate.resolve()
  })
  const state = await fixture(t, {
    repositoryCompleteGate,
    repositoryCompleteMode: 'commit-then-hang',
    fakeOptions: { stopGate },
    timeouts: { runMs: 500, cleanupMs: 100 }
  })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
  await watchdog(state.repositoryCanonicalCommitted.promise)

  const completed = await watchdog(run.done, 2_000)
  assert.equal(completed.status, 'completed')
  assert.equal(state.repository.get(run.report.id).status, 'completed')
  assert.equal((await manifest(state, run.report.id)).status, 'completed')
  assert.equal(state.service.isActive(run.report.id), false)
  assert.equal(state.fake.listenerCount(run.sessionId), 0)
  assert.equal(state.fake.stopRequests.filter(id => id === run.sessionId).length, 1)
  assert.equal(state.timers.activeCount, 0)
  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: run.report.id, code: 'SUMMARY_RUN_FAILED'
  }])
})

test('canonical read failure rejects done safely and still releases every owner', async t => {
  const unhandled = captureUnhandledRejections(t)
  const state = await fixture(t, {
    repositoryGetError: new Error('C:\\private\\canonical-read')
  })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  state.fake.emitExit(run.sessionId)

  await assert.rejects(
    watchdog(run.done, 1_000),
    error => error?.code === 'SUMMARY_RUN_FAILED' && !error.message.includes('private')
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.repository.get(run.report.id).status, 'failed')
  assert.equal((await manifest(state, run.report.id)).status, 'failed')
  assert.equal(state.service.isActive(run.report.id), false)
  assert.equal(state.fake.listenerCount(run.sessionId), 0)
  assert.equal(state.fake.stopRequests.filter(id => id === run.sessionId).length, 1)
  assert.equal(state.timers.activeCount, 0)
  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: run.report.id, code: 'SUMMARY_RUN_FAILED'
  }])
  assert.deepEqual(unhandled, [])
})

test('late real completion cannot replace a timed-out report or demote its prior current', async t => {
  const repositoryCompleteGate = deferred()
  t.after(() => repositoryCompleteGate.resolve())
  const state = await fixture(t, {
    repositoryCompleteGate,
    repositoryCompleteMode: 'real',
    timeouts: { runMs: 500, cleanupMs: 100 }
  })
  const previous = await state.repository.createQueued({
    ...request(),
    generatedBy: 'manual',
    runPhase: 'preparing'
  })
  await state.repository.update(previous.id, { status: 'running', runPhase: 'running' })
  const previousCompleted = await state.repository.complete(previous.id, {
    markdown: VALID_MARKDOWN,
    sourceHash: artifactMetadata(VALID_MARKDOWN).sha256,
    usageSnapshot: {},
    coverage: {},
    artifactMetadata: artifactMetadata(VALID_MARKDOWN)
  })
  await state.repository.setCurrent(previousCompleted.id)

  const run = await state.service.start(request())
  await beginRunning(state, run)
  await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
  await waitUntil(() => state.order.includes('repository.complete'))
  const timedOut = await watchdog(run.done, 2_000)
  assert.equal(timedOut.status, 'failed')
  assert.equal(timedOut.errorText, 'SUMMARY_RUN_TIMEOUT')

  repositoryCompleteGate.resolve()
  await watchdog(state.repositoryCompleteSettled.promise)
  await new Promise(resolve => setImmediate(resolve))
  const oldCurrent = state.repository.get(previousCompleted.id)
  const failed = state.repository.get(run.report.id)
  assert.equal(oldCurrent.isCurrent, true)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.isCurrent, false)
  assert.equal(failed.markdown, null)
  assert.equal(failed.sourceHash, null)
  assert.deepEqual(failed.artifactMetadata, {})
})

test('concurrent late session creation keeps its hung stop deadline observable', async t => {
  const createGate = deferred()
  const stopGate = deferred()
  const workspaceFailGate = deferred()
  t.after(() => {
    createGate.resolve()
    stopGate.resolve()
    workspaceFailGate.resolve()
  })
  const state = await fixture(t, {
    fakeOptions: { createGate, stopGate },
    workspaceFailGate,
    timeouts: { cleanupMs: 100 }
  })
  const starting = state.service.start(request())
  await waitUntil(() => state.fake.createRequests.length === 1)
  const [queued] = state.repository.list()

  const interrupting = state.service.interruptAll('SUMMARY_APP_SHUTDOWN')
  createGate.resolve()
  await waitUntil(() => state.fake.stopRequests.length === 1, 1_000)
  workspaceFailGate.resolve()
  assert.equal(await watchdog(interrupting), 1)
  await assert.rejects(starting, error => error?.code === 'SUMMARY_APP_SHUTDOWN')
  await waitUntil(() => state.operational.length === 1, 1_000)

  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: queued.id, code: 'SUMMARY_RUN_FAILED'
  }])
  assert.equal(state.repository.get(queued.id).status, 'interrupted')
  assert.equal((await manifest(state, queued.id)).status, 'interrupted')
  assert.equal(state.service.isActive(queued.id), false)
  assert.equal(state.timers.activeCount, 0)
})

for (const repositoryCompleteMode of ['resolve-stale', 'reject-late']) {
  test(`hung repository completion settles by deadline and consumes a ${repositoryCompleteMode} result`, async t => {
    const repositoryCompleteGate = deferred()
    t.after(() => repositoryCompleteGate.resolve())
    const state = await fixture(t, {
      repositoryCompleteGate,
      repositoryCompleteMode,
      timeouts: { runMs: 800, cleanupMs: 100 }
    })
    const run = await state.service.start(request())
    await beginRunning(state, run)
    await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
    await waitUntil(() => state.order.includes('repository.complete'), 1_000)

    const completed = await watchdog(run.done, 2_000)
    assert.equal(completed.status, 'failed')
    assert.equal(completed.errorText, 'SUMMARY_RUN_TIMEOUT')
    assert.equal(state.service.isActive(run.report.id), false)
    assert.equal(state.fake.listenerCount(run.sessionId), 0)
    assert.equal(state.timers.activeCount, 0)

    repositoryCompleteGate.resolve()
    await watchdog(state.repositoryCompleteSettled.promise)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.repository.get(run.report.id).status, 'failed')
    assert.equal((await manifest(state, run.report.id)).status, 'failed')
  })
}

for (const [label, phase, terminate] of [
  ['cancel', 'cancelled', (state, reportId) => state.service.cancel(reportId)],
  ['shutdown', 'interrupted', state => state.service.interruptAll('SUMMARY_APP_SHUTDOWN')]
]) {
  test(`${label} owns a repository completion that never settles`, async t => {
    const repositoryCompleteGate = deferred()
    t.after(() => repositoryCompleteGate.resolve())
    const state = await fixture(t, {
      repositoryCompleteGate,
      repositoryCompleteMode: 'reject-late',
      timeouts: { cleanupMs: 100 }
    })
    const run = await state.service.start(request())
    await beginRunning(state, run)
    await state.fake.writeCanonicalMarkdown(run.report.id, VALID_MARKDOWN)
    await waitUntil(() => state.order.includes('repository.complete'))

    await watchdog(terminate(state, run.report.id), 1_000)
    const completed = await watchdog(run.done)
    assert.equal(completed.status, phase)
    assert.equal(state.repository.get(run.report.id).status, phase)
    assert.equal((await manifest(state, run.report.id)).status, phase)
    assert.equal(state.service.isActive(run.report.id), false)
    assert.equal(state.timers.activeCount, 0)

    repositoryCompleteGate.resolve()
    await watchdog(state.repositoryCompleteSettled.promise)
    assert.equal(state.repository.get(run.report.id).status, phase)
  })
}

test('terminal repository failure rejects done safely and still releases every owner', async t => {
  const unhandled = captureUnhandledRejections(t)
  const state = await fixture(t, {
    terminalUpdateError: new Error('C:\\private\\terminal-database')
  })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  state.fake.emitExit(run.sessionId)

  await assert.rejects(
    watchdog(run.done),
    error => error?.code === 'SUMMARY_RUN_FAILED' && !error.message.includes('private')
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.service.isActive(run.report.id), false)
  assert.equal(state.fake.listenerCount(run.sessionId), 0)
  assert.equal(state.fake.stopRequests.filter(id => id === run.sessionId).length, 1)
  assert.equal((await manifest(state, run.report.id)).status, 'failed')
  assert.equal(state.timers.activeCount, 0)
  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: run.report.id, code: 'SUMMARY_RUN_FAILED'
  }])
  assert.deepEqual(unhandled, [])
})

test('real workspace cleanup rejection completes canonically and emits one safe operational event', async t => {
  const state = await fixture(t, {
    workspaceRemoveTree: async () => {
      throw new Error('C:\\private\\locked-cleanup')
    }
  })
  const run = await state.service.start(request())
  await completeRun(state, run)

  assert.equal(state.repository.get(run.report.id).status, 'completed')
  assert.equal((await manifest(state, run.report.id)).status, 'completed')
  assert.deepEqual(state.operational, [{
    type: 'operational', reportId: run.report.id, code: 'SUMMARY_RUN_FAILED'
  }])
})

test('late preparation cannot restore a running workspace after its deadline terminal', async t => {
  const preparationGate = deferred()
  t.after(() => preparationGate.resolve())
  const state = await fixture(t, {
    preparationGate,
    latePreparationStage: 'starting',
    timeouts: { runMs: 300, cleanupMs: 100 }
  })
  const starting = state.service.start(request())
  await waitUntil(() => state.repository.list().length === 1)
  const [queued] = state.repository.list()

  await assert.rejects(
    watchdog(starting, 1_000),
    error => error?.code === 'SUMMARY_RUN_TIMEOUT'
  )
  assert.equal((await manifest(state, queued.id)).status, 'failed')
  preparationGate.resolve()
  await watchdog(state.preparationSettled.promise)
  await new Promise(resolve => setImmediate(resolve))

  const workspace = await manifest(state, queued.id)
  assert.equal(workspace.status, 'failed')
  assert.equal(workspace.stage, 'failed')
  assert.equal(state.service.isActive(queued.id), false)
  await waitUntil(() => state.timers.activeCount === 0, 1_000)
  assert.equal(state.timers.activeCount, 0)
})

test('a running workspace mutation resolving after cleanup timeout stays terminal', async t => {
  const workspaceRunningGate = deferred()
  t.after(() => workspaceRunningGate.resolve())
  const state = await fixture(t, {
    workspaceRunningGate,
    timeouts: { cleanupMs: 100 }
  })
  const run = await state.service.start(request())
  await beginRunning(state, run)
  await waitUntil(() => state.order.includes('workspace.mark:running:start'))
  state.fake.emitExit(run.sessionId)

  await watchdog(run.done, 1_000)
  assert.equal((await manifest(state, run.report.id)).stage, 'failed')
  workspaceRunningGate.resolve()
  await waitUntil(() => state.workspaceObservations.some(item => item.requested === 'running'))

  assert.deepEqual(
    state.workspaceObservations.find(item => item.requested === 'running'),
    { requested: 'running', status: 'failed', stage: 'failed' }
  )
  assert.equal((await manifest(state, run.report.id)).stage, 'failed')
})

test('buildPrompt failure is terminalized after queued ownership is registered', async t => {
  const state = await fixture(t, {
    buildPromptError: new Error('C:\\private\\prompt-source')
  })

  await assert.rejects(
    state.service.start(request()),
    error => error?.code === 'SUMMARY_RUN_FAILED' && !error.message.includes('private')
  )
  const [report] = state.repository.list()
  assert.equal(report.status, 'failed')
  assert.equal(report.runPhase, 'failed')
  assert.equal(report.errorText, 'SUMMARY_RUN_FAILED')
  assert.equal(state.service.isActive(report.id), false)
  assert.equal(state.timers.activeCount, 0)
})

for (const stopMode of ['reject', 'hang']) {
  test(`late session created after interrupt has bounded ${stopMode} cleanup`, async t => {
    const unhandled = captureUnhandledRejections(t)
    const createGate = deferred()
    const stopGate = stopMode === 'hang' ? deferred() : null
    t.after(() => {
      createGate.resolve()
      stopGate?.resolve()
    })
    const state = await fixture(t, {
      fakeOptions: {
        createGate,
        ...(stopGate ? { stopGate } : { stopError: new Error('private native stop') })
      },
      timeouts: { cleanupMs: 100 }
    })
    const starting = state.service.start(request())
    await waitUntil(() => state.fake.createRequests.length === 1)
    const [queued] = state.repository.list()
    assert.equal(await state.service.interruptAll('SUMMARY_APP_SHUTDOWN'), 1)
    await assert.rejects(starting, error => error?.code === 'SUMMARY_APP_SHUTDOWN')

    createGate.resolve()
    await waitUntil(() => state.fake.stopRequests.length === 1, 1_000)
    await waitUntil(() => state.operational.length === 1, 1_000)
    stopGate?.resolve()
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(state.operational, [{
      type: 'operational', reportId: queued.id, code: 'SUMMARY_RUN_FAILED'
    }])
    assert.deepEqual(unhandled, [])
    assert.equal(state.service.isActive(queued.id), false)
  })
}

test('rejected asynchronous operational observer is always consumed', async t => {
  const unhandled = captureUnhandledRejections(t)
  const state = await fixture(t, {
    workspaceRemoveTree: async () => {
      throw new Error('trigger safe operational event')
    },
    operationalHandler: async () => {
      throw new Error('C:\\private\\observer')
    }
  })
  const run = await state.service.start(request())
  await completeRun(state, run)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(state.operational.length, 1)
  assert.deepEqual(unhandled, [])
})
