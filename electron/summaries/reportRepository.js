import { randomUUID } from 'node:crypto'
import {
  SUMMARY_EXECUTION_MODE,
  assertInteractiveSummaryPhase,
  isPersistedSummaryErrorText,
  summaryAutomaticDuplicateReportId
} from './interactiveSummaryContracts.js'
import {
  assertSafeSummaryHash,
  normalizeCompletedArtifactMetadata,
  normalizeSummaryJsonField
} from './summaryPersistenceValidation.js'
import {
  buildSummaryTaskTitle,
  normalizeSummaryTaskMetadata
} from '../../shared/summaryTaskContracts.js'

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
  'errorText', 'updatedAt', 'partial', 'sessionId', 'runPhase', 'artifactMetadata', 'title', 'taskNote'
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

function persistedErrorText(value) {
  const normalized = value ?? null
  return isPersistedSummaryErrorText(normalized)
    ? normalized
    : 'SUMMARY_GENERATION_FAILED'
}

const LEGACY_USAGE_METRIC_FIELDS = new Set([
  'start', 'endExclusive', 'label', 'coveredStart', 'coveredEndExclusive', 'partial',
  'inputTokens', 'outputTokens', 'totalTokens', 'knownCostUsd', 'costUsd', 'costCoverage',
  'costAvailable', 'turns', 'activeSessions', 'approvals'
])
const PERSISTED_COVERAGE_FIELDS = new Set([
  'sessionsDiscovered', 'sessionsIncluded', 'sessionsMissing', 'messagesIncluded',
  'truncatedSessions', 'sources', 'warnings', 'redactions', 'legacyFormat'
])

function parsedObject(value) {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return null }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function pickObject(value, fields) {
  const object = parsedObject(value)
  if (!object) return {}
  return Object.fromEntries(Object.entries(object).filter(([key]) => fields.has(key)))
}

function projectPersistedJson(value, field) {
  const object = parsedObject(value)
  if (!object) return {}
  if (field === 'usageSnapshot') {
    const projected = pickObject(object, new Set([
      'granularity', 'timezone', 'range', 'buckets', 'totals', 'legacyBaseline', 'exactSince'
    ]))
    if (projected.range !== undefined) {
      projected.range = pickObject(projected.range, new Set(['start', 'endExclusive']))
    }
    if (Array.isArray(projected.buckets)) {
      projected.buckets = projected.buckets.map(bucket => pickObject(bucket, LEGACY_USAGE_METRIC_FIELDS))
    }
    if (projected.totals !== undefined) {
      projected.totals = pickObject(projected.totals, LEGACY_USAGE_METRIC_FIELDS)
    }
    if (projected.legacyBaseline !== undefined) {
      projected.legacyBaseline = pickObject(
        projected.legacyBaseline,
        new Set(['available', 'reason', 'metrics'])
      )
      if (projected.legacyBaseline.metrics !== undefined) {
        projected.legacyBaseline.metrics = pickObject(
          projected.legacyBaseline.metrics,
          LEGACY_USAGE_METRIC_FIELDS
        )
      }
    }
    const legacyTotals = pickObject(object, LEGACY_USAGE_METRIC_FIELDS)
    if (Object.keys(legacyTotals).length > 0 && projected.totals === undefined) {
      projected.totals = legacyTotals
    }
    return projected
  }
  if (field === 'coverage') {
    const projected = pickObject(object, PERSISTED_COVERAGE_FIELDS)
    if (projected.sources !== undefined) {
      projected.sources = pickObject(projected.sources, new Set(['transcript', 'note', 'nativeDigest']))
    }
    if (projected.redactions !== undefined) {
      projected.redactions = pickObject(projected.redactions, new Set([
        'authorization', 'commonKey', 'privateKey', 'credentialUrl', 'namedValue'
      ]))
    }
    return projected
  }
  if (field === 'generationUsage') {
    return pickObject(object, new Set(['inputTokens', 'outputTokens', 'costUsd']))
  }
  return {}
}

