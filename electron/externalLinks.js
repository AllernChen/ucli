export function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isAllowedApplicationNavigation(currentValue, nextValue) {
  try {
    const current = new URL(String(currentValue))
    const next = new URL(String(nextValue))
    return current.protocol === next.protocol &&
      current.host === next.host &&
      current.pathname === next.pathname &&
      current.username === next.username &&
      current.password === next.password
  } catch {
    return false
  }
}

export async function openAllowedExternalUrl(value, openExternal) {
  if (!isAllowedExternalUrl(value)) return false
  await openExternal(value)
  return true
}
