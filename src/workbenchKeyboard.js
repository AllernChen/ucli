export function nextSessionPaneIndex(panes, activeIndex, direction = 1) {
  const assigned = []
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]?.sessionId) assigned.push(i)
  }
  if (!assigned.length) return null
  if (assigned.length === 1) return assigned[0] === activeIndex ? null : assigned[0]

  const current = assigned.indexOf(activeIndex)
  if (current < 0) return direction < 0 ? assigned.at(-1) : assigned[0]
  return assigned[(current + (direction < 0 ? -1 : 1) + assigned.length) % assigned.length]
}

export function targetPaneForSessionAddition(panes, splitCount) {
  const paneIndex = panes.findIndex((pane) => !pane?.sessionId)
  if (paneIndex >= 0) return { paneIndex, splitCount }

  return {
    paneIndex: -1,
    splitCount: splitCount === 1 ? 2 : 4,
  }
}
