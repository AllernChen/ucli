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
