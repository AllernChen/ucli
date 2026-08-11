export function isPrivateNetworkHostname(value) {
  const hostname = String(value || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true

  const octets = hostname.split('.')
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [first, second] = octets.map(Number)
    return first === 10 || first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
  }

  return hostname === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/.test(hostname) ||
    /^fe[89ab][0-9a-f]:/.test(hostname)
}

export function isAllowedGitLabUrl(url) {
  const hostname = url.hostname.toLowerCase()
  if (!hostname || hostname === 'github.com') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && isPrivateNetworkHostname(hostname)
}
