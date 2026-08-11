const PHASES = new Set([
  'queued', 'collecting', 'mapping', 'reducing', 'rendering',
  'awaiting_confirmation', 'completed', 'failed', 'cancelled',
  'interrupted', 'skipped_empty'
])
const CADENCES = new Set(['day', 'week', 'month', 'quarter', 'year'])
const EXECUTORS = new Set(['claude', 'codex', 'opencode', 'ucode'])
const TYPED_CODE = /^[A-Z][A-Z0-9_]{2,80}$/
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function safeSummaryErrorCode(value, fallback = null) {
  if (typeof value !== 'string') return fallback
  const candidate = value.slice(0, 81).split(':', 1)[0]
  return TYPED_CODE.test(candidate) ? candidate : fallback
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

export function createSummaryOperationalLogEntry(report, progress = null, {
  now = Date.now
} = {}) {
  const reportId = typeof report?.id === 'string' && REPORT_ID.test(report.id)
    ? report.id
    : 'unknown'
  const progressPhase = progress?.phase
  const phase = PHASES.has(progressPhase)
    ? progressPhase
    : PHASES.has(report?.status) ? report.status : 'collecting'
  const startedAt = Number(report?.createdAt)
  const currentTime = Number(now())
  return {
    reportId,
    phase,
    cadence: CADENCES.has(report?.periodType) ? report.periodType : 'unknown',
    executor: EXECUTORS.has(report?.executorId) ? report.executorId : 'unknown',
    elapsedMs: Number.isFinite(startedAt) && Number.isFinite(currentTime)
      ? Math.max(0, Math.floor(currentTime - startedAt))
      : 0,
    completedChunks: safeCount(progress?.completed),
    totalChunks: safeCount(progress?.total),
    code: safeSummaryErrorCode(report?.errorText)
  }
}
