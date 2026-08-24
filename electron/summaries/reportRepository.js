import { randomUUID } from 'node:crypto'
import {
  SUMMARY_EXECUTION_MODE,
  assertInteractiveSummaryPhase,
  isPersistedSummaryErrorText
} from './interactiveSummaryContracts.js'
import {
  assertSafeSummaryHash,
  normalizeCompletedArtifactMetadata,
  normalizeSummaryJsonField
} from './summaryPersistenceValidation.js'

const JSON_FIELDS = [
  'usageSnapshot', 'coverage', 'generationUsage', 'generationMetrics', 'artifactMetadata'
]
const STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  'awaiting_confirmation', 'skipped_empty'
])
const GENERATED_BY = new Set(['manual', 'automatic'])
const PERIOD_TYPES = new Set(['day', 'week', 'month', 'quarter', 'year'])
const PATCH_FIELDS = new Set([
  'status', 'markdown', 'executorId', 'profileId', 'model', 'usageSnapshot', 'coverage',
  'generationUsage', 'generationMetrics', 'generationCostUsd', 'promptVersion', 'sourceHash', 'generatedBy',
  'errorText', 'updatedAt', 'partial', 'sessionId', 'runPhase', 'artifactMetadata'
])
const EXECUTION_MODES = new Set(Object.values(SUMMARY_EXECUTION_MODE))

