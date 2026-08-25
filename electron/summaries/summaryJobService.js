import { createHash } from 'node:crypto'

import { isPersistedSummaryErrorCode } from './interactiveSummaryContracts.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function safeErrorCode(error) {
  return isPersistedSummaryErrorCode(error?.code)
    ? error.code
    : 'SUMMARY_GENERATION_FAILED'
}

function sourceHash(evidence) {
  const hash = createHash('sha256')
  const blocks = [...(evidence?.blocks || [])].sort((left, right) => {
    const a = `${left?.projectPath || ''}\0${left?.id || ''}\0${left?.text || ''}`
    const b = `${right?.projectPath || ''}\0${right?.id || ''}\0${right?.text || ''}`
    return a.localeCompare(b)
  })
  for (const block of blocks) {
    hash.update(`${block?.id || ''}\0${block?.projectPath || ''}\0${block?.text || ''}\0`)
  }
  return `sha256:${hash.digest('hex')}`
}

function jsonArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function markdownArtifactMetadata(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw Object.assign(new TypeError('Invalid summary Markdown artifact'), {
      code: 'SUMMARY_ARTIFACT_INVALID'
    })
  }
  return {
    canonical: 'markdown',
    bytes: Buffer.byteLength(markdown),
    sha256: `sha256:${createHash('sha256').update(markdown).digest('hex')}`
  }
}

function evidenceArtifacts(evidence) {
  const projects = new Map()
  for (const block of evidence?.blocks || []) {
    const projectKey = createHash('sha256').update(String(block?.projectPath || '')).digest('hex')
    if (!projects.has(projectKey)) projects.set(projectKey, [])
    projects.get(projectKey).push({ text: String(block?.text || '') })
  }
  return [...projects.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([projectKey, blocks], index) => ({
      path: `input/project-${projectKey}-${String(index + 1).padStart(4, '0')}.json`,
      content: jsonArtifact({ blocks })
    }))
}

function terminal(status) {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(status)
}

function safePipelineProgress(event) {
  const phase = ['cache-check', 'collecting', 'mapping', 'reducing', 'rendering'].includes(event?.phase)
    ? event.phase
    : null
  if (!phase) return null
  const total = Number.isInteger(event?.total) && event.total > 0 ? event.total : 1
  const current = Number.isInteger(event?.current) && event.current >= 0 ? event.current : 0
  return { phase, completed: Math.min(current, total), total }
}

function safeGenerationMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const safe = {}
  if (['direct', 'map-reduce'].includes(value.strategy)) safe.strategy = value.strategy
  for (const field of ['plannedCalls', 'aiCalls', 'cacheHits']) {
    if (Number.isInteger(value[field])) safe[field] = Math.max(0, Math.min(1000, value[field]))
  }
  if (Number.isFinite(value.durationMs)) {
    safe.durationMs = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value.durationMs)))
  }
  if (Number.isInteger(value.mapConcurrency)) {
    safe.mapConcurrency = Math.max(1, Math.min(3, value.mapConcurrency))
  }
  return Object.keys(safe).length === 6 ? safe : {}
}

