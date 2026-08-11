import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

import {
  SUMMARY_PERIOD_TYPES,
  USAGE_GRANULARITIES,
  assertUsageQuery
} from './contracts.js'

dayjs.extend(utc)
dayjs.extend(timezone)

const HOUR_MS = 60 * 60 * 1000
const MAX_BUCKETS = 400
const ALL_PERIOD_TYPES = new Set([...USAGE_GRANULARITIES, ...SUMMARY_PERIOD_TYPES])

function resolveTimeZone(options = {}) {
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`)
  }
  return timeZone
}

function assertTimestamp(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite timestamp`)
}

function assertPeriodType(periodType, allowed = ALL_PERIOD_TYPES) {
  if (!allowed.has(periodType)) throw new Error(`Unsupported period type: ${periodType}`)
}

function localParts(value, timeZone) {
  const local = dayjs(value).tz(timeZone)
  return {
    year: local.year(),
    month: local.month(),
    date: local.date(),
    day: local.day(),
    hour: local.hour(),
    minute: local.minute(),
    second: local.second(),
    millisecond: local.millisecond()
  }
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0')
}

function localMidnight(year, month, date, timeZone) {
  const normalized = new Date(Date.UTC(year, month, date))
  const wallClock = [
    pad(normalized.getUTCFullYear(), 4),
    pad(normalized.getUTCMonth() + 1),
    pad(normalized.getUTCDate())
  ].join('-')
  return dayjs.tz(`${wallClock}T00:00:00.000`, timeZone).valueOf()
}

function shiftCalendarDate(parts, { days = 0, months = 0, years = 0 } = {}) {
  const value = new Date(Date.UTC(parts.year + years, parts.month + months, parts.date + days))
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth(),
    date: value.getUTCDate()
  }
}

function shiftBucketStart(start, periodType, amount, timeZone) {
  if (periodType === 'hour') return start + amount * HOUR_MS

  const parts = localParts(start, timeZone)
  let shifted
  if (periodType === 'day') shifted = shiftCalendarDate(parts, { days: amount })
  if (periodType === 'week') shifted = shiftCalendarDate(parts, { days: amount * 7 })
  if (periodType === 'month') shifted = shiftCalendarDate(parts, { months: amount })
  if (periodType === 'quarter') shifted = shiftCalendarDate(parts, { months: amount * 3 })
  if (periodType === 'year') shifted = shiftCalendarDate(parts, { years: amount })

  return localMidnight(shifted.year, shifted.month, shifted.date, timeZone)
}

export function bucketStart(value, periodType, options = {}) {
  assertTimestamp(value, 'value')
  assertPeriodType(periodType)
  const timeZone = resolveTimeZone(options)
  const parts = localParts(value, timeZone)

  if (periodType === 'hour') {
    return value -
      parts.minute * 60 * 1000 -
      parts.second * 1000 -
      parts.millisecond
  }

  if (periodType === 'day') {
    return localMidnight(parts.year, parts.month, parts.date, timeZone)
  }

  if (periodType === 'week') {
    const daysSinceMonday = (parts.day + 6) % 7
    const monday = shiftCalendarDate(parts, { days: -daysSinceMonday })
    return localMidnight(monday.year, monday.month, monday.date, timeZone)
  }

  if (periodType === 'month') {
    return localMidnight(parts.year, parts.month, 1, timeZone)
  }

  if (periodType === 'quarter') {
    return localMidnight(parts.year, Math.floor(parts.month / 3) * 3, 1, timeZone)
  }

  return localMidnight(parts.year, 0, 1, timeZone)
}

export function nextBucketStart(value, periodType, options = {}) {
  const timeZone = resolveTimeZone(options)
  const start = bucketStart(value, periodType, { timeZone })
  return shiftBucketStart(start, periodType, 1, timeZone)
}

export function enumerateBuckets(query) {
  const normalized = assertUsageQuery(query)
  const timeZone = resolveTimeZone({ timeZone: query.timeZone })
  const buckets = []
  let start = bucketStart(normalized.start, normalized.granularity, { timeZone })

  while (start < normalized.endExclusive) {
    if (buckets.length === MAX_BUCKETS) {
      throw new Error(`Usage queries are limited to ${MAX_BUCKETS} buckets`)
    }
    const endExclusive = nextBucketStart(start, normalized.granularity, { timeZone })
    if (endExclusive <= start) throw new Error('Calendar bucket did not advance')
    buckets.push({ start, endExclusive })
    start = endExclusive
  }

  return buckets
}

export function completedPeriod(periodType, now = Date.now(), options = {}) {
  assertTimestamp(now, 'now')
  assertPeriodType(periodType, new Set(SUMMARY_PERIOD_TYPES))
  const timeZone = resolveTimeZone(options)
  const endExclusive = bucketStart(now, periodType, { timeZone })
  const start = shiftBucketStart(endExclusive, periodType, -1, timeZone)
  return { periodType, start, endExclusive, partial: false, timeZone }
}

export function manualPeriod(periodType, selectedAt = Date.now(), options = {}) {
  assertTimestamp(selectedAt, 'selectedAt')
  assertPeriodType(periodType, new Set(SUMMARY_PERIOD_TYPES))
  const now = options.now ?? Date.now()
  assertTimestamp(now, 'now')
  const timeZone = resolveTimeZone(options)
  const start = bucketStart(selectedAt, periodType, { timeZone })
  const currentStart = bucketStart(now, periodType, { timeZone })

  if (start > currentStart) throw new Error('Cannot select a future period')

  const naturalEnd = shiftBucketStart(start, periodType, 1, timeZone)
  const partial = start === currentStart && now < naturalEnd
  return {
    periodType,
    start,
    endExclusive: partial ? now : naturalEnd,
    partial,
    timeZone
  }
}
