function counter(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function timestamp(value, fallback) {
  const candidate = Number.isFinite(value) ? value : fallback
  if (!Number.isFinite(candidate)) {
    throw Object.assign(new TypeError('Usage observation requires a timestamp'), {
      code: 'INVALID_USAGE_TIMESTAMP'
    })
  }
  return Math.trunc(candidate)
}

function requiredIdentity(value, label, code) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw Object.assign(new TypeError(`${label} is required`), { code })
  return normalized
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedCost(source) {
  if (source?.costAvailable === false) return { costUsd: null, costAvailable: false }
  if (!Number.isFinite(source?.costUsd) || source.costUsd < 0) {
    return { costUsd: null, costAvailable: false }
  }
  return { costUsd: source.costUsd, costAvailable: true }
}

function totalSource(update) {
  const totals = update?.totals && typeof update.totals === 'object'
    ? update.totals
    : update
  const usage = totals?.usage && typeof totals.usage === 'object'
    ? totals.usage
    : (update?.usage && typeof update.usage === 'object' ? update.usage : totals)
  return { totals, usage }
}

function firstFinite(...values) {
  return values.find((value) => Number.isFinite(value))
}

function counterOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : counter(fallback)
}

/** Normalize adapter emissions before the orchestrator updates in-memory UI state. */
export function normalizeAdapterStatsEvent(event, currentStats = {}) {
  const nestedUsage = event?.usage && typeof event.usage === 'object' ? event.usage : {}
  const inputTokens = firstFinite(nestedUsage.inputTokens, event?.inputTokens)
  const outputTokens = firstFinite(nestedUsage.outputTokens, event?.outputTokens)
  const turns = firstFinite(event?.turns, event?.turnsCount)
  const completedTurns = firstFinite(event?.completedTurns, event?.completedTurnsCount)
  const model = optionalString(event?.model) || optionalString(event?.lastModel)
  return {
    ...event,
    usage: {
      ...nestedUsage,
      inputTokens: counterOr(inputTokens, currentStats?.tokens?.input),
      outputTokens: counterOr(outputTokens, currentStats?.tokens?.output)
    },
    turns: counterOr(turns, currentStats?.turns),
    completedTurns: Number.isFinite(completedTurns) ? counter(completedTurns) : undefined,
    model
  }
}

/**
 * Convert both live adapter events and parser-style cumulative statistics to
 * the explicit persistence scopes used by the usage ledger.
 */
export function normalizeUsageUpdate(update, fallbackObservedAt) {
  const sessionId = requiredIdentity(update?.sessionId, 'sessionId', 'INVALID_USAGE_SESSION')
  const adapterId = requiredIdentity(update?.adapterId, 'adapterId', 'INVALID_USAGE_ADAPTER')
  const projectPath = optionalString(update?.projectPath ?? update?.cwd)
  const observedAt = timestamp(update?.observedAt, fallbackObservedAt)
  const { totals, usage } = totalSource(update)
  const totalCost = normalizedCost({
    costUsd: totals?.costUsd ?? update?.costUsd,
    costAvailable: totals?.costAvailable ?? update?.costAvailable
  })
  const turns = firstFinite(
    totals?.turns,
    totals?.turnsCount,
    totals?.turnsDelta,
    update?.turns,
    update?.turnsCount,
    update?.turnsDelta
  )
  const common = { sessionId, projectPath, adapterId, observedAt }
  const session = {
    ...common,
    scope: 'session',
    model: null,
    inputTokens: counter(firstFinite(usage?.inputTokens, totals?.inputTokens, update?.inputTokens)),
    outputTokens: counter(firstFinite(usage?.outputTokens, totals?.outputTokens, update?.outputTokens)),
    ...totalCost,
    turns: counter(turns)
  }

  const breakdown = Array.isArray(update?.models)
    ? update.models
    : (Array.isArray(update?.modelBreakdown) ? update.modelBreakdown : [])
  const models = breakdown.map((modelUsage) => {
    const modelCost = normalizedCost(modelUsage)
    return {
      ...common,
      scope: 'model',
      model: optionalString(modelUsage?.model) || 'unknown',
      inputTokens: counter(modelUsage?.inputTokens),
      outputTokens: counter(modelUsage?.outputTokens),
      ...modelCost,
      // Turns belong only to the session total. Keeping model turns at zero
      // prevents an unfiltered trend from counting the same turn twice.
      turns: 0
    }
  })

  return { observedAt, session, models }
}

function stableApprovalId(approval) {
  return optionalString(approval?.approvalId) ||
    optionalString(approval?.decisionId) ||
    optionalString(approval?.requestId)
}

export function createUsageRecorder({ db, now = Date.now }) {
  if (!db || typeof db.observeUsage !== 'function') {
    throw new TypeError('Usage recorder requires a usage-ledger database')
  }
  let tail = Promise.resolve()

  function enqueue(work) {
    const result = tail.then(work, work)
    tail = result.catch(() => {})
    return result
  }

  return {
    observe(update) {
      // Capture occurrence time when the update enters the recorder, not when
      // an earlier queued transaction happens to finish.
      const normalized = normalizeUsageUpdate(update, now())
      return enqueue(async () => {
        const session = await db.observeUsage(normalized.session)
        const models = []
        for (const model of normalized.models) {
          models.push(await db.observeUsage(model))
        }
        return { observedAt: normalized.observedAt, session, models }
      })
    },

    recordApproval(approval) {
      if (typeof db.recordApproval !== 'function') {
        return Promise.reject(new TypeError('Usage-ledger database cannot record approvals'))
      }
      const approvalId = stableApprovalId(approval)
      if (!approvalId) {
        return Promise.reject(Object.assign(
          new TypeError('A stable approval decision ID is required'),
          { code: 'INVALID_APPROVAL_ID' }
        ))
      }
      const normalized = {
        approvalId,
        sessionId: requiredIdentity(approval?.sessionId, 'sessionId', 'INVALID_USAGE_SESSION'),
        projectPath: optionalString(approval?.projectPath ?? approval?.cwd),
        adapterId: requiredIdentity(approval?.adapterId, 'adapterId', 'INVALID_USAGE_ADAPTER'),
        model: optionalString(approval?.model),
        observedAt: timestamp(approval?.observedAt, now())
      }
      return enqueue(() => db.recordApproval(normalized))
    }
  }
}
