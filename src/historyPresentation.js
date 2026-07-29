export function mergeHistoryPage(current = [], page = {}) {
  const merged = []
  const positions = new Map()
  for (const item of [...(page.items || []), ...(current || [])]) {
    if (!item?.id) continue
    if (positions.has(item.id)) continue
    positions.set(item.id, merged.length)
    merged.push(item)
  }
  return merged
}

export function historyScrollTopAfterPrepend({
  previousScrollTop = 0,
  previousScrollHeight = 0,
  nextScrollHeight = 0
} = {}) {
  return Math.max(0, previousScrollTop + nextScrollHeight - previousScrollHeight)
}

export function shouldLoadOlderHistory({
  scrollTop = 0,
  loading = false,
  complete = false
} = {}) {
  return !loading && !complete && scrollTop <= 32
}

export function formatHistoryTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
