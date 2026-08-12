const TYPED_CODE = /^[A-Z][A-Z0-9_]{2,80}$/

export function safeStartupFailure(phase, error) {
  const fallback = `${String(phase || 'application')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()}_STARTUP_FAILED`
  return {
    phase: String(phase || 'application'),
    code: typeof error?.code === 'string' && TYPED_CODE.test(error.code)
      ? error.code
      : fallback
  }
}

async function continueAfterFailure(phase, operation, onError) {
  try {
    await operation()
  } catch (error) {
    try { onError(safeStartupFailure(phase, error)) } catch { /* logging cannot block startup */ }
  }
}

export async function runSummaryStartupLifecycle({
  recoverWorkspaces = () => {}, maintainCache = () => {},
  interruptStaleJobs = () => {}, startScheduler = () => {}, onEvent = () => {}
} = {}) {
  for (const [phase, operation] of [
    ['workspace-recovery', recoverWorkspaces],
    ['cache-maintenance', maintainCache],
    ['stale-job-interruption', interruptStaleJobs],
    ['scheduler-catch-up', startScheduler]
  ]) await continueAfterFailure(phase, operation, onEvent)
}

function safeMaintenanceResult(value) {
  return {
    removed: Number.isSafeInteger(value?.removed) && value.removed >= 0 ? value.removed : 0,
    bytes: Number.isSafeInteger(value?.bytes) && value.bytes >= 0 ? value.bytes : 0
  }
}

export async function runSummaryMaintenance({
  quotaBytes,
  pruneExpiredWorkspaces = () => ({}),
  getWorkspaceUsage = () => ({ bytes: 0 }),
  pruneCache = () => ({}),
  getCacheUsage = () => ({ bytes: 0 }),
  pruneCompletedWorkspaces = () => ({}),
  onEvent = () => {}
} = {}) {
  if (Number.isSafeInteger(quotaBytes) && quotaBytes >= 0) {
    const result = { workspaces: null, cache: null, completed: null, total: null }
    try { result.workspaces = safeMaintenanceResult(await pruneExpiredWorkspaces()) } catch (error) {
      try { onEvent(safeStartupFailure('workspace-prune', error)) } catch { /* logging isolation */ }
    }
    let workspaceBytes = 0
    try { workspaceBytes = safeMaintenanceResult(await getWorkspaceUsage()).bytes } catch (error) {
      try { onEvent(safeStartupFailure('workspace-usage', error)) } catch { /* logging isolation */ }
    }
    try {
      result.cache = safeMaintenanceResult(await pruneCache(Math.max(0, quotaBytes - workspaceBytes)))
    } catch (error) {
      try { onEvent(safeStartupFailure('cache-prune', error)) } catch { /* logging isolation */ }
    }
    let cacheBytes = 0
    try { cacheBytes = safeMaintenanceResult(await getCacheUsage()).bytes } catch (error) {
      try { onEvent(safeStartupFailure('cache-usage', error)) } catch { /* logging isolation */ }
    }
    try {
      result.completed = safeMaintenanceResult(await pruneCompletedWorkspaces(
        Math.max(0, quotaBytes - cacheBytes)
      ))
      workspaceBytes = result.completed.bytes
    } catch (error) {
      try { onEvent(safeStartupFailure('completed-workspace-prune', error)) } catch { /* logging isolation */ }
    }
    const totalBytes = Math.min(Number.MAX_SAFE_INTEGER, workspaceBytes + cacheBytes)
    result.total = {
      bytes: totalBytes,
      quotaBytes,
      overQuotaBytes: Math.max(0, totalBytes - quotaBytes)
    }
    return result
  }
  const result = { workspaces: null, cache: null }
  for (const [phase, key, operation] of [
    ['workspace-prune', 'workspaces', pruneExpiredWorkspaces],
    ['cache-prune', 'cache', pruneCache]
  ]) {
    try {
      result[key] = safeMaintenanceResult(await operation())
    } catch (error) {
      try { onEvent(safeStartupFailure(phase, error)) } catch { /* logging cannot block maintenance */ }
    }
  }
  return result
}

export async function startMainWindowLifecycle({
  orchestrator,
  beforeWindow = () => {},
  openWindow,
  onError = () => {}
} = {}) {
  if (!orchestrator || typeof openWindow !== 'function') {
    throw new TypeError('orchestrator and openWindow are required')
  }
  await continueAfterFailure(
    'persistence',
    () => orchestrator.initPersistence(),
    onError
  )
  await continueAfterFailure(
    'gateway',
    () => orchestrator.startGateway(),
    onError
  )
  orchestrator.registerIpc()
  await continueAfterFailure('before-window', beforeWindow, onError)
  return openWindow()
}
