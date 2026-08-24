import {
  buildInteractiveSummaryPrompt,
  waitForCanonicalMarkdown
} from './interactiveSummaryArtifact.js'
import {
  INTERACTIVE_SUMMARY_PHASE,
  SUMMARY_EXECUTION_MODE,
  safeInteractiveSummaryError
} from './interactiveSummaryContracts.js'

const DEFAULT_TIMEOUTS = Object.freeze({
  readyMs: 60_000,
  deliveryMs: 12_000,
  runMs: 20 * 60_000,
  missingMs: 5_000
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

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
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
  timeouts = {}
} = {}) {
  for (const method of ['createQueued', 'update', 'complete', 'get']) {
    requireMethod(repository, method, 'repository')
  }
  for (const method of ['create', 'markStage', 'complete', 'fail']) {
    requireMethod(workspaceService, method, 'workspaceService')
  }
  requireMethod(preparationService, 'prepare', 'preparationService')
  for (const method of ['create', 'start', 'waitReady', 'deliver', 'subscribe', 'stop']) {
    requireMethod(sessionRuntime, method, 'sessionRuntime')
  }
  if (typeof buildPrompt !== 'function' || typeof waitForArtifact !== 'function' ||
    typeof now !== 'function' || typeof timers?.setTimeout !== 'function' ||
    typeof timers?.clearTimeout !== 'function') {
    throw new TypeError('Interactive summary job dependencies are required')
  }

  const limits = Object.freeze({
    readyMs: timeoutValue(timeouts.readyMs, DEFAULT_TIMEOUTS.readyMs),
    deliveryMs: timeoutValue(timeouts.deliveryMs, DEFAULT_TIMEOUTS.deliveryMs),
    runMs: timeoutValue(timeouts.runMs, DEFAULT_TIMEOUTS.runMs),
    missingMs: timeoutValue(timeouts.missingMs, DEFAULT_TIMEOUTS.missingMs)
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

  async function transition(job, phase, patch = {}) {
    if (!TRANSITIONS[job.phase]?.has(phase)) throw typed('SUMMARY_RUN_TRANSITION_INVALID')
    job.phase = phase
    const status = ['failed', 'interrupted', 'cancelled'].includes(phase) ? phase : 'running'
    const operation = job.persistPromise.then(async () => {
      const [report] = await Promise.all([
        repository.update(job.reportId, {
          status,
          runPhase: phase,
          ...patch,
          updatedAt: now()
        }),
        workspaceService.markStage(job.reportId, phase)
      ])
      job.report = report
      publish(report)
      return report
    })
    job.persistPromise = operation.catch(() => {})
    return operation
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

  async function cleanup(job) {
    clearJobTimer(job, 'totalTimer')
    clearJobTimer(job, 'missingTimer')
    job.abortController.abort()
    job.unsubscribe?.()
    job.unsubscribe = null
    if (job.sessionId && !job.stopPromise) {
      job.stopPromise = Promise.resolve(sessionRuntime.stop(job.sessionId)).catch(() => false)
    }
    await job.stopPromise
    active.delete(job.reportId)
  }

  async function finishTerminal(job, phase, code) {
    if (job.finishPromise) return job.finishPromise
    job.finishPromise = (async () => {
      const error = typed(code)
      let report
      try {
        await job.persistPromise
        job.phase = phase
        report = await repository.update(job.reportId, {
          status: phase,
          runPhase: phase,
          errorText: code,
          updatedAt: now()
        })
        job.report = report
        try {
          await workspaceService.fail(job.reportId, code, { status: phase, stage: phase })
        } catch {
          publish(report, typed('SUMMARY_RUN_FAILED'))
        }
        publish(report, error)
        return report
      } finally {
        await cleanup(job)
        job.done.resolve(report || repository.get(job.reportId))
      }
    })()
    return job.finishPromise
  }

  async function finishCompleted(job, artifact) {
    if (job.finishPromise) return job.finishPromise
    job.finishPromise = (async () => {
      let report
      try {
        await transition(job, INTERACTIVE_SUMMARY_PHASE.VALIDATING)
        report = await repository.complete(job.reportId, {
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
        })
        job.phase = INTERACTIVE_SUMMARY_PHASE.COMPLETED
        job.report = report
        try {
          await workspaceService.complete(job.reportId, { markdown: artifact.markdown })
        } catch {
          publish(report, typed('SUMMARY_RUN_FAILED'))
        }
        publish(report)
        return report
      } catch (error) {
        job.finishPromise = null
        return finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.FAILED, safeTerminalCode(error))
      } finally {
        if (report?.status === 'completed') {
          await cleanup(job)
          job.done.resolve(report)
        }
      }
    })()
    return job.finishPromise
  }

  function settleLifecycle(job, outcome) {
    if (!job.lifecycleOutcome) {
      job.lifecycleOutcome = outcome
      job.lifecycle.resolve(outcome)
    }
  }

  function acceptLifecycle(job, event) {
    if (job.finishPromise) return
    if (['error', 'exit'].includes(event?.type)) {
      settleLifecycle(job, { kind: 'failed', code: 'SUMMARY_RUN_FAILED' })
      return
    }
    if (event?.type === 'session_stopped') {
      settleLifecycle(job, { kind: 'interrupted', code: 'SUMMARY_RUN_FAILED' })
      return
    }
    if (!['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event?.type)) return
    if (!job.turnId) {
      job.bufferedEvents.push(event)
      return
    }
    if (event.turnId !== job.turnId) return
    if (event.type === 'turn_failed') {
      settleLifecycle(job, { kind: 'failed', code: 'SUMMARY_RUN_FAILED' })
    } else if (event.type === 'turn_interrupted') {
      settleLifecycle(job, { kind: 'interrupted', code: 'SUMMARY_RUN_FAILED' })
    } else {
      schedule(job, 'missingTimer', limits.missingMs, () => {
        settleLifecycle(job, { kind: 'failed', code: 'SUMMARY_ARTIFACT_MISSING' })
      })
    }
  }

  async function execute(job) {
    try {
      schedule(job, 'totalTimer', limits.runMs, () => {
        settleLifecycle(job, { kind: 'failed', code: 'SUMMARY_RUN_TIMEOUT' })
      })
      const started = await sessionRuntime.start(job.sessionId)
      if (job.finishPromise) return job.finishPromise
      if (started !== true) throw typed('SUMMARY_RUN_FAILED')
      await sessionRuntime.waitReady(job.sessionId, { timeoutMs: limits.readyMs })
      if (job.finishPromise) return job.finishPromise
      await transition(job, INTERACTIVE_SUMMARY_PHASE.AWAITING_DELIVERY)
      if (job.finishPromise) return job.finishPromise

      job.unsubscribe = sessionRuntime.subscribe(job.sessionId, event => acceptLifecycle(job, event))
      const delivered = await sessionRuntime.deliver(job.sessionId, job.prompt, {
        timeoutMs: limits.deliveryMs
      })
      if (job.finishPromise) return job.finishPromise
      job.turnId = delivered.turnId
      for (const event of job.bufferedEvents.splice(0)) acceptLifecycle(job, event)
      await transition(job, INTERACTIVE_SUMMARY_PHASE.RUNNING)
      if (job.finishPromise) return job.finishPromise

      const artifact = Promise.resolve(waitForArtifact({
        workspacePath: job.workspace.path,
        signal: job.abortController.signal,
        deadlineMs: job.deadlineMs
      })).then(
        value => ({ kind: 'artifact', value }),
        error => ({ kind: 'artifact-error', error })
      )
      const outcome = await Promise.race([artifact, job.lifecycle.promise])
      if (outcome.kind === 'artifact') return finishCompleted(job, outcome.value)
      if (outcome.kind === 'artifact-error') {
        if (job.finishPromise && outcome.error?.code === 'ABORT_ERR') return job.finishPromise
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
      return finishTerminal(job, outcome.kind, outcome.code)
    } catch (error) {
      if (job.finishPromise && error?.code === 'ABORT_ERR') return job.finishPromise
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
    const workspace = await workspaceService.create(queued.id)
    const preparation = await preparationService.prepare({ report: queued, workspace })
    const initial = {
      reportId: queued.id,
      report: queued,
      workspace,
      preparation,
      phase: INTERACTIVE_SUMMARY_PHASE.PREPARING,
      sessionId: null,
      turnId: null,
      prompt: buildPrompt({ periodLabel: PERIOD_LABELS[queued.periodType] }),
      abortController: new AbortController(),
      bufferedEvents: [],
      lifecycle: deferred(),
      lifecycleOutcome: null,
      done: deferred(),
      unsubscribe: null,
      totalTimer: null,
      missingTimer: null,
      stopPromise: null,
      finishPromise: null,
      persistPromise: Promise.resolve(),
      deadlineMs: now() + limits.runMs
    }
    await transition(initial, INTERACTIVE_SUMMARY_PHASE.STARTING)
    const created = await sessionRuntime.create({
      adapterId: request.executorId,
      profileId: request.profileId || null,
      model: request.model || null,
      name: `工作总结（${PERIOD_LABELS[queued.periodType]}）v${queued.version}`,
      cwd: workspace.workDirectory
    })
    initial.sessionId = resultSessionId(created)
    initial.report = await repository.update(queued.id, {
      sessionId: initial.sessionId,
      updatedAt: now()
    })
    active.set(queued.id, initial)
    void execute(initial)
    return {
      report: initial.report,
      sessionId: initial.sessionId,
      done: initial.done.promise
    }
  }

  async function cancel(reportId) {
    const job = active.get(reportId)
    if (!job) return false
    await finishTerminal(job, INTERACTIVE_SUMMARY_PHASE.CANCELLED, 'SUMMARY_CANCELLED')
    return true
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
    await Promise.all(jobs.map(job => finishTerminal(
      job,
      INTERACTIVE_SUMMARY_PHASE.INTERRUPTED,
      safeCode
    )))
    return jobs.length
  }

  return Object.freeze({ start, cancel, isActive, subscribe, interruptAll })
}
