export function reconcileSessionPanes(currentPanes, count, resolveSessionId = () => null) {
  const panes = []
  for (let i = 0; i < count; i++) {
    panes.push(currentPanes[i] || {
      id: `pane-${i}`,
      sessionId: resolveSessionId(i) || null
    })
  }
  return {
    panes,
    removed: currentPanes.slice(count)
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
