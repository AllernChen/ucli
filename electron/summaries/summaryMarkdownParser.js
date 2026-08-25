import MarkdownIt from 'markdown-it'

const SUMMARY_MARKDOWN_OPTIONS = Object.freeze({
  linkify: false,
  typographer: false
})

export function createSummaryMarkdownParser({ html = false } = {}) {
  return new MarkdownIt({
    ...SUMMARY_MARKDOWN_OPTIONS,
    html
  })
}
