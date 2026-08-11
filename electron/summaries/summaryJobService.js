import { createHash } from 'node:crypto'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
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

function terminal(status) {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(status)
}

export function createSummaryJobService({
  repository,
  evidenceCollector,
  snapshotUsage,
  pipeline,
  listSessions = () => [],
  defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
} = {}) {
  if (!repository) throw new TypeError('repository is required')
  if (!evidenceCollector?.collect) throw new TypeError('evidenceCollector.collect is required')
  if (typeof snapshotUsage !== 'function') throw new TypeError('snapshotUsage is required')
  if (!pipeline?.run) throw new TypeError('pipeline.run is required')

  repository.interruptStale()
  const listeners = new Set()
  const jobs = new Map()
  let queue = Promise.resolve()

  const publish = report => {
    for (const listener of listeners) {
      try { listener(report) } catch { /* subscribers cannot break jobs */ }
    }
    return report
  }
  const update = (reportId, patch, { notify = true } = {}) => {
    const report = repository.update(reportId, patch)
    return notify ? publish(report) : report
  }
  const finish = (job, report) => {
    jobs.delete(job.reportId)
    job.done.resolve(report)
    return report
  }
  const enqueue = work => {
    const result = queue.then(work, work)
    queue = result.catch(() => {})
    return result
  }

  const failJob = (job, error) => {
    if (job.cancelled) {
      const current = repository.get(job.reportId)
      if (current?.status === 'cancelled') return finish(job, current)
      return finish(job, update(job.reportId, {
        status: 'cancelled',
        errorText: 'SUMMARY_CANCELLED'
      }))
    }
    return finish(job, update(job.reportId, {
      status: 'failed',
      errorText: safeErrorCode(error)
    }))
  }

  const completePipeline = async (job, confirmed = false, confirmedCallLimit = null) => {
    const { request, context } = job
    const result = await pipeline.run({
      executorId: request.executorId,
      profileId: request.profileId,
      model: request.model,
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
      signal: job.controller.signal
    })
    if (job.cancelled) {
      throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
    }
    if (result?.requiresConfirmation) {
      job.confirmationCallLimit = result.confirmationCallLimit || result.estimatedCalls
      update(job.reportId, {
        status: 'awaiting_confirmation',
        errorText: 'SUMMARY_MANUAL_CONFIRMATION_REQUIRED'
      })
      return null
    }

    update(job.reportId, {
      status: 'completed',
      markdown: result.markdown,
      usageSnapshot: context.usageSnapshot,
      coverage: context.evidence.coverage || {},
      generationUsage: result.generationUsage || {},
      generationCostUsd: result.generationUsage?.costUsd ?? null,
      sourceHash: context.sourceHash,
      errorText: null
    }, { notify: false })
    const current = await repository.setCurrent(job.reportId)
    publish(current)
    return finish(job, current)
  }

  const runInitial = async job => {
    if (job.cancelled) return repository.get(job.reportId)
    update(job.reportId, { status: 'running', errorText: null })
    try {
      const request = job.request
      const evidence = await evidenceCollector.collect({
        sessions: await listSessions(),
        start: request.start,
        endExclusive: request.endExclusive,
        signal: job.controller.signal
      })
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
      const hash = sourceHash(evidence)
      update(job.reportId, {
        coverage: evidence.coverage || {},
        sourceHash: hash
      }, { notify: false })
      const usageSnapshot = await snapshotUsage({
        periodType: request.periodType,
        start: request.start,
        endExclusive: request.endExclusive,
        timezone: request.timezone
      })
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { code: 'SUMMARY_CANCELLED' })
      update(job.reportId, { usageSnapshot }, { notify: false })
      job.context = { evidence, usageSnapshot, sourceHash: hash }
      if (!evidence.blocks?.length) {
        return finish(job, update(job.reportId, {
          status: 'skipped_empty',
          errorText: 'SUMMARY_EMPTY_EVIDENCE'
        }))
      }
      if (request.generatedBy === 'automatic') {
        const duplicate = repository.findCompletedBySource(request, hash, job.reportId)
        if (duplicate) {
          return finish(job, update(job.reportId, {
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
    if (job.cancelled) return repository.get(job.reportId)
    update(job.reportId, { status: 'running', errorText: null })
    try {
      return await completePipeline(job, true, confirmationCallLimit)
    } catch (error) {
      return failJob(job, error)
    }
  }

  return {
    generate(input) {
      const request = { ...input, timezone: input.timezone || defaultTimezone }
      const queued = repository.createQueued(request)
      const job = {
        reportId: queued.id,
        request,
        controller: new AbortController(),
        cancelled: false,
        context: null,
        confirmationCallLimit: null,
        done: deferred()
      }
      jobs.set(job.reportId, job)
      publish(queued)
      enqueue(() => runInitial(job))
      return { reportId: job.reportId, completion: job.done.promise }
    },

    cancel(reportId) {
      const report = repository.get(reportId)
      if (!report || terminal(report.status)) return false
      const job = jobs.get(reportId)
      if (job) {
        job.cancelled = true
        job.controller.abort()
      }
      const cancelled = update(reportId, {
        status: 'cancelled',
        errorText: 'SUMMARY_CANCELLED'
      })
      if (job && ['queued', 'awaiting_confirmation'].includes(report.status)) finish(job, cancelled)
      return true
    },

    confirm(reportId, { confirmationCallLimit } = {}) {
      const job = jobs.get(reportId)
      const report = repository.get(reportId)
      if (!job || !job.context || report?.status !== 'awaiting_confirmation') {
        throw Object.assign(new Error('Confirmation context is unavailable'), {
          code: 'SUMMARY_CONFIRMATION_CONTEXT_MISSING'
        })
      }
      const limit = Number.isFinite(confirmationCallLimit)
        ? confirmationCallLimit
        : job.confirmationCallLimit
      publish(repository.update(reportId, { status: 'queued', errorText: null }))
      enqueue(() => runConfirmed(job, limit))
      return { reportId, completion: job.done.promise }
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener is required')
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
