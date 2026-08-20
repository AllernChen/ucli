import { completedPeriod } from '../usage/periods.js'

export const SUMMARY_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000
export const SUMMARY_CADENCES = Object.freeze(['day', 'week', 'month', 'quarter', 'year'])
export const DEFAULT_SUMMARY_SETTINGS = Object.freeze({
  autoEnabled: false,
  autoPeriods: Object.freeze({
    day: true,
    week: true,
    month: false,
    quarter: false,
    year: false
  }),
  defaultExecutorId: null,
  defaultProfileId: null,
  defaultModel: null,
  firstEnableDisclosureAcceptedAt: null,
  automaticCallLimit: 20
})

const nullableString = value => typeof value === 'string' && value.trim() ? value.trim() : null

export function normalizeSummarySettings(value = {}) {
  const periods = value?.autoPeriods && typeof value.autoPeriods === 'object'
    ? value.autoPeriods
    : {}
  return {
    autoEnabled: typeof value.autoEnabled === 'boolean' ? value.autoEnabled : false,
    autoPeriods: Object.fromEntries(SUMMARY_CADENCES.map(periodType => [
      periodType,
      typeof periods[periodType] === 'boolean'
        ? periods[periodType]
        : DEFAULT_SUMMARY_SETTINGS.autoPeriods[periodType]
    ])),
    defaultExecutorId: nullableString(value.defaultExecutorId),
    defaultProfileId: nullableString(value.defaultProfileId),
    defaultModel: nullableString(value.defaultModel),
    firstEnableDisclosureAcceptedAt: Number.isFinite(value.firstEnableDisclosureAcceptedAt)
      ? value.firstEnableDisclosureAcceptedAt
      : null,
    automaticCallLimit: Number.isInteger(value.automaticCallLimit) &&
      value.automaticCallLimit >= 1 && value.automaticCallLimit <= 100
      ? value.automaticCallLimit
      : 20
  }
}

function settingsError(code, message) {
  return Object.assign(new Error(message), { code })
}

// Legacy helpers retained for the manual `summary:generate` validation path;
// automatic summaries no longer route through a headless executor.
export function profileProvidesSummaryAuthentication(profile, executorId) {
  const connectionMode = profile?.connectionMode || profile?.config?.connectionMode
  return executorId === 'claude' &&
    profile?.adapterId === executorId &&
    profile?.kind === 'managed' &&
    profile?.status === 'ready' &&
    ['api_key', 'bearer'].includes(connectionMode)
}

export function profileAvailableForSummary(profile, executorId, executorAuthenticated = false) {
  if (profileProvidesSummaryAuthentication(profile, executorId)) return true
  const connectionMode = profile?.connectionMode || profile?.config?.connectionMode
  return executorAuthenticated === true &&
    executorId === 'claude' &&
    profile?.adapterId === executorId &&
    profile?.kind === 'reference' &&
    profile?.status === 'ready' &&
    connectionMode === 'subscription'
}

export function updateSummarySettings(current = {}, patch = {}, {
  automationAvailable = true
} = {}) {
  const previous = normalizeSummarySettings(current)
  const next = normalizeSummarySettings({
    ...previous,
    ...patch,
    autoPeriods: { ...previous.autoPeriods, ...(patch?.autoPeriods || {}) }
  })
  if (next.defaultExecutorId !== previous.defaultExecutorId) {
    if (next.defaultProfileId === previous.defaultProfileId) next.defaultProfileId = null
    if (next.defaultModel === previous.defaultModel) next.defaultModel = null
  }
  if (next.autoEnabled) {
    if (!automationAvailable) {
      throw settingsError('SUMMARY_AUTOMATION_UNAVAILABLE', 'Automatic summaries require local persistence')
    }
    if (!next.firstEnableDisclosureAcceptedAt) {
      throw settingsError('SUMMARY_DISCLOSURE_REQUIRED', 'Automatic summaries require disclosure acceptance')
    }
  }
  return next
}

