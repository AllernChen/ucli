export function compactPaneSessionIds(paneSessionIds, omitIndex) {
  const remaining = paneSessionIds.filter((sessionId, index) => index !== omitIndex && sessionId)
  const splitCount = remaining.length >= 3 ? 4 : remaining.length >= 2 ? 2 : 1
  return {
    splitCount,
    paneSessionIds: remaining.length ? remaining : [null]
  }
}
