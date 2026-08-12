import { randomUUID } from 'node:crypto'

const JSON_FIELDS = ['usageSnapshot', 'coverage', 'generationUsage', 'generationMetrics']
const STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  'awaiting_confirmation', 'skipped_empty'
])
const GENERATED_BY = new Set(['manual', 'automatic'])
const PERIOD_TYPES = new Set(['day', 'week', 'month', 'quarter', 'year'])
const PATCH_FIELDS = new Set([
  'status', 'markdown', 'executorId', 'profileId', 'model', 'usageSnapshot', 'coverage',
  'generationUsage', 'generationMetrics', 'generationCostUsd', 'promptVersion', 'sourceHash', 'generatedBy',
  'errorText', 'updatedAt', 'partial'
])

function repositoryError(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function hasSensitiveJson(value, path = []) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((child, index) => hasSensitiveJson(child, [...path, index]))
  return Object.entries(value).some(([key, child]) => {
    const coverageTranscriptCount = path.length === 2 && path[0] === 'coverage' &&
      path[1] === 'sources' && key === 'transcript' &&
      typeof child === 'number' && Number.isFinite(child) && child >= 0
    return (!coverageTranscriptCount &&
      /^(?:evidence|prompt|raw(?:output|metadata)?|transcript|messages?)$/i.test(key)) ||
      hasSensitiveJson(child, [...path, key])
  })
}

function jsonObject(value, field) {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch {
      throw repositoryError('INVALID_SUMMARY_REPORT_JSON', `Invalid ${field} JSON`)
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw repositoryError('INVALID_SUMMARY_REPORT_JSON', `${field} must be a JSON object`)
  }
  if (hasSensitiveJson(parsed, [field])) {
    throw repositoryError('SUMMARY_SENSITIVE_JSON_FORBIDDEN', `${field} contains sensitive content`)
  }
  try {
    return JSON.parse(JSON.stringify(parsed))
  } catch {
    throw repositoryError('INVALID_SUMMARY_REPORT_JSON', `${field} must be serializable`)
  }
}

const METRIC_FIELDS = new Set([
  'strategy', 'plannedCalls', 'aiCalls', 'cacheHits', 'durationMs', 'mapConcurrency'
])

function generationMetrics(value, { allowEmpty = false } = {}) {
  let metrics
  try { metrics = jsonObject(value, 'generationMetrics') } catch {
    throw repositoryError('INVALID_SUMMARY_GENERATION_METRICS', 'Invalid summary generation metrics')
  }
  if (allowEmpty && Object.keys(metrics).length === 0) return metrics
  if (Object.keys(metrics).length !== METRIC_FIELDS.size ||
    Object.keys(metrics).some(key => !METRIC_FIELDS.has(key)) ||
    !['direct', 'map-reduce'].includes(metrics.strategy)) {
    throw repositoryError('INVALID_SUMMARY_GENERATION_METRICS', 'Invalid summary generation metrics')
  }
  for (const field of ['plannedCalls', 'aiCalls', 'cacheHits']) {
    if (!Number.isInteger(metrics[field]) || metrics[field] < 0 || metrics[field] > 1000) {
      throw repositoryError('INVALID_SUMMARY_GENERATION_METRICS', 'Invalid summary generation metrics')
    }
  }
  if (!Number.isSafeInteger(metrics.durationMs) || metrics.durationMs < 0 ||
    !Number.isInteger(metrics.mapConcurrency) || metrics.mapConcurrency < 1 || metrics.mapConcurrency > 3) {
    throw repositoryError('INVALID_SUMMARY_GENERATION_METRICS', 'Invalid summary generation metrics')
  }
  return metrics
}

function persistedGenerationMetrics(value) {
  try { return generationMetrics(value, { allowEmpty: true }) } catch { return {} }
}

function normalizeReport(report) {
  if (!report) return null
  if (!STATUSES.has(report.status) || !GENERATED_BY.has(report.generatedBy) ||
    !Number.isInteger(report.version) || report.version < 1) {
    throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report record')
  }
  const normalized = { ...report }
  for (const field of JSON_FIELDS) {
    normalized[field] = field === 'generationMetrics'
      ? persistedGenerationMetrics(report[field] ?? {})
      : jsonObject(report[field] ?? {}, field)
  }
  return normalized
}

