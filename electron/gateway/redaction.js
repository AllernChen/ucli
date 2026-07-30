const DESKTOP_ONLY_MESSAGE = '内容无法安全展示，请在 UCLI 中查看'
const SENSITIVE_NAME = '(?:password|secret|token|api[_-]?key)'

function unsafeText(value) {
  if (typeof value !== 'string' || value.includes('\0')) return true
  if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return true
  return value.includes('\uFFFD')
}

function redactSensitiveValues(text) {
  let value = text
  value = value.replace(
    /(authorization\s*:\s*)(?:bearer\s+)?[^\r\n]+/gi,
    '$1[REDACTED]'
  )
  value = value.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  value = value.replace(
    new RegExp(`(["']?${SENSITIVE_NAME}["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi'),
    '$1$2[REDACTED]$2'
  )
  value = value.replace(
    new RegExp(`(\\b${SENSITIVE_NAME}\\b\\s*[:=]\\s*)([^\\s,;&#]+)`, 'gi'),
    '$1[REDACTED]'
  )
  value = value.replace(
    new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]+`, 'gi'),
    '$1[REDACTED]'
  )
  return value
}

export function redactDisplayText(input) {
  if (unsafeText(input)) {
    return {
      text: DESKTOP_ONLY_MESSAGE,
      desktopOnly: true,
      redacted: false
    }
  }
  const normalized = input.replace(/\r\n?/g, '\n').normalize('NFC')
  const text = redactSensitiveValues(normalized)
  return {
    text,
    desktopOnly: false,
    redacted: text !== normalized
  }
}

export function prepareDecisionSummary(input, maxCodePoints = 1000) {
  const display = redactDisplayText(input)
  if (display.desktopOnly) {
    return {
      summary: display.text,
      desktopOnly: true,
      redacted: false,
      truncated: false,
      actions: []
    }
  }
  const points = Array.from(display.text)
  const truncated = points.length > maxCodePoints
  return {
    summary: truncated ? `${points.slice(0, maxCodePoints).join('')}…` : display.text,
    desktopOnly: false,
    redacted: display.redacted,
    truncated,
    actions: truncated
      ? [{ id: 'view_full', label: '查看完整内容' }]
      : []
  }
}

export { DESKTOP_ONLY_MESSAGE }
