import { createSummaryMarkdownParser } from './summaryMarkdownParser.js'

const TARGETS = Object.freeze([
  Object.freeze({ text: '摘要', level: 1 }),
  Object.freeze({ text: '使用量分析', level: 2 }),
  Object.freeze({ text: '项目进展', level: 2 }),
  Object.freeze({ text: '跨项目观察', level: 2 }),
  Object.freeze({ text: '下一步建议', level: 2 }),
  Object.freeze({ text: '数据覆盖', level: 2 })
])
const parser = createSummaryMarkdownParser({ html: true })

function invalidArtifact() {
  return Object.assign(new Error('Invalid canonical summary artifact'), {
    code: 'SUMMARY_ARTIFACT_INVALID'
  })
}

export function canonicalizeInteractiveSummaryMarkdown(markdown) {
  if (typeof markdown !== 'string') throw invalidArtifact()
  const lines = markdown.split('\n')
  const headings = rootAtxHeadings(parser.parse(markdown, {}), lines)
  const required = matchRequiredHeadings(headings, TARGETS)
  const rewrites = planSectionRewrites(headings, required, TARGETS)
  if (!rewrites.size) return { markdown, changed: false }
  for (const [lineIndex, level] of rewrites) {
    lines[lineIndex] = rewriteAtxMarker(lines[lineIndex], level)
  }
  return { markdown: lines.join('\n'), changed: true }
}

function rootAtxHeadings(tokens, lines) {
  const headings = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'heading_open' || token.level !== 0 || !/^h[1-6]$/.test(token.tag)) continue
    const map = token.map
    if (!Array.isArray(map) || map.length !== 2 || map[1] !== map[0] + 1 || typeof lines[map[0]] !== 'string') continue
    const source = lines[map[0]]
    const atx = source.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/)
    if (!atx) continue
    const inline = tokens[index + 1]
    if (!inline || inline.type !== 'inline' || inline.map?.[0] !== map[0] || inline.map?.[1] !== map[1]) continue
    headings.push({ lineIndex: map[0], level: atx[1].length, text: inline.content.trim() })
  }
  return headings
}

function matchRequiredHeadings(headings, targets) {
  const required = []
  let cursor = 0
  for (const target of targets) {
    const matches = headings.filter((heading) => heading.text === target.text)
    if (matches.length !== 1) throw invalidArtifact()
    const heading = matches[0]
    if (heading.level < 1 || heading.level > 2) throw invalidArtifact()
    if (heading.lineIndex <= (required.at(-1)?.lineIndex ?? -1) || heading.lineIndex < cursor) throw invalidArtifact()
    required.push({ ...heading, target })
    cursor = heading.lineIndex
  }
  return required
}

function planSectionRewrites(headings, required, targets) {
  const rewrites = new Map()
  for (let index = 0; index < required.length; index += 1) {
    const section = required[index]
    const delta = section.target.level - section.level
    if (section.level !== section.target.level) rewrites.set(section.lineIndex, section.target.level)
    const nextLine = required[index + 1]?.lineIndex ?? Infinity
    if (delta === 0) continue
    for (const heading of headings) {
      if (heading.lineIndex <= section.lineIndex || heading.lineIndex >= nextLine || required.some((item) => item.lineIndex === heading.lineIndex)) continue
      const level = heading.level + delta
      if (level < 1 || level > 6) throw invalidArtifact()
      rewrites.set(heading.lineIndex, level)
    }
  }
  return rewrites
}

function rewriteAtxMarker(line, level) {
  return line.replace(/^( {0,3})#{1,6}/, `$1${'#'.repeat(level)}`)
}