function keyFilters(input) {
  return {
    periodType: input.periodType,
    periodStart: input.periodStart ?? input.start,
    periodEndExclusive: input.periodEndExclusive ?? input.endExclusive,
    timezone: input.timezone
  }
}

function assertQueuedInput(input, key) {
  if (!PERIOD_TYPES.has(key.periodType) || !Number.isInteger(key.periodStart) ||
    !Number.isInteger(key.periodEndExclusive) || key.periodStart >= key.periodEndExclusive ||
    typeof key.timezone !== 'string' || !key.timezone.trim() ||
    !GENERATED_BY.has(input.generatedBy)) {
    throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid queued summary report')
  }
}

export function summaryReportLogicalKey(input) {
  const key = keyFilters(input)
  return `${key.periodType}\0${key.periodStart}\0${key.periodEndExclusive}\0${key.timezone}`
}

export function createReportRepository({
  db,
  now = Date.now,
  idFactory = randomUUID
} = {}) {
  if (!db) throw new TypeError('db is required')

  const listForKey = input => db.listSummaryReports(keyFilters(input)).map(normalizeReport)
  const repository = {
    createQueued(input) {
      const key = keyFilters(input)
      assertQueuedInput(input, key)
      const version = listForKey(key).reduce((max, report) => Math.max(max, report.version), 0) + 1
      const timestamp = now()
      return normalizeReport(db.createSummaryReport({
        id: idFactory(),
        ...key,
        partial: input.partial === true,
        version,
        status: 'queued',
        markdown: null,
        executorId: input.executorId || null,
        profileId: input.profileId || null,
        model: input.model || null,
        usageSnapshot: {},
        coverage: {},
        generationUsage: {},
        generationMetrics: {},
        generationCostUsd: null,
        promptVersion: input.promptVersion || 'summary-v1',
        sourceHash: null,
        isCurrent: false,
        generatedBy: input.generatedBy,
        errorText: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }))
    },

    get(reportId) {
      return normalizeReport(db.getSummaryReport(reportId))
    },

    list(filters = {}) {
      return db.listSummaryReports(filters).map(normalizeReport)
    },

    listForKey,

    update(reportId, patch = {}) {
      const forbidden = Object.keys(patch).find(field => !PATCH_FIELDS.has(field))
      if (forbidden) {
        throw repositoryError('SUMMARY_REPORT_FIELD_FORBIDDEN', `Cannot persist ${forbidden}`)
      }
      const safe = { ...patch }
      if (safe.status !== undefined && !STATUSES.has(safe.status)) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report status')
      }
      if (safe.generatedBy !== undefined && !GENERATED_BY.has(safe.generatedBy)) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report origin')
      }
      for (const field of JSON_FIELDS) {
        if (safe[field] !== undefined) safe[field] = field === 'generationMetrics'
          ? generationMetrics(safe[field], { allowEmpty: true })
          : jsonObject(safe[field], field)
      }
      return normalizeReport(db.updateSummaryReport(reportId, safe))
    },

    async setCurrent(reportId) {
      return normalizeReport(await db.setCurrentSummaryReport(reportId))
    },

    delete(reportId) {
      return db.deleteSummaryReport(reportId)
    },

    findCompletedBySource(input, sourceHash, excludeId = null) {
      return listForKey(input).find(report =>
        report.id !== excludeId && report.status === 'completed' && report.sourceHash === sourceHash
      ) || null
    },

    interruptStale() {
      const interrupted = []
      for (const status of ['queued', 'running', 'awaiting_confirmation']) {
        for (const report of repository.list({ status })) {
          interrupted.push(repository.update(report.id, {
            status: 'interrupted',
            errorText: 'SUMMARY_PROCESS_RESTARTED',
            updatedAt: now()
          }))
        }
      }
      return interrupted
    }
  }
  return repository
}
