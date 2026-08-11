const PRIVATE_KEY_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi
// Each key candidate is capped so a long non-matching line cannot trigger
// unbounded regex backtracking. Values are consumed once by the scanner below.
const ASSIGNMENT_PATTERN = /(^|[\s{,;&?'"])(?:"([^"\r\n]{1,128})"|'([^'\r\n]{1,128})'|([A-Za-z0-9_.-]{1,128}))(\s*[:=]\s*)/g
const COMMON_KEY_PATTERN = /\b(?:sk-(?:(?:ant|live|proj)-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9]{12,})\b/g

const RULE_NAMES = Object.freeze([
  'authorization',
  'commonKey',
  'privateKey',
  'credentialUrl',
  'namedValue'
])

export function emptyRedactionCounts() {
  return Object.fromEntries(RULE_NAMES.map(rule => [rule, 0]))
}

function replaceAndCount(text, pattern, rule, counts, replacement) {
  return text.replace(pattern, (...args) => {
    counts[rule] += 1
    return typeof replacement === 'function' ? replacement(...args) : replacement
  })
}

function sensitiveNamedKey(key) {
  const normalized = String(key).toLowerCase()
  return normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    /api[_-]?key/.test(normalized)
}

function assignedValue(text, start, authorization) {
  const quote = text[start]
  if (quote === '"' || quote === "'") {
    let escaped = false
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index]
      if (character === '\r' || character === '\n') return null
      if (!escaped && character === quote) {
        return { end: index + 1, quote }
      }
      escaped = !escaped && character === '\\'
      if (character !== '\\') escaped = false
    }
    return null
  }

  let end = start
  const delimiter = authorization
    ? /[\r\n,;}\]"']/
    : /[\s,;&?#}\]"']/
  while (end < text.length && !delimiter.test(text[end])) end += 1
  while (end > start && /[ \t]/.test(text[end - 1])) end -= 1
  return end > start ? { end, quote: '' } : null
}

function redactAssignments(text, counts) {
  ASSIGNMENT_PATTERN.lastIndex = 0
  const chunks = []
  let cursor = 0
  let match
  while ((match = ASSIGNMENT_PATTERN.exec(text)) !== null) {
    const key = match[2] ?? match[3] ?? match[4]
    const authorization = key.toLowerCase() === 'authorization'
    const rule = authorization ? 'authorization' : sensitiveNamedKey(key) ? 'namedValue' : null
    if (!rule) continue

    const value = assignedValue(text, ASSIGNMENT_PATTERN.lastIndex, authorization)
    if (!value) continue
    const marker = authorization
      ? '[REDACTED:authorization]'
      : '[REDACTED:named-value]'
    chunks.push(text.slice(cursor, match.index), match[0])
    chunks.push(value.quote ? `${value.quote}${marker}${value.quote}` : marker)
    counts[rule] += 1
    cursor = value.end
    ASSIGNMENT_PATTERN.lastIndex = value.end
  }
  if (!chunks.length) return text
  chunks.push(text.slice(cursor))
  return chunks.join('')
}

export function redactEvidenceText(value) {
  const counts = emptyRedactionCounts()
  let text = String(value ?? '')
  text = replaceAndCount(
    text,
    PRIVATE_KEY_PATTERN,
    'privateKey',
    counts,
    '[REDACTED:private-key]'
  )
  text = replaceAndCount(
    text,
    CREDENTIAL_URL_PATTERN,
    'credentialUrl',
    counts,
    (_match, scheme) => `${scheme}[REDACTED:credentials]@`
  )
  text = redactAssignments(text, counts)
  text = replaceAndCount(
    text,
    COMMON_KEY_PATTERN,
    'commonKey',
    counts,
    '[REDACTED:api-key]'
  )
  return {
    text,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0)
  }
}

export function mergeRedactionCounts(target, source) {
  for (const rule of RULE_NAMES) target[rule] += Number(source?.[rule] || 0)
  return target
}
