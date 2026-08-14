import { deriveSessionCapabilityState } from './sessionMaintenancePresentation.js'

export function createPaneAssignmentGuard() {
  const epochs = new Map()
  return {
    begin(paneIndex, sessionId) {
      const epoch = (epochs.get(paneIndex) || 0) + 1
      epochs.set(paneIndex, epoch)
      return { paneIndex, sessionId, epoch }
    },
    invalidate(paneIndex) {
      epochs.set(paneIndex, (epochs.get(paneIndex) || 0) + 1)
    },
    isCurrent(token, panes) {
      return Boolean(
        token && epochs.get(token.paneIndex) === token.epoch &&
        panes?.[token.paneIndex]?.sessionId === token.sessionId
      )
    }
  }
}

export function reconcileSessionPanes(currentPanes, count, resolveSessionId = () => null) {
  const panes = []
  for (let i = 0; i < count; i++) {
    const current = currentPanes[i]
    const savedSessionId = resolveSessionId(i) || null
    panes.push(current
      ? (!current.sessionId && savedSessionId ? { ...current, sessionId: savedSessionId } : current)
      : { id: `pane-${i}`, sessionId: savedSessionId })
  }
  return {
    panes,
    removed: currentPanes.slice(count)
  }
}

export async function activatePaneSession(session, paneIndex, {
  restartSession,
  startSession = async () => {},
  attachSession
}) {
  if (!session) return false
  const capabilities = deriveSessionCapabilityState(session)
  if (!capabilities.known) return false
  if (session.status === 'offline') {
    await restartSession(session.id, paneIndex)
    return true
  }
  if (session.status === 'starting') {
    await startSession(session.id, paneIndex)
    return true
  }
  if (capabilities.terminal) {
    await attachSession(session.id, paneIndex)
    return true
  }
  return false
}

export async function restoreAssignedPaneSessions(panes, {
  getSession,
  restartSession,
  startSession,
  attachSession,
  onError = () => {}
}) {
  for (const pane of panes) {
    const session = getSession(pane.sessionId)
    if (!session) continue
    try {
      await activatePaneSession(session, pane.paneIndex, {
        restartSession,
        startSession: startSession || attachSession,
        attachSession
      })
    } catch (error) {
      onError(error, pane)
    }
  }
}

export async function toggleElementFullscreen(documentRef, element) {
  if (!documentRef.fullscreenElement) {
    if (!element?.requestFullscreen) return false
    await element.requestFullscreen()
    return true
  }
  if (documentRef.exitFullscreen) await documentRef.exitFullscreen()
  return false
}

export function resolveWorkbenchFullscreenTarget(fullscreenElement, gridElement, paneRoots) {
  if (fullscreenElement && fullscreenElement === gridElement) {
    return { grid: true, paneIndex: null }
  }
  const paneKey = Object.keys(paneRoots).find((key) => paneRoots[key] === fullscreenElement)
  const paneIndex = paneKey === undefined ? null : Number(paneKey)
  return { grid: false, paneIndex }
}

export function resolveSessionFocusPane(panes, sessionId, activePane = 0) {
  const existing = panes.findIndex((pane) => pane.sessionId === sessionId)
  if (existing >= 0) return existing
  const empty = panes.findIndex((pane) => !pane.sessionId)
  if (empty >= 0) return empty
  return activePane >= 0 && activePane < panes.length ? activePane : 0
}
