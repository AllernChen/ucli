import { assertUsageQuery } from './contracts.js'
import { bucketStart, enumerateBuckets, nextBucketStart } from './periods.js'

const DEFAULT_BUCKET_COUNTS = Object.freeze({ hour: 24, day: 30, week: 12, month: 12 })
const COARSER_GRANULARITY = Object.freeze({ hour: 'day', day: 'week', week: 'month', month: null })

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function dateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value)
  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

function labelFor(value, granularity, timeZone) {
  const { year, month, day } = dateParts(value, timeZone)
  if (granularity === 'month') return `${year}-${month}`
  if (granularity === 'hour') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    }).formatToParts(value).map(part => [part.type, part.value]))
    return `${year}-${month}-${day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`
  }
  return `${year}-${month}-${day}`
}

function emptyBucket(interval, granularity, timeZone, range) {
  const coveredStart = Math.max(interval.start, range.start)
  const coveredEndExclusive = Math.min(interval.endExclusive, range.endExclusive)
  return {
    ...interval,
    label: labelFor(interval.start, granularity, timeZone),
    coveredStart,
    coveredEndExclusive,
    partial: coveredStart !== interval.start || coveredEndExclusive !== interval.endExclusive,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    knownCostUsd: 0,
    costCoverage: null,
    turns: 0,
    activeSessions: 0,
    approvals: 0,
    _activeSessionIds: new Set(),
    _knownCostEvents: 0,
    _tokenUsageEvents: 0
  }
}

function addEvent(target, event) {
  target._activeSessionIds.add(event.sessionId)
  if (event.scope === 'approval') {
    target.approvals += event.approvals
    return
  }

  target.inputTokens += event.inputTokens
  target.outputTokens += event.outputTokens
  target.turns += event.turns
  if (event.costAvailable) target.knownCostUsd += event.costUsd || 0
  if (event.inputTokens + event.outputTokens > 0) {
    target._tokenUsageEvents += 1
    if (event.costAvailable) target._knownCostEvents += 1
  }
}

function finalizeMetric(metric) {
  metric.totalTokens = metric.inputTokens + metric.outputTokens
  metric.activeSessions = metric._activeSessionIds.size
  metric.costCoverage = metric._tokenUsageEvents > 0
    ? metric._knownCostEvents / metric._tokenUsageEvents
    : null
  delete metric._activeSessionIds
  delete metric._knownCostEvents
  delete metric._tokenUsageEvents
  return metric
}

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    knownCostUsd: 0,
    costCoverage: null,
    turns: 0,
    activeSessions: 0,
    approvals: 0,
    _activeSessionIds: new Set(),
    _knownCostEvents: 0,
    _tokenUsageEvents: 0
  }
}

function defaultRange(granularity, now, timeZone) {
  const count = DEFAULT_BUCKET_COUNTS[granularity]
  let start = bucketStart(now, granularity, { timeZone })
  const currentStart = start
  for (let index = 1; index < count; index += 1) {
    start = bucketStart(start - 1, granularity, { timeZone })
  }
  return {
    start,
    endExclusive: now,
    bucketEndExclusive: nextBucketStart(currentStart, granularity, { timeZone })
  }
}

function enumerateUsageBuckets(query) {
  try {
    return enumerateBuckets(query)
  } catch (error) {
    if (!/limited to 400 buckets/.test(error?.message || '')) throw error
    throw Object.assign(new RangeError(error.message), {
      code: 'TOO_MANY_BUCKETS',
      suggestedGranularity: COARSER_GRANULARITY[query.granularity]
    })
  }
}

function legacyBaseline(db, query) {
  if (query.models.length) {
    return {
      available: false,
      reason: 'MODEL_BREAKDOWN_UNAVAILABLE_BEFORE_EXACT_SINCE',
      metrics: null
    }
  }
  return {
    available: true,
    metrics: db.getLegacyUsageBaseline({
      projectPaths: query.projectPaths,
      adapterIds: query.adapterIds
    })
  }
}

export function createUsageQueryService({
  db,
  now = Date.now,
  defaultTimeZone = systemTimeZone()
} = {}) {
  if (!db) throw new TypeError('db is required')

  return {
    queryUsage(query) {
      const timeZone = query?.timeZone || defaultTimeZone
      const hasExplicitRange = Number.isFinite(query?.start) || Number.isFinite(query?.endExclusive)
      const range = hasExplicitRange
        ? { start: query?.start, endExclusive: query?.endExclusive, bucketEndExclusive: query?.endExclusive }
        : defaultRange(query?.granularity, now(), timeZone)
      const normalized = assertUsageQuery({ ...query, ...range, timeZone })
      const buckets = enumerateUsageBuckets({
        ...normalized,
        endExclusive: range.bucketEndExclusive
      })
        .map(interval => emptyBucket(interval, normalized.granularity, timeZone, normalized))
      const bucketByStart = new Map(buckets.map(bucket => [bucket.start, bucket]))
      const totals = emptyTotals()
      const events = db.queryUsageEvents(normalized)

      for (const event of events) {
        const start = bucketStart(event.observedAt, normalized.granularity, { timeZone })
        const bucket = bucketByStart.get(start)
        if (!bucket) continue
        addEvent(bucket, event)
        addEvent(totals, event)
      }

      return {
        granularity: normalized.granularity,
        timezone: timeZone,
        range: { start: normalized.start, endExclusive: normalized.endExclusive },
        buckets: buckets.map(finalizeMetric),
        totals: finalizeMetric(totals),
        legacyBaseline: legacyBaseline(db, normalized),
        exactSince: db.getUsageLedgerMetadata().exactSince
      }
    }
  }
}