function repositoryError(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function jsonObject(value, field) {
  try {
    return normalizeSummaryJsonField(value, field)
  } catch (error) {
    if (error?.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN') throw error
    throw repositoryError('INVALID_SUMMARY_REPORT_JSON', 'Invalid summary JSON')
  }
}

function completedArtifactMetadata(markdown, value) {
  try {
    return normalizeCompletedArtifactMetadata(markdown, value)
  } catch {
    throw repositoryError(
      'INVALID_SUMMARY_ARTIFACT_METADATA',
      'Invalid summary artifact metadata'
    )
  }
}

function safeErrorText(value) {
  const normalized = value ?? null
  if (!isPersistedSummaryErrorText(normalized)) {
    throw repositoryError('INVALID_SUMMARY_ERROR_CODE', 'Invalid summary error code')
  }
  return normalized
}

function emptyArtifactMetadata(value) {
  let metadata
  try {
    metadata = normalizeSummaryJsonField(value ?? {}, 'artifactMetadata')
  } catch (error) {
    if (error?.code === 'SUMMARY_SENSITIVE_JSON_FORBIDDEN') throw error
    throw repositoryError(
      'INVALID_SUMMARY_ARTIFACT_METADATA',
      'Invalid summary artifact metadata'
    )
  }
  if (Object.keys(metadata).length !== 0) {
    throw repositoryError(
      'INVALID_SUMMARY_ARTIFACT_METADATA',
      'Invalid summary artifact metadata'
    )
  }
  return metadata
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
  normalized.executionMode = report.executionMode || SUMMARY_EXECUTION_MODE.ISOLATED_RUNNER
  normalized.sessionId = report.sessionId || null
  normalized.runPhase = report.runPhase || null
  normalized.legacyImportKey = report.legacyImportKey || null
  if (!EXECUTION_MODES.has(normalized.executionMode) ||
    (normalized.sessionId !== null && (
      typeof normalized.sessionId !== 'string' || !normalized.sessionId.trim()
    )) || (normalized.legacyImportKey !== null && (
      typeof normalized.legacyImportKey !== 'string' || !normalized.legacyImportKey.trim()
    ))) {
    throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report record')
  }
  if (normalized.runPhase !== null) assertInteractiveSummaryPhase(normalized.runPhase)
  normalized.errorText = safeErrorText(report.errorText)
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
    !GENERATED_BY.has(input.generatedBy) ||
    (input.executionMode !== undefined && !EXECUTION_MODES.has(input.executionMode)) ||
    (input.sessionId !== undefined && input.sessionId !== null &&
      (typeof input.sessionId !== 'string' || !input.sessionId.trim()))) {
    throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid queued summary report')
  }
  if (input.runPhase !== undefined && input.runPhase !== null) {
    assertInteractiveSummaryPhase(input.runPhase)
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw repositoryError('INVALID_SUMMARY_REPORT', 'Required summary value is missing')
  }
  return value
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
      const executionMode = input.executionMode || SUMMARY_EXECUTION_MODE.ISOLATED_RUNNER
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
        executionMode,
        sessionId: input.sessionId || null,
        runPhase: input.runPhase ?? (
          executionMode === SUMMARY_EXECUTION_MODE.INTERACTIVE_CLI ? 'preparing' : null
        ),
        artifactMetadata: {},
        legacyImportKey: null,
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
        throw repositoryError('SUMMARY_REPORT_FIELD_FORBIDDEN', 'Summary report field is not persistable')
      }
      const safe = { ...patch }
      if (safe.status !== undefined && !STATUSES.has(safe.status)) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report status')
      }
      if (safe.generatedBy !== undefined && !GENERATED_BY.has(safe.generatedBy)) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report origin')
      }
      if (safe.sessionId !== undefined && safe.sessionId !== null &&
        (typeof safe.sessionId !== 'string' || !safe.sessionId.trim())) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary session id')
      }
      if (safe.runPhase !== undefined && safe.runPhase !== null) {
        assertInteractiveSummaryPhase(safe.runPhase)
      }
      if (safe.errorText !== undefined) safe.errorText = safeErrorText(safe.errorText)
      for (const field of JSON_FIELDS) {
        if (safe[field] === undefined) continue
        safe[field] = field === 'generationMetrics'
          ? generationMetrics(safe[field], { allowEmpty: true })
          : field === 'artifactMetadata'
            ? emptyArtifactMetadata(safe[field])
            : jsonObject(safe[field], field)
      }
      return normalizeReport(db.updateSummaryReport(reportId, safe))
    },

    async complete(reportId, result = {}) {
      const markdown = requiredString(result.markdown, 'markdown')
      const sourceHash = assertSafeSummaryHash(result.sourceHash)
      const updatedAt = result.updatedAt ?? now()
      return normalizeReport(await db.completeSummaryReport(reportId, {
        status: 'completed',
        runPhase: 'completed',
        markdown,
        sourceHash,
        usageSnapshot: jsonObject(result.usageSnapshot ?? {}, 'usageSnapshot'),
        coverage: jsonObject(result.coverage ?? {}, 'coverage'),
        generationUsage: jsonObject(result.generationUsage ?? {}, 'generationUsage'),
        generationMetrics: generationMetrics(result.generationMetrics ?? {}, { allowEmpty: true }),
        generationCostUsd: result.generationCostUsd ?? null,
        promptVersion: result.promptVersion || null,
        artifactMetadata: completedArtifactMetadata(
          markdown,
          result.artifactMetadata
        ),
        errorText: null,
        updatedAt
      }))
    },

    async importCompleted(input) {
      const key = keyFilters(input)
      assertQueuedInput({
        ...input,
        generatedBy: input.generatedBy || 'manual',
        executionMode: SUMMARY_EXECUTION_MODE.LEGACY_WORKLOG_IMPORT
      }, key)
      const timestamp = input.createdAt ?? now()
      const result = await db.importCompletedSummaryReport({
        id: idFactory(),
        ...key,
        partial: input.partial === true,
        status: 'completed',
        markdown: requiredString(input.markdown, 'markdown'),
        executorId: input.executorId || null,
        profileId: input.profileId || null,
        model: input.model || null,
        usageSnapshot: jsonObject(input.usageSnapshot ?? {}, 'usageSnapshot'),
        coverage: jsonObject(input.coverage ?? {}, 'coverage'),
        generationUsage: jsonObject(input.generationUsage ?? {}, 'generationUsage'),
        generationMetrics: generationMetrics(input.generationMetrics ?? {}, { allowEmpty: true }),
        generationCostUsd: input.generationCostUsd ?? null,
        promptVersion: input.promptVersion || null,
        sourceHash: assertSafeSummaryHash(input.sourceHash),
        isCurrent: false,
        generatedBy: input.generatedBy || 'manual',
        errorText: null,
        executionMode: SUMMARY_EXECUTION_MODE.LEGACY_WORKLOG_IMPORT,
        sessionId: null,
        runPhase: 'completed',
        artifactMetadata: completedArtifactMetadata(
          input.markdown,
          input.artifactMetadata
        ),
        legacyImportKey: requiredString(input.legacyImportKey, 'legacyImportKey'),
        createdAt: timestamp,
        updatedAt: input.updatedAt ?? timestamp
      })
      return { report: normalizeReport(result.report), imported: result.imported }
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
