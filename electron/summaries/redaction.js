const PRIVATE_KEY_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g
const AUTHORIZATION_PATTERN = /(\bAuthorization\s*:\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\s,;]+/gi
const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi
const NAMED_VALUE_PATTERN = /((?:"|')?[A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_.-]*(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi
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
    AUTHORIZATION_PATTERN,
    'authorization',
    counts,
    (_match, prefix) => `${prefix}[REDACTED:authorization]`
  )
  text = replaceAndCount(
    text,
    CREDENTIAL_URL_PATTERN,
    'credentialUrl',
    counts,
    (_match, scheme) => `${scheme}[REDACTED:credentials]@`
  )
  text = replaceAndCount(
    text,
    NAMED_VALUE_PATTERN,
    'namedValue',
    counts,
    (_match, prefix) => `${prefix}[REDACTED:named-value]`
  )
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
