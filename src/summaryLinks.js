export function openSummaryReportLink(event, openExternal) {
  const anchor = event?.target?.closest?.('a[href]')
  if (!anchor) return false
  event.preventDefault()
  const url = anchor.getAttribute('href')
  try {
    Promise.resolve(openExternal(url)).catch(() => {})
  } catch { /* the report must remain inert if external opening fails */ }
  return true
}
