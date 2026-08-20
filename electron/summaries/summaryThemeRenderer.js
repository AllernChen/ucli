import MarkdownIt from 'markdown-it'

import { getSummaryTheme } from './summaryThemeCatalog.js'

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
})

// Shared base stylesheet. Exported so the workLogs template can hand the same
// CSS to an interactive AI CLI for generating a structurally identical HTML.
export const SUMMARY_BASE_CSS = `
*{box-sizing:border-box}
html{font-family:Arial,"Microsoft YaHei",sans-serif;font-size:16px;line-height:1.6}
body{margin:0;min-height:100vh}
nav{position:fixed;left:0;top:0;width:240px;height:100vh;overflow-y:auto;padding:24px}
nav h2{font-size:18px;margin-top:0}nav ol{padding-left:20px}nav a{color:inherit;text-decoration:none}
main{margin-left:240px;padding:40px 48px}article{min-width:0}
h1{font-size:34px}h2{font-size:26px;margin-top:36px}h3{font-size:21px}
pre{overflow-x:auto;padding:16px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #999999}
.kpis{margin-bottom:28px}.kpi strong{display:block;font-size:26px}.kpi span{font-size:13px}
@media(max-width:760px){nav{position:static;width:auto;height:auto}main{margin-left:0;padding:24px}}
`

function themeError(code) {
  return Object.assign(new TypeError(code), { code })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

function slug(value, index, used) {
  const normalized = String(value).toLowerCase().normalize('NFKC')
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || `section-${index + 1}`
  let candidate = normalized
  let suffix = 2
  while (used.has(candidate)) candidate = `${normalized}-${suffix++}`
  used.add(candidate)
  return candidate
}

function headingPlan(markdown) {
  const tokens = markdownRenderer.parse(markdown, {})
  for (const token of tokens) {
    if (!Array.isArray(token.children)) continue
    const links = []
    for (const child of token.children) {
      if (child.type === 'image') {
        child.type = 'text'
        child.tag = ''
        child.content = child.content || child.attrGet('alt') || ''
        child.attrs = null
      } else if (child.type === 'link_open') {
        const fragment = String(child.attrGet('href') || '').startsWith('#')
        links.push(fragment)
        if (!fragment) {
          child.type = 'text'
          child.tag = ''
          child.content = ''
          child.attrs = null
        }
      } else if (child.type === 'link_close' && links.pop() === false) {
        child.type = 'text'
        child.tag = ''
        child.content = ''
      }
    }
  }
  const headings = []
  const used = new Set()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'heading_open') continue
    const inline = tokens[index + 1]
    const label = inline?.content || ''
    const id = slug(label, headings.length, used)
    token.attrSet('id', id)
    headings.push({ level: Number(token.tag.slice(1)), label, id })
  }
  return { headings, html: markdownRenderer.renderer.render(tokens, markdownRenderer.options, {}) }
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function usageTotals(usageSnapshot) {
  const source = usageSnapshot?.totals && typeof usageSnapshot.totals === 'object'
    ? usageSnapshot.totals
    : usageSnapshot
  return [
    ['输入 Token', numeric(source?.inputTokens)],
    ['输出 Token', numeric(source?.outputTokens)],
    ['交互次数', numeric(source?.turns)],
    ['费用', numeric(source?.costUsd)]
  ].filter(([, value]) => value !== null)
}

function kpiHtml(usageSnapshot) {
  const cards = usageTotals(usageSnapshot)
  return cards.length
    ? `<section class="kpis" aria-label="使用量">${cards.map(([label, value]) =>
        `<div class="kpi" data-kpi="${escapeHtml(label)}"><strong>${escapeHtml(value.toLocaleString('en-US'))}</strong><span>${escapeHtml(label)}</span></div>`
      ).join('')}</section>`
    : ''
}

function themeArticle(themeId, marker, content, usageSnapshot) {
  if (themeId === 'dashboard') {
    return `<section ${marker}="true">${kpiHtml(usageSnapshot)}<article>${content}</article></section>`
  }
  return `<article ${marker}="true">${content}</article>`
}

export function renderSummaryTheme({ themeId, markdown, report = {}, usageSnapshot = {} } = {}) {
  const theme = getSummaryTheme(themeId)
  if (typeof markdown !== 'string' || !report || typeof report !== 'object' || Array.isArray(report) ||
    !usageSnapshot || typeof usageSnapshot !== 'object' || Array.isArray(usageSnapshot)) {
    throw themeError('SUMMARY_THEME_INPUT_INVALID')
  }
  const { headings, html: content } = headingPlan(markdown)
  const navigation = headings.map(heading =>
    `<li data-level="${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.label)}</a></li>`
  ).join('')
  const article = themeArticle(theme.id, theme.marker, content, usageSnapshot)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作总结</title><style>${SUMMARY_BASE_CSS}${theme.css}</style></head><body data-summary-theme="${theme.id}"><nav aria-label="报告目录"><h2>目录</h2><ol>${navigation}</ol></nav><main>${article}</main></body></html>`
}
