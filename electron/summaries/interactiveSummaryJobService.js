import {
  buildInteractiveSummaryPrompt,
  waitForCanonicalMarkdown
} from './interactiveSummaryArtifact.js'
import {
  INTERACTIVE_SUMMARY_DELIVERY_TIMEOUT_MS,
  INTERACTIVE_SUMMARY_PHASE,
  SUMMARY_EXECUTION_MODE,
  safeInteractiveSummaryError
} from './interactiveSummaryContracts.js'

const DEFAULT_TIMEOUTS = Object.freeze({
  readyMs: 60_000,
  deliveryMs: INTERACTIVE_SUMMARY_DELIVERY_TIMEOUT_MS,
  runMs: 20 * 60_000,
  missingMs: 5_000,
  cleanupMs: 5_000
})

const PERIOD_LABELS = Object.freeze({
  day: '每日',
  week: '每周',
  month: '每月',
  quarter: '每季度',
  year: '每年'
})

const TRANSITIONS = Object.freeze({
  preparing: new Set(['starting', 'failed', 'cancelled', 'interrupted']),
  starting: new Set(['awaiting-delivery', 'failed', 'cancelled', 'interrupted']),
  'awaiting-delivery': new Set(['running', 'failed', 'cancelled', 'interrupted']),
  running: new Set(['validating', 'failed', 'cancelled', 'interrupted']),
  validating: new Set(['completed', 'failed', 'cancelled', 'interrupted'])
})

function typed(code) {
  return Object.assign(new Error(code), { code })
}

function timeoutValue(value, fallback) {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 1) throw typed('SUMMARY_RUN_TIMEOUT')
  return resolved
}

function requireMethod(owner, method, label) {
  if (!owner || typeof owner[method] !== 'function') {
    throw new TypeError(`${label}.${method} is required`)
  }
}

function deferred({ consumeRejection = false } = {}) {
  let resolve
  let reject
  let settled = false
  const promise = new Promise((done, fail) => {
    resolve = value => {
      if (settled) return
      settled = true
      done(value)
    }
    reject = error => {
      if (settled) return
      settled = true
      fail(error)
    }
  })
  if (consumeRejection) promise.catch(() => {})
  return { promise, resolve, reject, get settled() { return settled } }
}

function phaseText(phase, error) {
  if (error) return safeInteractiveSummaryError(error, 'SUMMARY_RUN_FAILED').message
  return {
    starting: '正在启动 AI CLI',
    'awaiting-delivery': '正在投递生成指令',
    running: '正在生成总结',
    validating: '正在验证 Markdown 报告',
    completed: '总结已生成'
  }[phase] || '工作总结状态已更新'
}

function resultSessionId(value) {
  const sessionId = typeof value === 'string' ? value : value?.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw typed('SUMMARY_RUN_FAILED')
  return sessionId
}

function safeTerminalCode(error, fallback = 'SUMMARY_RUN_FAILED') {
  if (error?.code === 'SUMMARY_TURN_NOT_ACCEPTED') return 'SUMMARY_TURN_NOT_CONFIRMED'
  return safeInteractiveSummaryError(error, fallback).code
}

