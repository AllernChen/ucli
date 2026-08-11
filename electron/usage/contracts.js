export const USAGE_GRANULARITIES = Object.freeze(['hour', 'day', 'week', 'month'])
export const SUMMARY_PERIOD_TYPES = Object.freeze(['day', 'week', 'month', 'quarter', 'year'])

function uniqueStrings(value, field) {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return [...new Set(value)]
}

function optionalTimeZone(value) {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new Error('Invalid time zone')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
  } catch {
    throw new Error(`Invalid time zone: ${value}`)
  }
  return value
}

export function assertUsageQuery(query) {
  if (!query || typeof query !== 'object') throw new Error('Usage query is required')
  if (!USAGE_GRANULARITIES.includes(query.granularity)) {
    throw new Error('Unsupported granularity')
  }
  if (
    !Number.isFinite(query.start) ||
    !Number.isFinite(query.endExclusive) ||
    query.start >= query.endExclusive
  ) {
    throw new Error('Invalid time range')
  }

  const normalized = {
    granularity: query.granularity,
    start: query.start,
    endExclusive: query.endExclusive,
    projectPaths: uniqueStrings(query.projectPaths, 'projectPaths'),
    adapterIds: uniqueStrings(query.adapterIds, 'adapterIds'),
    models: uniqueStrings(query.models, 'models')
  }
  const timeZone = optionalTimeZone(query.timeZone)
  if (timeZone) normalized.timeZone = timeZone
  return normalized
}
