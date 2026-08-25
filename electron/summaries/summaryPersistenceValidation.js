import { createHash } from 'node:crypto'

import { redactEvidenceText } from './redaction.js'

const SAFE_HASH = /^(?:sha256:)?[a-f0-9]{64}$/
const MARKDOWN_HASH = /^sha256:[a-f0-9]{64}$/
const USAGE_ROOT_KEYS = new Set([
  'granularity', 'timezone', 'range', 'buckets', 'totals', 'legacyBaseline', 'exactSince'
])
const USAGE_METRIC_KEYS = new Set([
  'start', 'endExclusive', 'label', 'coveredStart', 'coveredEndExclusive', 'partial',
  'inputTokens', 'outputTokens', 'totalTokens', 'knownCostUsd', 'costUsd', 'costCoverage',
  'costAvailable', 'turns', 'activeSessions', 'approvals'
])
const COVERAGE_KEYS = new Set([
  'sessionsDiscovered', 'sessionsIncluded', 'sessionsMissing', 'messagesIncluded',
  'truncatedSessions', 'sources', 'warnings', 'redactions', 'legacyFormat'
])
const COVERAGE_COUNT_KEYS = new Set([
  'sessionsDiscovered', 'sessionsIncluded', 'sessionsMissing', 'messagesIncluded',
  'truncatedSessions'
])
const SOURCE_KEYS = new Set(['transcript', 'note', 'nativeDigest'])
const REDACTION_KEYS = new Set([
  'authorization', 'commonKey', 'privateKey', 'credentialUrl', 'namedValue'
])
const GENERATION_USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'costUsd'])
const GENERATION_METRIC_KEYS = new Set([
  'strategy', 'plannedCalls', 'aiCalls', 'cacheHits', 'durationMs', 'mapConcurrency'
])
const ARTIFACT_KEYS = new Set(['canonical', 'bytes', 'sha256'])

function validationError(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function absolutePath(value) {
  return typeof value === 'string' && (
    /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) || /^\/{1,2}/.test(value) ||
    /^file:\/\//i.test(value)
  )
}

function credentialScalar(value) {
  return typeof value === 'string' && redactEvidenceText(value).total > 0
}

function sensitiveKey(key, child, path) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()
  const numericTokenCounter = normalized.endsWith('tokens') && nonNegativeNumber(child)
  const allowedCoverageCount = path[0] === 'coverage' && (
    (path.length === 1 && COVERAGE_COUNT_KEYS.has(key)) ||
    (path[1] === 'sources' && key === 'transcript') || path[1] === 'redactions'
  ) && Number.isSafeInteger(child) && child >= 0
  return !numericTokenCounter && !allowedCoverageCount && (
    /(?:authorization|accesskey|credential|password|passphrase|secret|apikey|auth|evidence|prompt|transcript|message|toolpayload|rawoutput|rawmetadata|payload|command)/
      .test(normalized) || normalized.endsWith('path') || normalized.includes('token')
  )
}

function containsSensitiveContent(value, path = []) {
  if (typeof value === 'string') return absolutePath(value) || credentialScalar(value)
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((child, index) => containsSensitiveContent(child, [...path, index]))
  }
  return Object.entries(value).some(([key, child]) =>
    sensitiveKey(key, child, path) || containsSensitiveContent(child, [...path, key]))
}

