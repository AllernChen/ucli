export function openSafeLink(event, openExternal) {
  const anchor = event?.target?.closest?.('a[href]')
  if (!anchor) return false
  event.preventDefault()
  const url = anchor.getAttribute('href')
  if (!/^https?:\/\//i.test(String(url || ''))) return false
  try {
    Promise.resolve(openExternal(url)).catch(() => {})
  } catch { /* the preview must remain inert if external opening fails */ }
  return true
}
