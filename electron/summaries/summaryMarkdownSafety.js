import { redactEvidenceText } from './redaction.js'

function normalizedPathText(value) {
  return String(value).replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase()
}

export function assertSafeSummaryMarkdown(markdown, unsafePaths = []) {
  if (typeof markdown !== 'string' || redactEvidenceText(markdown).total > 0) {
    throw Object.assign(new Error('Unsafe summary markdown'), { code: 'SUMMARY_MARKDOWN_UNSAFE' })
  }
  const normalized = normalizedPathText(markdown)
  for (const unsafePath of unsafePaths) {
    const candidate = normalizedPathText(unsafePath)
    if (candidate && normalized.includes(candidate)) {
      throw Object.assign(new Error('Unsafe summary markdown'), { code: 'SUMMARY_MARKDOWN_UNSAFE' })
    }
  }
}