export function createSummaryJobService({
  repository,
  evidenceCollector,
  snapshotUsage,
  pipeline,
  workspaceService = null,
  listSessions = () => [],
  defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
} = {}) {
  if (!repository) throw new TypeError('repository is required')
  if (!evidenceCollector?.collect) throw new TypeError('evidenceCollector.collect is required')
  if (typeof snapshotUsage !== 'function') throw new TypeError('snapshotUsage is required')
  if (!pipeline?.run) throw new TypeError('pipeline.run is required')

  const listeners = new Set()
  const jobs = new Map()
  const admissions = new Set()
  let queue = Promise.resolve()
  let shuttingDown = false
  let shutdownPromise = null

  const publish = (report, progress = null) => {
    for (const listener of listeners) {
      try { listener(report, progress) } catch { /* subscribers cannot break jobs */ }
    }
    return report
  }
  const update = async (reportId, patch, { notify = true } = {}) => {
    const report = await repository.update(reportId, patch)
    return notify ? publish(report) : report
  }
  const finish = (job, report) => {
    jobs.delete(job.reportId)
    job.done.resolve(report)
    return report
  }
  const rejectJob = (job, error) => {
    jobs.delete(job.reportId)
    const failure = Object.assign(new Error('Summary generation failed'), {
      code: safeErrorCode(error)
    })
    job.done.reject(failure)
    return null
  }
  const enqueue = work => {
    const result = queue.then(work, work)
    queue = result.catch(() => {})
    return result
  }

  const settleWorkspaceUpdates = job => job.workspaceUpdates.catch(() => {})
  const completeWorkspace = async (job, outputs) => {
    const manifest = await workspaceService.complete(job.reportId, outputs)
    job.workspaceFinalized = 'completed'
    return manifest
  }
  const failWorkspace = async (job, code) => {
    if (!job.workspace || job.workspaceSettled || job.workspaceFinalized === 'failed') return
    await settleWorkspaceUpdates(job)
    try {
      await workspaceService.fail(job.reportId, code)
      job.workspaceFinalized = 'failed'
    } catch {
      // A failed workspace transition remains eligible for shutdown compensation.
    }
  }
  const markWorkspaceSettled = (job, finalizedAs) => {
    if (job.workspace && job.workspaceFinalized === finalizedAs) {
      job.workspaceSettled = true
    }
  }
  const failJob = async (job, error) => {
    await failWorkspace(
      job, job.cancelled ? 'SUMMARY_CANCELLED' : safeErrorCode(error)
    )
    try {
      let report
      if (job.cancelled) {
        const current = repository.get(job.reportId)
        report = current?.status === 'cancelled'
          ? current
          : await update(job.reportId, {
              status: 'cancelled',
              errorText: 'SUMMARY_CANCELLED'
            })
      } else {
        report = await update(job.reportId, {
          status: 'failed',
          errorText: safeErrorCode(error)
        })
      }
      markWorkspaceSettled(job, 'failed')
      return finish(job, report)
    } catch (persistenceError) {
      return rejectJob(job, persistenceError)
    }
  }

  const finalizeTerminal = async (job, outputs, persist) => {
    if (job.workspace) {
      await settleWorkspaceUpdates(job)
      await completeWorkspace(job, outputs)
    }
    if (job.cancelled) {
      throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
    }
    job.finishing = true
    const report = await persist()
    markWorkspaceSettled(job, 'completed')
    return finish(job, report)
  }

  const completePipeline = async (job, confirmed = false, confirmedCallLimit = null) => {
    const { request, context } = job
    const result = await pipeline.run({
      executorId: request.executorId,
      profileId: request.profileId,
      model: request.model,
      promptVersion: request.promptVersion || 'summary-v1',
      evidence: context.evidence,
      usage: context.usageSnapshot,
      period: {
        start: new Date(request.start).toISOString(),
        endExclusive: new Date(request.endExclusive).toISOString(),
        timezone: request.timezone
      },
      mode: request.generatedBy,
      confirmed,
      confirmedCallLimit,
      signal: job.controller.signal,
      workspaceDirectory: job.workspace?.workDirectory,
      onProgress(event) {
        const progress = safePipelineProgress(event)
        if (progress) {
          publish(repository.get(job.reportId), progress)
          if (job.workspace) {
            job.workspaceUpdates = job.workspaceUpdates
              .then(() => workspaceService.markStage(job.reportId, progress.phase, progress))
              .catch(() => {})
          }
        }
      }
    })
    if (job.cancelled) {
      throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
    }
    if (result?.requiresConfirmation) {
      job.confirmationCallLimit = result.confirmationCallLimit || result.estimatedCalls
      await update(job.reportId, {
        status: 'awaiting_confirmation',
        errorText: 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED'
      })
      return null
    }

    const artifactMetadata = markdownArtifactMetadata(result.markdown)
    return finalizeTerminal(job, { markdown: result.markdown }, async () => {
      const current = await repository.complete(job.reportId, {
        markdown: result.markdown,
        usageSnapshot: context.usageSnapshot,
        coverage: context.evidence.coverage || {},
        generationUsage: result.generationUsage || {},
        generationMetrics: safeGenerationMetrics(result.generationMetrics),
        generationCostUsd: result.generationUsage?.costUsd ?? null,
        promptVersion: request.promptVersion || 'summary-v1',
        sourceHash: context.sourceHash,
        artifactMetadata
      })
      return publish(current)
    })
  }

  const runInitial = async job => {
    if (job.cancelled) {
      const report = repository.get(job.reportId)
      return terminal(report?.status)
        ? finish(job, report)
        : rejectJob(job, { code: 'SUMMARY_CANCELLED' })
    }
    try {
      await update(job.reportId, { status: 'running', errorText: null })
      const request = job.request
      if (workspaceService) job.workspace = await workspaceService.create(job.reportId)
      const evidence = await evidenceCollector.collect({
        sessions: await listSessions(),
        start: request.start,
        endExclusive: request.endExclusive,
        signal: job.controller.signal
      })
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
      const hash = sourceHash(evidence)
      await update(job.reportId, {
        coverage: evidence.coverage || {},
        sourceHash: hash
      }, { notify: false })
      if (job.workspace) {
        await workspaceService.writeArtifact(job.reportId, 'input/period.json', jsonArtifact({
          periodType: request.periodType,
          start: new Date(request.start).toISOString(),
          endExclusive: new Date(request.endExclusive).toISOString(),
          timezone: request.timezone
        }))
        for (const artifact of evidenceArtifacts(evidence)) {
          await workspaceService.writeArtifact(job.reportId, artifact.path, artifact.content)
        }
      }
      const usageSnapshot = await snapshotUsage({
        periodType: request.periodType,
        start: request.start,
        endExclusive: request.endExclusive,
        timezone: request.timezone
      })
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
      await update(job.reportId, { usageSnapshot }, { notify: false })
      if (job.workspace) {
        await workspaceService.writeArtifact(
          job.reportId, 'input/usage.json', jsonArtifact(usageSnapshot)
        )
      }
      job.context = { evidence, usageSnapshot, sourceHash: hash }
      if (!evidence.blocks?.length) {
        return await finalizeTerminal(job, undefined, () => update(job.reportId, {
          status: 'skipped_empty',
          errorText: 'SUMMARY_EMPTY_EVIDENCE'
        }))
      }
      if (request.generatedBy === 'automatic') {
        const duplicate = repository.findCompletedBySource(request, hash, job.reportId)
        if (duplicate) {
          return await finalizeTerminal(job, undefined, () => update(job.reportId, {
            status: 'skipped_empty',
            errorText: `SUMMARY_AUTOMATIC_DUPLICATE:${duplicate.id}`
          }))
        }
      }
      return await completePipeline(job)
    } catch (error) {
      return failJob(job, error)
    }
  }

  const runConfirmed = async (job, confirmationCallLimit) => {
    if (job.cancelled) {
      const report = repository.get(job.reportId)
      return terminal(report?.status)
        ? finish(job, report)
        : rejectJob(job, { code: 'SUMMARY_CANCELLED' })
    }
    try {
      await update(job.reportId, { status: 'running', errorText: null })
      return await completePipeline(job, true, confirmationCallLimit)
    } catch (error) {
      return failJob(job, error)
    }
  }

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      await Promise.allSettled([...admissions])
      const active = [...jobs.values()]
      for (const job of active) {
        const report = repository.get(job.reportId)
        if (!report || terminal(report.status)) continue
        if (job.finishing) continue
        job.cancelled = true
        job.controller.abort()
        try {
          const cancelled = await update(job.reportId, {
            status: 'cancelled',
            errorText: 'SUMMARY_CANCELLED'
          })
          if (['queued', 'awaiting_confirmation'].includes(report.status)) {
            finish(job, cancelled)
          }
        } catch (error) {
          rejectJob(job, error)
        }
      }
      await Promise.allSettled(active.map(async job => {
        const settled = await job.done.promise
        if (job.workspace && ['failed', 'cancelled', 'interrupted'].includes(settled?.status)) {
          await failWorkspace(job, settled.errorText || 'SUMMARY_CANCELLED')
        }
      }))
    })().then(() => undefined)
    return shutdownPromise
  }

  return {
    async generate(input) {
      if (shuttingDown) {
        throw Object.assign(new Error('Summary service is shutting down'), {
          code: 'SUMMARY_SERVICE_SHUTTING_DOWN'
        })
      }
      const admission = (async () => {
        const request = { ...input, timezone: input.timezone || defaultTimezone }
        const queued = await repository.createQueued(request)
        if (shuttingDown) {
          await repository.update(queued.id, {
            status: 'cancelled',
            errorText: 'SUMMARY_CANCELLED'
          })
          throw Object.assign(new Error('Summary service is shutting down'), {
            code: 'SUMMARY_SERVICE_SHUTTING_DOWN'
          })
        }
        const job = {
          reportId: queued.id,
          request,
          controller: new AbortController(),
          cancelled: false,
          confirming: false,
          finishing: false,
          context: null,
          confirmationCallLimit: null,
          workspace: null,
          workspaceFinalized: null,
          workspaceSettled: false,
          workspaceUpdates: Promise.resolve(),
          done: deferred()
        }
        jobs.set(job.reportId, job)
        publish(queued)
        enqueue(() => runInitial(job))
        return { reportId: job.reportId, completion: job.done.promise }
      })()
      admissions.add(admission)
      try {
        return await admission
      } finally {
        admissions.delete(admission)
      }
    },

    async cancel(reportId) {
      const report = repository.get(reportId)
      if (!report || terminal(report.status)) return false
      const job = jobs.get(reportId)
      if (job?.finishing) {
        await job.done.promise
        return false
      }
      if (job) {
        job.cancelled = true
        job.controller.abort()
      }
      const cancelled = await update(reportId, {
        status: 'cancelled',
        errorText: 'SUMMARY_CANCELLED'
      })
      if (job && ['queued', 'awaiting_confirmation'].includes(report.status)) finish(job, cancelled)
      if (job) await job.done.promise
      return true
    },

    async confirm(reportId, { confirmationCallLimit } = {}) {
      const job = jobs.get(reportId)
      const report = repository.get(reportId)
      if (job?.confirming) {
        throw Object.assign(new Error('Summary confirmation is already in progress'), {
          code: 'SUMMARY_CONFIRMATION_IN_PROGRESS'
        })
      }
      if (!job || !job.context || report?.status !== 'awaiting_confirmation') {
        throw Object.assign(new Error('Confirmation context is unavailable'), {
          code: 'SUMMARY_CONFIRMATION_CONTEXT_MISSING'
        })
      }
      const limit = Number.isFinite(confirmationCallLimit)
        ? confirmationCallLimit
        : job.confirmationCallLimit
      job.confirming = true
      try {
        publish(await repository.update(reportId, { status: 'queued', errorText: null }))
      } catch (error) {
        job.confirming = false
        throw error
      }
      enqueue(async () => {
        try { return await runConfirmed(job, limit) } finally { job.confirming = false }
      })
      return { reportId, completion: job.done.promise }
    },

    getConfirmationCallLimit(reportId) {
      const job = jobs.get(reportId)
      const limit = job?.confirmationCallLimit
      return repository.get(reportId)?.status === 'awaiting_confirmation' &&
        Number.isInteger(limit) && limit > 0
        ? limit
        : null
    },

    isActive(reportId) {
      return jobs.has(reportId)
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener is required')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    shutdown
  }
}