function persistedJsonObject(value, field) {
  try { return normalizeSummaryJsonField(value ?? {}, field) } catch {}
  try { return normalizeSummaryJsonField(projectPersistedJson(value, field), field) } catch { return {} }
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
  const fallbackTitle = buildSummaryTaskTitle({
    periodType: report.periodType,
    createdAt: report.createdAt,
    timezone: report.timezone
  })
  const metadata = normalizeSummaryTaskMetadata({
    title: report.title || fallbackTitle,
    taskNote: report.taskNote || ''
  })
  normalized.title = metadata.title
  normalized.taskNote = metadata.taskNote
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
  normalized.errorText = persistedErrorText(report.errorText)
  for (const field of JSON_FIELDS) {
    normalized[field] = field === 'generationMetrics'
      ? persistedGenerationMetrics(report[field] ?? {})
      : persistedJsonObject(report[field] ?? {}, field)
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

  function assertAutomaticDuplicateTarget(report, errorText) {
    const targetId = summaryAutomaticDuplicateReportId(errorText)
    if (!targetId) return
    const target = db.getSummaryReport(targetId)
    if (!report || !target || report.generatedBy !== 'automatic' ||
      !report.sourceHash || target.sourceHash !== report.sourceHash ||
      target.status !== 'completed' ||
      target.periodType !== report.periodType || target.periodStart !== report.periodStart ||
      target.periodEndExclusive !== report.periodEndExclusive || target.timezone !== report.timezone) {
      throw repositoryError('INVALID_SUMMARY_ERROR_CODE', 'Invalid summary error code')
    }
  }

  const listForKey = input => db.listSummaryReports(keyFilters(input)).map(normalizeReport)
  const repository = {
    async createQueued(input) {
      const key = keyFilters(input)
      assertQueuedInput(input, key)
      const timestamp = now()
      const executionMode = input.executionMode || SUMMARY_EXECUTION_MODE.ISOLATED_RUNNER
      return normalizeReport(await db.createQueuedSummaryReport({
        id: idFactory(),
        ...key,
        partial: input.partial === true,
        status: 'queued',
        title: buildSummaryTaskTitle({
          periodType: key.periodType,
          createdAt: timestamp,
          timezone: key.timezone
        }),
        taskNote: '',
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

    async updateTask(reportId, patch) {
      const metadata = normalizeSummaryTaskMetadata(patch)
      const result = await db.updateSummaryTask(reportId, { ...metadata, updatedAt: now() })
      return { ...result, report: normalizeReport(result.report) }
    },

    async update(reportId, patch = {}) {
      const forbidden = Object.keys(patch).find(field => !PATCH_FIELDS.has(field))
      if (forbidden) {
        throw repositoryError('SUMMARY_REPORT_FIELD_FORBIDDEN', 'Summary report field is not persistable')
      }
      const safe = { ...patch }
      if (safe.status !== undefined && !STATUSES.has(safe.status)) {
        throw repositoryError('INVALID_SUMMARY_REPORT', 'Invalid summary report status')
      }
      if (safe.status === 'completed' || safe.runPhase === 'completed') {
        throw repositoryError(
          'INVALID_SUMMARY_STATUS',
          'Completed summary reports require the dedicated completion path'
        )
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
      if (safe.errorText !== undefined) {
        safe.errorText = safeErrorText(safe.errorText)
      }
      for (const field of JSON_FIELDS) {
        if (safe[field] === undefined) continue
        safe[field] = field === 'generationMetrics'
          ? generationMetrics(safe[field], { allowEmpty: true })
          : field === 'artifactMetadata'
            ? emptyArtifactMetadata(safe[field])
            : jsonObject(safe[field], field)
      }
      const existing = db.getSummaryReport(reportId)
      if (existing && (safe.title !== undefined || safe.taskNote !== undefined)) {
        const current = normalizeReport(existing)
        const metadata = normalizeSummaryTaskMetadata({
          title: safe.title ?? current.title,
          taskNote: safe.taskNote ?? current.taskNote
        })
        if (safe.title !== undefined) safe.title = metadata.title
        if (safe.taskNote !== undefined) safe.taskNote = metadata.taskNote
      }
      const candidate = existing ? { ...existing, ...safe } : existing
      assertAutomaticDuplicateTarget(candidate, candidate?.errorText)
      return normalizeReport(await db.updateSummaryReport(reportId, safe))
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
        title: buildSummaryTaskTitle({
          periodType: key.periodType,
          createdAt: timestamp,
          timezone: key.timezone
        }),
        taskNote: '',
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

    async delete(reportId) {
      return await db.deleteSummaryReport(reportId)
    },

    findCompletedBySource(input, sourceHash, excludeId = null) {
      return listForKey(input).find(report =>
        report.id !== excludeId && report.status === 'completed' && report.sourceHash === sourceHash
      ) || null
    },

    async interruptStale() {
      const interrupted = []
      for (const status of ['queued', 'running', 'awaiting_confirmation']) {
        for (const report of repository.list({ status })) {
          interrupted.push(await repository.update(report.id, {
            status: 'interrupted',
            ...(report.executionMode === SUMMARY_EXECUTION_MODE.INTERACTIVE_CLI
              ? { runPhase: 'interrupted' }
              : {}),
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
