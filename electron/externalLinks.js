export function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function openAllowedExternalUrl(value, openExternal) {
  if (!isAllowedExternalUrl(value)) return false
  await openExternal(value)
  return true
}