function objectValue(value, field) {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  if (containsSensitiveContent(parsed, [field])) {
    throw validationError('SUMMARY_SENSITIVE_JSON_FORBIDDEN', 'Sensitive summary JSON is forbidden')
  }
  try { return JSON.parse(JSON.stringify(parsed)) } catch {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
}

function assertKeys(value, allowed) {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
}

function nonNegativeNumber(value, { nullable = false } = {}) {
  return (nullable && value === null) ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function validateUsageMetric(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  assertKeys(value, USAGE_METRIC_KEYS)
  for (const [key, child] of Object.entries(value)) {
    if (key === 'label') {
      if (typeof child !== 'string' || child.length > 160) {
        throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
      }
    } else if (key === 'partial' || key === 'costAvailable') {
      if (typeof child !== 'boolean') {
        throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
      }
    } else if (!nonNegativeNumber(child, { nullable: key === 'costCoverage' || key === 'costUsd' })) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
}

function validateUsageSnapshot(value) {
  assertKeys(value, USAGE_ROOT_KEYS)
  if (value.granularity !== undefined && !['hour', 'day', 'week', 'month'].includes(value.granularity)) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  if (value.timezone !== undefined && (
    typeof value.timezone !== 'string' || !value.timezone || value.timezone.length > 128
  )) throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  if (value.range !== undefined) {
    if (!value.range || typeof value.range !== 'object' || Array.isArray(value.range)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    assertKeys(value.range, new Set(['start', 'endExclusive']))
    if (Object.values(value.range).some(child => !nonNegativeNumber(child))) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
  if (value.buckets !== undefined) {
    if (!Array.isArray(value.buckets) || value.buckets.length > 400) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    value.buckets.forEach(validateUsageMetric)
  }
  if (value.totals !== undefined) validateUsageMetric(value.totals)
  if (value.exactSince !== undefined && !nonNegativeNumber(value.exactSince)) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  if (value.legacyBaseline !== undefined) {
    const baseline = value.legacyBaseline
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    assertKeys(baseline, new Set(['available', 'reason', 'metrics']))
    if (typeof baseline.available !== 'boolean' ||
      (baseline.reason !== undefined && typeof baseline.reason !== 'string')) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    if (baseline.metrics !== undefined && baseline.metrics !== null) {
      validateUsageMetric(baseline.metrics)
    }
  }
}

function validateCoverage(value) {
  assertKeys(value, COVERAGE_KEYS)
  for (const key of [
    'sessionsDiscovered', 'sessionsIncluded', 'sessionsMissing', 'messagesIncluded',
    'truncatedSessions'
  ]) {
    if (value[key] !== undefined && !Number.isSafeInteger(value[key])) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    if (value[key] < 0) throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  if (value.sources !== undefined) {
    if (!value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    assertKeys(value.sources, SOURCE_KEYS)
    if (Object.values(value.sources).some(child => !Number.isSafeInteger(child) || child < 0)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
  if (value.warnings !== undefined && (
    !Array.isArray(value.warnings) || value.warnings.length > 20 ||
    value.warnings.some(child => typeof child !== 'string' || child.length > 160)
  )) throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  if (value.redactions !== undefined) {
    if (!value.redactions || typeof value.redactions !== 'object' || Array.isArray(value.redactions)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
    assertKeys(value.redactions, REDACTION_KEYS)
    if (Object.values(value.redactions).some(child => !Number.isSafeInteger(child) || child < 0)) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
  if (value.legacyFormat !== undefined && typeof value.legacyFormat !== 'boolean') {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
}

function validateGenerationUsage(value) {
  assertKeys(value, GENERATION_USAGE_KEYS)
  for (const [key, child] of Object.entries(value)) {
    if (!nonNegativeNumber(child, { nullable: key === 'costUsd' })) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
}

function validateGenerationMetrics(value) {
  if (Object.keys(value).length === 0) return
  assertKeys(value, GENERATION_METRIC_KEYS)
  if (Object.keys(value).length !== GENERATION_METRIC_KEYS.size ||
    !['direct', 'map-reduce'].includes(value.strategy)) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
  for (const key of ['plannedCalls', 'aiCalls', 'cacheHits', 'durationMs', 'mapConcurrency']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
    }
  }
  if (value.mapConcurrency < 1 || value.mapConcurrency > 3) {
    throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  }
}

function validateArtifactMetadata(value) {
  if (Object.keys(value).length === 0) return
  assertKeys(value, ARTIFACT_KEYS)
  if (Object.keys(value).length !== ARTIFACT_KEYS.size || value.canonical !== 'markdown' ||
    !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
    typeof value.sha256 !== 'string' || !MARKDOWN_HASH.test(value.sha256)) {
    throw validationError('INVALID_SUMMARY_ARTIFACT_METADATA', 'Invalid summary artifact metadata')
  }
}

export function normalizeSummaryJsonField(value, field) {
  const parsed = objectValue(value ?? {}, field)
  if (field === 'usageSnapshot') validateUsageSnapshot(parsed)
  else if (field === 'coverage') validateCoverage(parsed)
  else if (field === 'generationUsage') validateGenerationUsage(parsed)
  else if (field === 'generationMetrics') validateGenerationMetrics(parsed)
  else if (field === 'artifactMetadata') validateArtifactMetadata(parsed)
  else throw validationError('INVALID_SUMMARY_JSON_SHAPE', 'Invalid summary JSON shape')
  return parsed
}

export function assertSafeSummaryHash(value) {
  if (typeof value !== 'string' || !SAFE_HASH.test(value)) {
    throw validationError('INVALID_SUMMARY_CANONICAL_REPORT', 'Invalid canonical summary report')
  }
  return value
}

export function normalizeCompletedArtifactMetadata(markdown, value) {
  const metadata = normalizeSummaryJsonField(value, 'artifactMetadata')
  const digest = typeof markdown === 'string'
    ? `sha256:${createHash('sha256').update(markdown).digest('hex')}`
    : null
  if (!metadata.canonical || metadata.bytes !== Buffer.byteLength(markdown || '', 'utf8') ||
    metadata.sha256 !== digest) {
    throw validationError('INVALID_SUMMARY_ARTIFACT_METADATA', 'Invalid summary artifact metadata')
  }
  return metadata
}
