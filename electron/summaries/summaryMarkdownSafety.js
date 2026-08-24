import path from 'node:path'

import { redactEvidenceText } from './redaction.js'

function normalizedPathText(value) {
  return String(value).replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase()
}

function pathApiFor(value) {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix
}

function normalizedAbsolutePath(value) {
  if (typeof value !== 'string') return null
  const pathApi = pathApiFor(value)
  if (!pathApi.isAbsolute(value)) return null
  return { pathApi, value: pathApi.resolve(value) }
}

function containsUnsafePath(markdown, unsafePath) {
  const root = normalizedAbsolutePath(unsafePath)
  if (!root) return false
  const tokens = String(markdown).match(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n`"'<>]*/g) || []
  return tokens.some(token => {
    const candidate = normalizedAbsolutePath(token)
    if (!candidate || candidate.pathApi !== root.pathApi) return false
    const relative = root.pathApi.relative(root.value, candidate.value)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${root.pathApi.sep}`) &&
      !root.pathApi.isAbsolute(relative))
  })
}

export function assertSafeSummaryMarkdown(markdown, unsafePaths = []) {
  if (typeof markdown !== 'string' || redactEvidenceText(markdown).total > 0) {
    throw Object.assign(new Error('Unsafe summary markdown'), { code: 'SUMMARY_MARKDOWN_UNSAFE' })
  }
  const normalized = normalizedPathText(markdown)
  for (const unsafePath of unsafePaths) {
    const candidate = normalizedPathText(unsafePath)
    if (candidate && (normalized.includes(candidate) || containsUnsafePath(markdown, unsafePath))) {
      throw Object.assign(new Error('Unsafe summary markdown'), { code: 'SUMMARY_MARKDOWN_UNSAFE' })
    }
  }
}