export function createLiveSummaryPipeline({ runner, getSettings, createPipeline } = {}) {
  if (typeof getSettings !== 'function') throw new TypeError('getSettings is required')
  if (typeof createPipeline !== 'function') throw new TypeError('createPipeline is required')
  return {
    run(options) {
      const { automaticCallLimit } = normalizeSummarySettings(getSettings())
      return createPipeline({ runner, automaticCallLimit }).run(options)
    }
  }
}

function matchesPeriod(report, request) {
  const start = report.periodStart ?? report.start
  const endExclusive = report.periodEndExclusive ?? report.endExclusive
  if (Number.isFinite(start) && start !== request.start) return false
  if (Number.isFinite(endExclusive) && endExclusive !== request.endExclusive) return false
  if (report.periodType && report.periodType !== request.periodType) return false
  if (report.timezone && report.timezone !== request.timezone) return false
  return true
}

export function createSummaryScheduler({
  getSettings,
  listReports,
  onReminder,
  maintain = () => ({}),
  onMaintenanceError = () => {},
  now = Date.now,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = SUMMARY_SCHEDULER_INTERVAL_MS
} = {}) {
  if (typeof getSettings !== 'function') throw new TypeError('getSettings is required')
  if (typeof listReports !== 'function') throw new TypeError('listReports is required')
  if (typeof onReminder !== 'function') throw new TypeError('onReminder is required')

  let timer = null
  let inFlight = null
  let stopped = false
  const scheduled = new Set()
  let lastMaintenanceDay = null

  const runMaintenance = async () => {
    const day = new Date(now()).toISOString().slice(0, 10)
    if (lastMaintenanceDay === day) return null
    lastMaintenanceDay = day
    try {
      return await maintain()
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
        ? error.code
        : 'SUMMARY_MAINTENANCE_FAILED'
      try { onMaintenanceError({ phase: 'daily-maintenance', code }) } catch { /* log isolation */ }
      return null
    }
  }

  const runTick = async () => {
    if (stopped) return []
    await runMaintenance()
    const settings = normalizeSummarySettings(await getSettings())
    if (!settings.autoEnabled || !settings.firstEnableDisclosureAcceptedAt) return []
    const reminded = []
    for (const periodType of SUMMARY_CADENCES) {
      if (stopped) break
      if (settings.autoPeriods?.[periodType] !== true) continue
      const period = completedPeriod(periodType, now(), { timeZone })
      const reminder = {
        periodType,
        start: period.start,
        endExclusive: period.endExclusive,
        timezone: timeZone
      }
      const periodKey = `${periodType}\0${period.start}\0${period.endExclusive}\0${timeZone}`
      if (scheduled.has(periodKey)) continue
      const reports = await listReports({
        periodType,
        periodStart: period.start,
        periodEndExclusive: period.endExclusive,
        timezone: timeZone
      })
      if (stopped) break
      if (reports.some(report => matchesPeriod(report, reminder) &&
        (report.isCurrent || ['completed', 'skipped_empty'].includes(report.status)))) {
        scheduled.add(periodKey)
        continue
      }
      scheduled.add(periodKey)
      try {
        await onReminder(reminder)
        reminded.push(reminder)
      } catch {
        // A reminder delivery failure must not block other cadences and is
        // not retried this run (the period stays in the `scheduled` set).
      }
    }
    return reminded
  }

  const tick = () => {
    if (inFlight) return inFlight
    inFlight = runTick().finally(() => { inFlight = null })
    return inFlight
  }

  return {
    async start() {
      stopped = false
      if (!timer) {
        timer = setIntervalFn(() => { void tick().catch(() => {}) }, intervalMs)
        timer?.unref?.()
      }
      return tick()
    },
    tick,
    async stop() {
      stopped = true
      if (timer) {
        clearIntervalFn(timer)
        timer = null
      }
      if (inFlight) await inFlight.catch(() => {})
    }
  }
}