export function createInteractiveSummaryJobService({
  repository,
  workspaceService,
  preparationService,
  sessionRuntime,
  buildPrompt = buildInteractiveSummaryPrompt,
  waitForArtifact = waitForCanonicalMarkdown,
  now = Date.now,
  timers = globalThis,
  timeouts = {},
  onOperationalEvent = () => {}
} = {}) {
  for (const method of ['createQueued', 'update', 'complete', 'get']) {
    requireMethod(repository, method, 'repository')
  }
  for (const method of ['create', 'markStage', 'complete', 'fail']) {
    requireMethod(workspaceService, method, 'workspaceService')
  }
  requireMethod(preparationService, 'prepare', 'preparationService')
  for (const method of ['create', 'start', 'waitReady', 'deliver', 'subscribe', 'stop', 'remove']) {
    requireMethod(sessionRuntime, method, 'sessionRuntime')
  }
  if (typeof buildPrompt !== 'function' || typeof waitForArtifact !== 'function' ||
    typeof now !== 'function' || typeof timers?.setTimeout !== 'function' ||
    typeof timers?.clearTimeout !== 'function' || typeof onOperationalEvent !== 'function') {
    throw new TypeError('Interactive summary job dependencies are required')
  }

  const limits = Object.freeze({
    readyMs: timeoutValue(timeouts.readyMs, DEFAULT_TIMEOUTS.readyMs),
    deliveryMs: timeoutValue(timeouts.deliveryMs, DEFAULT_TIMEOUTS.deliveryMs),
    runMs: timeoutValue(timeouts.runMs, DEFAULT_TIMEOUTS.runMs),
    missingMs: timeoutValue(timeouts.missingMs, DEFAULT_TIMEOUTS.missingMs),
    cleanupMs: timeoutValue(timeouts.cleanupMs, DEFAULT_TIMEOUTS.cleanupMs)
  })
  const active = new Map()
  const listeners = new Set()

  function publish(report, error = null) {
    const progress = Object.freeze({
      reportId: report.id,
      phase: report.runPhase,
      status: report.status,
      text: phaseText(report.runPhase, error)
    })
    for (const listener of [...listeners]) {
      try { listener(progress) } catch {}
    }
  }

  function operational(reportId, code = 'SUMMARY_RUN_FAILED') {
    const event = Object.freeze({ type: 'operational', reportId, code })
    try { Promise.resolve(onOperationalEvent(event)).catch(() => {}) } catch {}
    for (const listener of [...listeners]) {
      try { Promise.resolve(listener(event)).catch(() => {}) } catch {}
    }
  }

  function reportOperational(job) {
    if (job.operationalReported) return
    job.operationalReported = true
    operational(job.reportId)
  }

  function clearJobTimer(job, key) {
    if (!job[key]) return
    timers.clearTimeout(job[key])
    job[key] = null
  }

  function schedule(job, key, delay, callback) {
    clearJobTimer(job, key)
    job[key] = timers.setTimeout(() => {
      job[key] = null
      callback()
    }, delay)
  }

  async function bounded(job, operation, timeoutMs = limits.cleanupMs) {
    const deadlineOwner = { handle: null, resolve: null, settled: false }
    const work = Promise.resolve(operation).then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error })
    )
    const deadline = new Promise(resolve => {
      deadlineOwner.resolve = resolve
      deadlineOwner.handle = timers.setTimeout(() => {
        settleCleanupDeadline(job, deadlineOwner, { ok: false, timeout: true })
      }, timeoutMs)
      job.cleanupTimers.add(deadlineOwner)
    })
    const outcome = await Promise.race([work, deadline])
    settleCleanupDeadline(job, deadlineOwner, { ok: false, cancelled: true })
    return outcome
  }

  function settleCleanupDeadline(job, owner, outcome) {
    if (owner.settled) return
    owner.settled = true
    if (owner.handle) timers.clearTimeout(owner.handle)
    job.cleanupTimers.delete(owner)
    owner.resolve(outcome)
  }

  function compensate(job, operation) {
    Promise.resolve().then(async () => {
      const outcome = await bounded(job, Promise.resolve().then(operation))
      if (!outcome.ok) reportOperational(job)
    }).catch(() => reportOperational(job))
  }

  function clearOwnedResources(job) {
    clearJobTimer(job, 'totalTimer')
    clearJobTimer(job, 'missingTimer')
    for (const owner of [...job.cleanupTimers]) {
      settleCleanupDeadline(job, owner, { ok: false, cancelled: true })
    }
    job.abortController.abort()
    job.unsubscribe?.()
    job.unsubscribe = null
  }

  async function stopOwnedSession(job) {
    if (!job.sessionId) return { ok: true, value: false }
    if (!job.stopPromise) {
      job.stopPromise = Promise.resolve().then(() => sessionRuntime.stop(job.sessionId))
    }
    return bounded(job, job.stopPromise)
  }

  async function removeOwnedSession(job) {
    if (!job.sessionId || job.projectionRemoved) return { ok: true, value: true }
    if (!job.removePromise) {
      job.removePromise = Promise.resolve().then(() => sessionRuntime.remove(job.sessionId))
    }
    const outcome = await bounded(job, job.removePromise)
    if (outcome.ok && outcome.value === true) job.projectionRemoved = true
    else job.removePromise = null
    return outcome
  }

  async function drainDeletionSession(job, sessionId = job.sessionId, {
    removeProjection = !job.sessionBoundToReport
  } = {}) {
    if (sessionId && !job.sessionId) job.sessionId = sessionId
    if (!job.sessionId) return { ok: true, value: true }
    const stopped = await stopOwnedSession(job)
    if (!stopped.ok || stopped.value !== true) {
      job.stopPromise = null
      return stopped
    }
    return removeProjection ? removeOwnedSession(job) : { ok: true, value: true }
  }

  async function cleanLateCreatedSession(job, value) {
    const sessionId = resultSessionId(value)
    if (!job.sessionId) job.sessionId = sessionId
    const stopped = await stopOwnedSession(job)
    if (!stopped.ok || stopped.value !== true) {
      job.stopPromise = null
      throw typed('SUMMARY_RUN_FAILED')
    }
    if (!job.deletionRequired) return true
    const removed = await removeOwnedSession(job)
    if (!removed.ok || removed.value !== true) throw typed('SUMMARY_RUN_FAILED')
    return true
  }

  async function ownedStep(job, operation, onLateValue) {
    if (job.terminal) throw typed(job.terminal.code)
    const pending = Promise.resolve().then(operation)
    pending.then(
      value => {
        if (job.terminal && onLateValue) compensate(job, () => onLateValue(value))
      },
      () => {}
    )
    const outcome = await Promise.race([
      pending.then(
        value => ({ kind: 'value', value }),
        error => ({ kind: 'error', error })
      ),
      job.terminalSignal.promise.then(terminal => ({ kind: 'terminal', terminal }))
    ])
    if (outcome.kind === 'terminal') throw typed(outcome.terminal.code)
    if (outcome.kind === 'error') throw outcome.error
    if (job.terminal) throw typed(job.terminal.code)
    return outcome.value
  }

  async function transition(job, phase, patch = {}) {
    if (!TRANSITIONS[job.phase]?.has(phase)) throw typed('SUMMARY_RUN_TRANSITION_INVALID')
    job.phase = phase
    const status = ['failed', 'interrupted', 'cancelled'].includes(phase) ? phase : 'running'
    const repositoryOperation = Promise.resolve().then(() => repository.update(job.reportId, {
      status,
      runPhase: phase,
      ...patch,
      updatedAt: now()
    }))
    job.repositoryOperation = repositoryOperation
    repositoryOperation.then(
      () => {
        if (job.repositoryOperation === repositoryOperation) job.repositoryOperation = null
      },
      () => {
        if (job.repositoryOperation === repositoryOperation) job.repositoryOperation = null
      }
    )
    const report = await ownedStep(job, () => repositoryOperation, () => repository.update(
      job.reportId,
      {
        status: job.terminal?.phase || 'failed',
        runPhase: job.terminal?.phase || 'failed',
        errorText: job.terminal?.code || 'SUMMARY_RUN_FAILED',
        updatedAt: now()
      }
    ))
    job.report = report
    if (job.terminal) throw typed(job.terminal.code)
    const workspaceOperation = Promise.resolve().then(() => workspaceService.markStage(job.reportId, phase))
    job.workspaceOperation = workspaceOperation
    workspaceOperation.then(
      () => {
        if (job.workspaceOperation === workspaceOperation) job.workspaceOperation = null
      },
      () => {
        if (job.workspaceOperation === workspaceOperation) job.workspaceOperation = null
      }
    )
    await ownedStep(job, () => workspaceOperation, () => workspaceService.fail(
      job.reportId,
      job.terminal?.code || 'SUMMARY_RUN_FAILED',
      {
        status: job.terminal?.phase || 'failed',
        stage: job.terminal?.phase || 'failed'
      }
    ))
    publish(report)
    return report
  }

  function repositoryReadOutcome(job) {
    try {
      return { ok: true, value: repository.get(job.reportId) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  function canonicalCompletedOutcome(job) {
    const outcome = repositoryReadOutcome(job)
    if (!outcome.ok) return outcome
    const report = outcome.value
    return {
      ok: true,
      value: report?.status === 'completed' &&
        report.runPhase === INTERACTIVE_SUMMARY_PHASE.COMPLETED
        ? report
        : null
    }
  }

  function reconcileLateCompletion(job) {
    if (!job.terminal) return false
    const outcome = repositoryReadOutcome(job)
    if (!outcome.ok) throw typed('SUMMARY_RUN_FAILED')
    const current = outcome.value
    if (current?.status === job.terminal.phase && current.runPhase === job.terminal.phase) {
      return true
    }
    return repository.update(job.reportId, {
      status: job.terminal.phase,
      runPhase: job.terminal.phase,
      errorText: job.terminal.code,
      updatedAt: now()
    })
  }

  async function settleCompleted(job, report, artifact) {
    if (job.canonicalCompletionPromise) return job.canonicalCompletionPromise
    job.completionCommitted = true
    job.terminal = null
    job.canonicalCompletionPromise = (async () => {
      job.phase = INTERACTIVE_SUMMARY_PHASE.COMPLETED
      job.report = report
      clearOwnedResources(job)
      const stopped = await stopOwnedSession(job)
      if (!stopped.ok) reportOperational(job)
      const finalized = await bounded(
        job,
        Promise.resolve().then(() => workspaceService.complete(job.reportId, {
          markdown: artifact.markdown
        }))
      )
      if (!finalized.ok || finalized.value?.cleanup?.ok === false) reportOperational(job)
      publish(report)
      active.delete(job.reportId)
      job.done.resolve(report)
      return report
    })()
    job.canonicalCompletionPromise.catch(() => {})
    return job.canonicalCompletionPromise
  }

  function claimTerminal(job, phase, code) {
    if (job.terminal) return job.terminal
    job.terminal = { phase, code }
    job.terminalSignal.resolve(job.terminal)
    clearOwnedResources(job)
    return job.terminal
  }

  async function finishTerminal(job, phase, code) {
    if (job.completionCommitted) return job.done.promise
    if (job.finishPromise) return job.finishPromise
    const terminal = claimTerminal(job, phase, code)
    phase = terminal.phase
    code = terminal.code
    job.finishPromise = (async () => {
      const error = typed(code)
      let report = null
      let databaseFailed = false
      let handedOff = false
      try {
        job.phase = phase
        if (job.repositoryCompletionOperation) {
          await bounded(job, job.repositoryCompletionOperation)
        }
        const completedBeforeTerminal = canonicalCompletedOutcome(job)
        if (!completedBeforeTerminal.ok) {
          databaseFailed = true
          reportOperational(job)
        } else if (completedBeforeTerminal.value) {
          handedOff = true
          return await settleCompleted(
            job,
            completedBeforeTerminal.value,
            job.completionArtifact
          )
        }
        if (job.repositoryOperation) await bounded(job, job.repositoryOperation)
        try {
          report = await repository.update(job.reportId, {
            status: phase,
            runPhase: phase,
            errorText: code,
            updatedAt: now()
          })
          job.report = report
        } catch {
          const completed = canonicalCompletedOutcome(job)
          if (completed.ok && completed.value) {
            handedOff = true
            return await settleCompleted(job, completed.value, job.completionArtifact)
          }
          databaseFailed = true
          reportOperational(job)
        }

        const cleanup = []
        if (job.workspace) {
          if (job.workspaceOperation) await bounded(job, job.workspaceOperation)
          cleanup.push(bounded(job, Promise.resolve().then(() => workspaceService.fail(
            job.reportId,
            code,
            { status: phase, stage: phase }
          ))))
        }
        if (job.sessionId) cleanup.push(stopOwnedSession(job))
        const outcomes = await Promise.all(cleanup)
        if (outcomes.some(outcome => !outcome.ok)) reportOperational(job)

        if (databaseFailed) {
          const safeError = typed('SUMMARY_RUN_FAILED')
          job.done.reject(safeError)
          throw safeError
        }
        publish(report, error)
        job.done.resolve(report)
        return report
      } finally {
        if (!handedOff) {
          clearOwnedResources(job)
          active.delete(job.reportId)
        }
      }
    })()
    job.finishPromise.catch(() => {})
    return job.finishPromise
  }

  async function finishCompleted(job, artifact) {
    if (job.completionPromise) return job.completionPromise
    job.completionPromise = (async () => {
      try {
        await transition(job, INTERACTIVE_SUMMARY_PHASE.VALIDATING)
        if (job.terminal) return job.done.promise
        job.completionArtifact = artifact
        const completionOperation = Promise.resolve().then(() => repository.complete(job.reportId, {
          markdown: artifact.markdown,
          sourceHash: artifact.sha256,
          usageSnapshot: job.preparation.usageSnapshot,
          coverage: job.preparation.coverage,
          artifactMetadata: {
            canonical: 'markdown',
            bytes: artifact.bytes,
            sha256: artifact.sha256
          },
          updatedAt: now()
        }))
        job.repositoryCompletionOperation = completionOperation
        completionOperation.then(
          () => {
            if (job.repositoryCompletionOperation === completionOperation) {
              job.repositoryCompletionOperation = null
            }
            if (job.terminal) compensate(job, () => reconcileLateCompletion(job))
          },
          () => {
            if (job.repositoryCompletionOperation === completionOperation) {
              job.repositoryCompletionOperation = null
            }
            if (job.terminal) compensate(job, () => reconcileLateCompletion(job))
          }
        )
        await ownedStep(job, () => completionOperation)
        const completed = canonicalCompletedOutcome(job)
        if (!completed.ok || !completed.value) throw typed('SUMMARY_RUN_FAILED')
        return settleCompleted(job, completed.value, artifact)
      } catch (error) {
        if (job.terminal) return job.done.promise
        return finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.FAILED, safeTerminalCode(error))
      }
    })()
    job.completionPromise.catch(() => {})
    return job.completionPromise
  }

  function acceptLifecycle(job, event) {
    if (job.terminal || job.completionCommitted) return
    if (['error', 'exit'].includes(event?.type)) {
      finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.FAILED, 'SUMMARY_RUN_FAILED').catch(() => {})
      return
    }
    if (event?.type === 'session_stopped') {
      finishTerminal(
        job,
        INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
        'SUMMARY_RUN_FAILED'
      ).catch(() => {})
      return
    }
    if (!['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event?.type)) return
    if (!job.turnId) {
      job.bufferedEvents.push(event)
      return
    }
    if (event.turnId !== job.turnId) return
    if (event.type === 'turn_failed') {
      finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.FAILED, 'SUMMARY_RUN_FAILED').catch(() => {})
    } else if (event.type === 'turn_interrupted') {
      finishTerminal(
        job,
        INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
        'SUMMARY_RUN_FAILED'
      ).catch(() => {})
    } else {
      schedule(job, 'missingTimer', limits.missingMs, () => {
        finishTerminal(
          job,
          INTERACTIVE_SUMMARY_PHASE.FAILED,
          'SUMMARY_ARTIFACT_MISSING'
        ).catch(() => {})
      })
    }
  }

  async function execute(job) {
    try {
      const started = await ownedStep(job, () => sessionRuntime.start(job.sessionId))
      if (started !== true) throw typed('SUMMARY_RUN_FAILED')
      await ownedStep(job, () => sessionRuntime.waitReady(job.sessionId, {
        timeoutMs: limits.readyMs
      }))
      await transition(job, INTERACTIVE_SUMMARY_PHASE.AWAITING_DELIVERY)

      job.unsubscribe = sessionRuntime.subscribe(job.sessionId, event => acceptLifecycle(job, event))
      const delivered = await ownedStep(job, () => sessionRuntime.deliver(job.sessionId, job.prompt, {
        timeoutMs: limits.deliveryMs
      }))
      job.turnId = delivered.turnId
      for (const event of job.bufferedEvents.splice(0)) acceptLifecycle(job, event)
      await transition(job, INTERACTIVE_SUMMARY_PHASE.RUNNING)

      const artifact = Promise.resolve(waitForArtifact({
        workspacePath: job.workspace.path,
        signal: job.abortController.signal,
        deadlineMs: job.deadlineMs
      })).then(
        value => ({ kind: 'artifact', value }),
        error => ({ kind: 'artifact-error', error })
      )
      const outcome = await Promise.race([
        artifact,
        job.terminalSignal.promise.then(() => ({ kind: 'terminal' }))
      ])
      if (outcome.kind === 'terminal') return job.done.promise
      if (outcome.kind === 'artifact') return finishCompleted(job, outcome.value)
      if (outcome.kind === 'artifact-error') {
        if (now() >= job.deadlineMs) {
          return finishTerminal(
            job,
            INTERACTIVE_SUMMARY_PHASE.FAILED,
            'SUMMARY_RUN_TIMEOUT'
          )
        }
        return finishTerminal(
          job,
          INTERACTIVE_SUMMARY_PHASE.FAILED,
          safeTerminalCode(outcome.error, 'SUMMARY_ARTIFACT_INVALID')
        )
      }
    } catch (error) {
      if (job.terminal) return job.done.promise
      return finishTerminal(
        job,
        INTERACTIVE_SUMMARY_PHASE.FAILED,
        safeTerminalCode(error)
      )
    }
  }

  async function start(request = {}) {
    const queued = await repository.createQueued({
      ...request,
      generatedBy: request.generatedBy || 'manual',
      executionMode: SUMMARY_EXECUTION_MODE.INTERACTIVE_CLI,
      runPhase: INTERACTIVE_SUMMARY_PHASE.PREPARING
    })
    const job = {
      reportId: queued.id,
      report: queued,
      workspace: null,
      preparation: null,
      phase: INTERACTIVE_SUMMARY_PHASE.PREPARING,
      sessionId: null,
      turnId: null,
      prompt: null,
      abortController: new AbortController(),
      bufferedEvents: [],
      terminalSignal: deferred(),
      terminal: null,
      done: deferred({ consumeRejection: true }),
      unsubscribe: null,
      totalTimer: null,
      missingTimer: null,
      cleanupTimers: new Set(),
      workspaceOperation: null,
      repositoryOperation: null,
      repositoryCompletionOperation: null,
      sessionConstruction: null,
      sessionBoundToReport: false,
      stopPromise: null,
      removePromise: null,
      projectionRemoved: false,
      deletionRequired: false,
      deletionPromise: null,
      finishPromise: null,
      completionPromise: null,
      canonicalCompletionPromise: null,
      completionArtifact: null,
      completionCommitted: false,
      operationalReported: false,
      deadlineMs: now() + limits.runMs
    }
    active.set(queued.id, job)
    schedule(job, 'totalTimer', limits.runMs, () => {
      finishTerminal(
        job,
        INTERACTIVE_SUMMARY_PHASE.FAILED,
        'SUMMARY_RUN_TIMEOUT'
      ).catch(() => {})
    })

    try {
      job.prompt = await ownedStep(job, () => buildPrompt({
        periodLabel: PERIOD_LABELS[queued.periodType]
      }))
      job.workspace = await ownedStep(
        job,
        () => workspaceService.create(queued.id),
        workspace => workspaceService.fail(
          queued.id,
          job.terminal?.code || 'SUMMARY_RUN_FAILED',
          {
            status: job.terminal?.phase || 'failed',
            stage: job.terminal?.phase || 'failed'
          }
        )
      )
      job.preparation = await ownedStep(
        job,
        () => preparationService.prepare({
          report: queued,
          workspace: job.workspace
        }),
        () => workspaceService.fail(
          queued.id,
          job.terminal?.code || 'SUMMARY_RUN_FAILED',
          {
            status: job.terminal?.phase || 'failed',
            stage: job.terminal?.phase || 'failed'
          }
        )
      )
      await transition(job, INTERACTIVE_SUMMARY_PHASE.STARTING)
      job.sessionConstruction = Promise.resolve().then(() => sessionRuntime.create({
        adapterId: request.executorId,
        profileId: request.profileId || null,
        ...(request.profileId ? {} : { profileSelection: 'system' }),
        ...(request.interactiveProfileSnapshot
          ? { interactiveProfileSnapshot: request.interactiveProfileSnapshot }
          : {}),
        model: request.model || null,
        name: `工作总结（${PERIOD_LABELS[queued.periodType]}）v${queued.version}`,
        cwd: job.workspace.workDirectory
      }))
      const created = await ownedStep(
        job,
        () => job.sessionConstruction,
        late => cleanLateCreatedSession(job, late)
      )
      job.sessionId = resultSessionId(created)
      job.report = await ownedStep(job, () => repository.update(queued.id, {
        sessionId: job.sessionId,
        updatedAt: now()
      }))
      job.sessionBoundToReport = job.report.sessionId === job.sessionId
      execute(job).catch(() => {})
      return {
        report: job.report,
        sessionId: job.sessionId,
        done: job.done.promise
      }
    } catch (error) {
      const code = job.terminal?.code || safeTerminalCode(error)
      if (!job.terminal) {
        await finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.FAILED, code).catch(() => {})
      } else {
        await job.done.promise.catch(() => {})
      }
      throw typed(code)
    }
  }

  async function cancel(reportId) {
    const job = active.get(reportId)
    if (!job) return false
    if (job.deletionPromise) return job.deletionPromise
    await finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.CANCELLED, 'SUMMARY_CANCELLED')
    return true
  }

  async function cancelForDeletion(reportId) {
    const job = active.get(reportId)
    if (!job) return false
    if (job.deletionPromise) return job.deletionPromise
    job.deletionRequired = true
    const awaitingConstruction = Boolean(job.sessionConstruction && !job.sessionId)
    if (awaitingConstruction) {
      claimTerminal(job, INTERACTIVE_SUMMARY_PHASE.CANCELLED, 'SUMMARY_CANCELLED')
    }
    const deleting = (async () => {
      try {
        if (awaitingConstruction) {
          const constructed = await bounded(job, job.sessionConstruction)
          if (constructed.timeout) throw typed('SUMMARY_DELETE_DRAIN_FAILED')
          if (constructed.ok) {
            const drained = await drainDeletionSession(job, resultSessionId(constructed.value))
            if (!drained.ok || drained.value !== true) {
              throw typed('SUMMARY_DELETE_DRAIN_FAILED')
            }
          }
        } else if (job.sessionId) {
          const drained = await drainDeletionSession(job)
          if (!drained.ok || drained.value !== true) throw typed('SUMMARY_DELETE_DRAIN_FAILED')
        }
        await finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.CANCELLED, 'SUMMARY_CANCELLED')
        if (active.has(reportId)) throw typed('SUMMARY_DELETE_DRAIN_FAILED')
        return true
      } finally {
        if (job.deletionPromise === deleting && active.has(reportId)) {
          job.deletionPromise = null
        }
      }
    })()
    job.deletionPromise = deleting
    return deleting
  }

  function isActive(reportId) {
    return active.has(reportId)
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function interruptAll(code) {
    const safeCode = safeInteractiveSummaryError(typed(code), 'SUMMARY_RUN_FAILED').code
    const jobs = [...active.values()]
    await Promise.all(jobs.map(job => job.deletionPromise || finishTerminal(
      job,
      INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
      safeCode
    )))
    return jobs.length
  }

  return Object.freeze({ start, cancel, cancelForDeletion, isActive, subscribe, interruptAll })
}
