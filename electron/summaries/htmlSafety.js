import MarkdownIt from 'markdown-it'
import { parse, parseFragment } from 'parse5'

const markdownParser = new MarkdownIt({ html: false })
const ALLOWED_ELEMENTS = new Set([
  'html', 'head', 'body', 'meta', 'title', 'style', 'nav', 'main', 'section',
  'article', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul',
  'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'table', 'caption',
  'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'strong', 'em',
  'b', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup', 'time', 'kbd',
  'samp', 'var', 'q', 'cite', 'abbr', 'br', 'wbr', 'hr', 'a'
])
const GLOBAL_ATTRIBUTES = new Set(['id', 'class', 'style', 'lang', 'dir', 'title', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby'])
const ELEMENT_ATTRIBUTES = new Map([
  ['meta', new Set(['charset', 'name', 'content'])],
  ['a', new Set(['href'])],
  ['ol', new Set(['start', 'reversed', 'type'])],
  ['li', new Set(['value'])],
  ['time', new Set(['datetime'])],
  ['q', new Set(['cite'])],
  ['th', new Set(['colspan', 'rowspan', 'scope', 'headers'])],
  ['td', new Set(['colspan', 'rowspan', 'headers'])],
  ['col', new Set(['span'])],
  ['colgroup', new Set(['span'])]
])
const RESOURCE_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'ping',
  'background'
])
const ALLOWED_CSS_FUNCTIONS = new Set([
  'rgb', 'hsl', 'linear-gradient', 'repeating-linear-gradient',
  'radial-gradient', 'repeating-radial-gradient', 'conic-gradient',
  'repeating-conic-gradient', 'repeat', 'minmax', 'fit-content',
  'cubic-bezier', 'steps', 'not', 'is', 'where', 'has', 'lang',
  'dir', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'
])
const SAFE_CSS_PROPERTIES = new Set([
  'align-content', 'align-items', 'align-self', 'background-color',
  'background-position', 'background-repeat', 'background-size', 'border',
  'border-block', 'border-block-color', 'border-block-end', 'border-block-start',
  'border-bottom', 'border-bottom-color', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-collapse', 'border-color', 'border-inline',
  'border-inline-color', 'border-inline-end', 'border-inline-start', 'border-left',
  'border-left-color', 'border-radius', 'border-right', 'border-right-color',
  'border-spacing', 'border-style', 'border-top', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-width', 'box-shadow',
  'box-sizing', 'break-after', 'break-before', 'break-inside', 'caption-side',
  'color', 'color-scheme', 'column-gap', 'display', 'fill', 'flex', 'flex-basis',
  'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap',
  'font-family', 'font-feature-settings', 'font-kerning', 'font-size',
  'font-stretch', 'font-style', 'font-variant', 'font-weight', 'gap',
  'grid-auto-columns', 'grid-auto-flow', 'grid-auto-rows', 'grid-column',
  'grid-column-end', 'grid-column-start', 'grid-row', 'grid-row-end',
  'grid-row-start', 'grid-template', 'grid-template-areas', 'grid-template-columns',
  'grid-template-rows', 'height', 'hyphens', 'justify-content', 'justify-items',
  'justify-self', 'left', 'letter-spacing', 'line-height', 'list-style',
  'list-style-position', 'list-style-type', 'margin', 'margin-block',
  'margin-block-end', 'margin-block-start', 'margin-bottom', 'margin-inline',
  'margin-inline-end', 'margin-inline-start', 'margin-left', 'margin-right',
  'margin-top', 'max-height', 'max-width', 'min-height', 'min-width',
  'object-fit', 'order', 'outline', 'outline-color', 'outline-offset',
  'outline-style', 'outline-width', 'overflow-wrap', 'padding', 'padding-block',
  'padding-block-end', 'padding-block-start', 'padding-bottom', 'padding-inline',
  'padding-inline-end', 'padding-inline-start', 'padding-left', 'padding-right',
  'padding-top', 'place-content', 'place-items', 'place-self', 'position',
  'row-gap', 'stroke', 'table-layout', 'text-align', 'text-decoration',
  'text-decoration-color', 'text-decoration-line', 'text-decoration-style',
  'text-overflow', 'text-transform', 'top', 'transition', 'transition-delay',
  'transition-duration', 'transition-property', 'transition-timing-function',
  'vertical-align', 'white-space', 'width', 'word-break', 'word-spacing'
])
const CONCEALMENT_PROPERTIES = new Set([
  'background', 'box-shadow', 'clip', 'clip-path', 'content', 'filter', 'font',
  'mask', 'mask-image', 'opacity', 'outline', 'outline-color', 'outline-offset',
  'outline-style', 'outline-width', 'overflow', 'overflow-x', 'overflow-y',
  'text-indent', 'transform', 'visibility',
  '-webkit-text-fill-color'
])

function validationError(code, message) {
  return { code, message }
}

function elementChildren(node) {
  return (node?.childNodes || []).filter(child => typeof child?.tagName === 'string')
}

function walk(node, visitor) {
  visitor(node)
  for (const child of node?.childNodes || []) walk(child, visitor)
  if (node?.content) walk(node.content, visitor)
}

function attr(node, name) {
  return node?.attrs?.find(item => item.name.toLowerCase() === name)?.value ?? null
}

function nodeText(node) {
  let value = node?.nodeName === '#text' ? node.value || '' : ''
  for (const child of node?.childNodes || []) value += nodeText(child)
  return value
}

function isWithin(node, ancestor) {
  for (let current = node?.parentNode; current; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

function normalizeHeading(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN')
}

function normalizeContent(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

const BLOCK_ELEMENTS = new Set([
  'main', 'section', 'article', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'table', 'caption',
  'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr'
])

function encodeExactText(value) {
  return Array.from(String(value || '').replace(/\r\n?/g, '\n'))
    .map(char => char.codePointAt(0).toString(16)).join('.')
}

function semanticText(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return String(node.value || '').normalize('NFKC')
  const tag = node.tagName?.toLowerCase()
  if (tag === 'pre' || tag === 'code') return `[[exact:${encodeExactText(nodeText(node))}]]`
  if (tag === 'br') return '\n'
  const inner = (node.childNodes || []).map(semanticText).join('')
  return BLOCK_ELEMENTS.has(tag) ? `\n${inner}\n` : inner
}

function markdownHeadings(markdown) {
  const tokens = markdownParser.parse(String(markdown || ''), {})
  const headings = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === 'heading_open' && tokens[index + 1]?.type === 'inline') {
      headings.push(normalizeHeading(tokens[index + 1].content))
    }
  }
  return headings
}

function markdownText(markdown) {
  return normalizeContent(semanticText(parseFragment(markdownParser.render(String(markdown || '')))))
}

function isJavascriptUrl(value) {
  const compact = String(value || '').replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  return compact.startsWith('javascript:')
}

function isDisallowedResourceUrl(value) {
  const normalized = String(value || '').trim()
  return Boolean(normalized && !normalized.startsWith('#'))
}

function decodeCssEscapes(value) {
  return String(value || '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\r\n\f])/g, '$1')
}

function stripCssComments(value) {
  let result = ''
  for (let index = 0; index < value.length;) {
    if (value[index] === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2)
      if (end < 0) break
      index = end + 2
      continue
    }
    result += value[index]
    index += 1
  }
  return result
}

function scanCssSyntax(value) {
  const atRules = []
  const functions = []
  for (let index = 0; index < value.length;) {
    const char = value[index]
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      while (index < value.length && value[index] !== quote) index += 1
      index += 1
      continue
    }
    if (char === '@') {
      let end = index + 1
      while (/[a-z0-9_-]/i.test(value[end] || '')) end += 1
      atRules.push(value.slice(index + 1, end).toLowerCase())
      index = end
      continue
    }
    if (/[a-z_-]/i.test(char)) {
      let end = index + 1
      while (/[a-z0-9_-]/i.test(value[end] || '')) end += 1
      let cursor = end
      while (/\s/.test(value[cursor] || '')) cursor += 1
      if (value[cursor] === '(') functions.push(value.slice(index, end).toLowerCase())
      index = end
      continue
    }
    index += 1
  }
  return { atRules, functions }
}

function splitCss(value, separator) {
  const parts = []
  let start = 0
  let quote = null
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

function cssRules(value) {
  const rules = []
  let cursor = 0
  while (cursor < value.length) {
    const open = value.indexOf('{', cursor)
    if (open < 0) break
    const close = value.indexOf('}', open + 1)
    if (close < 0 || value.slice(open + 1, close).includes('{')) return null
    rules.push({ selector: value.slice(cursor, open).trim(), declarations: value.slice(open + 1, close) })
    cursor = close + 1
  }
  return value.slice(cursor).trim() ? null : rules
}

function cssDeclarations(value) {
  const declarations = []
  for (const raw of splitCss(value, ';')) {
    if (!raw.trim()) continue
    const parts = splitCss(raw, ':')
    if (parts.length < 2) return null
    declarations.push({
      property: parts.shift().trim().toLowerCase(),
      value: parts.join(':').trim().toLowerCase()
    })
  }
  return declarations
}

function selectorMatchesOnlyNav(selector, nav) {
  const navId = attr(nav, 'id')
  const classes = new Set(String(attr(nav, 'class') || '').split(/\s+/).filter(Boolean))
  const parts = splitCss(selector, ',').map(value => value.trim().toLowerCase()).filter(Boolean)
  return parts.length > 0 && parts.every(value => {
    if (/^nav(?:[#.][a-z0-9_-]+)*$/i.test(value)) return true
    if (navId && value === `#${navId.toLowerCase()}`) return true
    return [...classes].some(name => value === `.${name.toLowerCase()}`)
  })
}

function isAllowedSelector(selector) {
  const element = '(?:html|body|nav|main|section|article|div|span|h[1-6]|p|ul|ol|li|dl|dt|dd|blockquote|pre|code|table|caption|thead|tbody|tfoot|tr|th|td|strong|em|b|i|u|s|del|mark|small|sub|sup|time|kbd|samp|var|q|cite|abbr|a|hr)'
  const simple = new RegExp(`^(?::root|${element})(?::(?:hover|focus|focus-visible))?$`, 'i')
  const descendant = new RegExp(`^(?:nav|main)\\s+${element}(?::(?:hover|focus|focus-visible))?$`, 'i')
  return splitCss(selector, ',').map(value => value.trim()).filter(Boolean)
    .every(value => simple.test(value) || descendant.test(value))
}

function selectorIsThemeScope(selector) {
  return splitCss(selector, ',').map(value => value.trim().toLowerCase()).filter(Boolean)
    .every(value => [':root', 'html', 'body', 'nav'].includes(value))
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])
}

function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function safeFontSize(value) {
  if (['small', 'medium', 'large', 'x-large'].includes(value)) return true
  const match = value.match(/^(\d*\.?\d+)(px|rem|em|%)$/)
  if (!match) return false
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return false
  if (match[2] === 'px') return amount >= 8 && amount <= 72
  if (match[2] === '%') return amount >= 50 && amount <= 400
  return amount >= 0.5 && amount <= 4.5
}

function safeNavWidth(value) {
  if (value === 'auto') return true
  const match = value.match(/^(\d*\.?\d+)(px|rem|em)$/)
  if (!match) return false
  const amount = Number(match[1])
  return match[2] === 'px' ? amount <= 320 : amount <= 24
}

function canonicalSolidColor(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'white') return '#ffffff'
  if (normalized === 'black') return '#000000'
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.slice(1).split('').map(char => char.repeat(2)).join('')}`
  }
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null
}

function inspectDeclarations(value, errors, { navOnly = false, themeScope = false, palette } = {}) {
  const declarations = cssDeclarations(value)
  if (!declarations) {
    errors.push(validationError('CSS_DECLARATION_FORBIDDEN', 'Malformed CSS declarations are not allowed'))
    return
  }
  const textColor = declarations.find(item => item.property === 'color')
  const backgroundColor = declarations.find(item => item.property === 'background-color')
  if (textColor || backgroundColor) {
    const foreground = canonicalSolidColor(textColor?.value)
    const background = canonicalSolidColor(backgroundColor?.value)
    if (!themeScope || !foreground || !background || contrastRatio(foreground, background) < 4.5) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Theme colors must be an opaque high-contrast pair'))
    }
  }
  for (const declaration of declarations) {
    const { property, value: cssValue } = declaration
    if (!property || property.startsWith('--') || CONCEALMENT_PROPERTIES.has(property)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'CSS cannot hide or replace report content'))
      continue
    }
    if (!SAFE_CSS_PROPERTIES.has(property)) {
      errors.push(validationError('CSS_PROPERTY_FORBIDDEN', `CSS property ${property || '(empty)'} is not allowed`))
      continue
    }
    if (property === 'position' && !((cssValue === 'fixed' && navOnly) || cssValue === 'static')) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Only the navigation may use fixed positioning'))
    }
    if (property === 'display' && !/^(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|table-row|table-cell|list-item)$/.test(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'CSS cannot hide or replace report content'))
    }
    if ((property.includes('color') || property === 'background' || property === 'fill' || property === 'stroke') &&
      /\btransparent\b|#[0-9a-f]{4}(?:[^0-9a-f]|$)|#[0-9a-f]{8}(?:[^0-9a-f]|$)|\b(?:rgba|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(|\//i.test(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Transparent report colors are not allowed'))
    }
    const solidColor = canonicalSolidColor(cssValue)
    if (solidColor && property === 'color') palette?.foreground.add(solidColor)
    if (solidColor && ['background', 'background-color'].includes(property)) palette?.background.add(solidColor)
    if ((property.startsWith('margin') || ['top'].includes(property)) && /(^|[\s,(])-\s*(?:\d|\.)/.test(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Negative positioning values are not allowed'))
    }
    if (property === 'font-size' && !safeFontSize(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Report text cannot be hidden'))
    }
    if (navOnly && ['width', 'min-width', 'max-width'].includes(property) && !safeNavWidth(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Navigation width must remain bounded'))
    }
    if (navOnly && (/^border(?:-|$)/.test(property) || /^padding(?:-|$)/.test(property) || /^margin(?:-|$)/.test(property))) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Navigation paint must remain inside its bounded width'))
    }
    if (navOnly && ['left', 'top'].includes(property) && !/^0(?:px|rem|em|%)?$/.test(cssValue)) {
      errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Navigation must remain anchored at the top left'))
    }
  }
}

function inspectCss(css, errors, { inlineNav = false, nav = null, palette } = {}) {
  const normalized = stripCssComments(decodeCssEscapes(css))
  const syntax = scanCssSyntax(normalized)
  if (syntax.atRules.includes('import')) {
    errors.push(validationError('CSS_IMPORT_FORBIDDEN', 'CSS @import is not allowed'))
  }
  if (syntax.atRules.includes('font-face')) {
    errors.push(validationError('EXTERNAL_FONT_FORBIDDEN', 'Generated font faces are not allowed'))
  }
  if (syntax.atRules.some(rule => rule && !['import', 'font-face'].includes(rule))) {
    errors.push(validationError('CSS_AT_RULE_FORBIDDEN', 'CSS at-rules are not allowed'))
  }
  if (syntax.functions.some(name => ['var', 'env', 'attr', 'calc'].includes(name))) {
    errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Dynamic CSS values are not allowed'))
  }
  if (syntax.functions.some(name => !ALLOWED_CSS_FUNCTIONS.has(name) && !['var', 'env', 'attr', 'calc'].includes(name))) {
    errors.push(validationError('EXTERNAL_CSS_URL', 'Unknown or resource-loading CSS functions are not allowed'))
  }
  if (/::(?:before|after|first-letter|first-line|marker|backdrop)\b/i.test(normalized)) {
    errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'CSS cannot hide or replace report content'))
  }
  if (/(?:https?:)?\/\//i.test(normalized)) {
    errors.push(validationError('EXTERNAL_CSS_URL', 'External CSS URLs are not allowed'))
  }
  if (inlineNav || !normalized.includes('{')) {
    inspectDeclarations(normalized, errors, { navOnly: inlineNav, themeScope: inlineNav, palette })
    return
  }
  const rules = cssRules(normalized)
  if (!rules) {
    errors.push(validationError('CSS_DECLARATION_FORBIDDEN', 'Malformed or nested CSS is not allowed'))
    return
  }
  for (const rule of rules) {
    if (!isAllowedSelector(rule.selector)) {
      errors.push(validationError('CSS_SELECTOR_FORBIDDEN', 'Only simple report element selectors are allowed'))
      continue
    }
    inspectDeclarations(rule.declarations, errors, {
      navOnly: Boolean(nav && selectorMatchesOnlyNav(rule.selector, nav)),
      themeScope: selectorIsThemeScope(rule.selector), palette
    })
  }
}

function selectorMatchesNav(selector, nav) {
  const navId = attr(nav, 'id')
  const classes = new Set(String(attr(nav, 'class') || '').split(/\s+/).filter(Boolean))
  return selector.split(',').some(part => {
    const value = part.trim()
    return /(^|[\s>+~])nav(?:$|[\s.#:[>+~])/i.test(value) ||
      (navId && value.includes(`#${navId}`)) ||
      [...classes].some(name => value.includes(`.${name}`))
  })
}

function hasFixedLeftNavigation(nav, styleText) {
  const inline = attr(nav, 'style') || ''
  const leftZero = value => /left\s*:\s*0(?:px|rem|em|%|vh|vw)?\s*(?:;|$)/i.test(value)
  if (/position\s*:\s*fixed\b/i.test(inline) && leftZero(inline)) return true
  for (const match of String(styleText || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorMatchesNav(match[1], nav) &&
      /position\s*:\s*fixed\b/i.test(match[2]) &&
      leftZero(match[2])) return true
  }
  return false
}

export function validateSummaryHtml({ html, markdown } = {}) {
  const errors = []
  if (typeof html !== 'string' || !html.trim()) {
    return { valid: false, errors: [validationError('HTML_DOCUMENT_REQUIRED', 'A complete HTML document is required')] }
  }

  const document = parse(html, { sourceCodeLocationInfo: true })
  const documentType = document.childNodes?.find(node => node.nodeName === '#documentType')
  const htmlNode = document.childNodes?.find(node => node.tagName === 'html')
  const head = elementChildren(htmlNode).find(node => node.tagName === 'head')
  const body = elementChildren(htmlNode).find(node => node.tagName === 'body')
  if (!documentType?.sourceCodeLocation || !htmlNode?.sourceCodeLocation ||
    !head?.sourceCodeLocation || !body?.sourceCodeLocation) {
    errors.push(validationError('HTML_DOCUMENT_REQUIRED', 'DOCTYPE, html, head, and body must be explicit'))
  }

  const headings = []
  const headingNodes = []
  const styleNodes = []
  const navNodes = []
  const mainNodes = []
  const cssPalette = { foreground: new Set(), background: new Set() }
  walk(document, node => {
    const tag = node?.tagName?.toLowerCase()
    if (!tag) return
    if (!ALLOWED_ELEMENTS.has(tag)) {
      errors.push(validationError('FORBIDDEN_ELEMENT', `Element <${tag}> is not allowed`))
    }
    if (['meta', 'title', 'style'].includes(tag) && node.parentNode !== head) {
      errors.push(validationError('FORBIDDEN_ELEMENT', `Element <${tag}> is only allowed in <head>`))
    }
    if (!['html', 'head', 'body', 'meta', 'title', 'style', 'nav', 'main'].includes(tag) &&
      !isWithin(node, mainNodes[0]) && !isWithin(node, navNodes[0])) {
      errors.push(validationError('FORBIDDEN_ELEMENT', `Element <${tag}> must be report content or navigation`))
    }
    if (tag === 'base' || (tag === 'meta' && String(attr(node, 'http-equiv')).toLowerCase() === 'refresh')) {
      errors.push(validationError('FORBIDDEN_ELEMENT', `Element <${tag}> is not allowed`))
    }
    for (const item of node.attrs || []) {
      const name = item.name.toLowerCase()
      const allowedAttributes = ELEMENT_ATTRIBUTES.get(tag)
      if (!GLOBAL_ATTRIBUTES.has(name) && !allowedAttributes?.has(name)) {
        errors.push(validationError('ATTRIBUTE_FORBIDDEN', `Attribute ${name} is not allowed on <${tag}>`))
      }
      if (name.startsWith('on')) {
        errors.push(validationError('INLINE_EVENT_HANDLER', 'Inline event handlers are not allowed'))
      }
      if (RESOURCE_ATTRIBUTES.has(name) && isJavascriptUrl(item.value)) {
        errors.push(validationError('JAVASCRIPT_URL', 'javascript: URLs are not allowed'))
      }
      if (name === 'style') inspectCss(item.value, errors, { inlineNav: tag === 'nav', palette: cssPalette })
      if (RESOURCE_ATTRIBUTES.has(name) && isDisallowedResourceUrl(item.value)) {
        errors.push(validationError('EXTERNAL_RESOURCE', 'External resources are not allowed'))
      }
      if (name === 'hidden' || (name === 'aria-hidden' && item.value.toLowerCase() === 'true')) {
        errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Report content cannot be hidden'))
      }
    }
    if (tag === 'link') {
      const rel = String(attr(node, 'rel') || '').toLowerCase()
      if (/\b(?:stylesheet|preload|prefetch)\b/.test(rel)) {
        errors.push(validationError('EXTERNAL_RESOURCE', 'Linked stylesheets and fonts are not allowed'))
      }
    }
    if (tag === 'style') styleNodes.push(node)
    if (tag === 'nav') navNodes.push(node)
    if (tag === 'main') mainNodes.push(node)
    if (/^h[1-6]$/.test(tag)) {
      headings.push(normalizeHeading(nodeText(node)))
      headingNodes.push(node)
    }
  })

  const styleText = styleNodes.map(nodeText).join('\n')
  inspectCss(styleText, errors, { nav: navNodes.length === 1 ? navNodes[0] : null, palette: cssPalette })
  if ([...cssPalette.foreground].some(color => cssPalette.background.has(color))) {
    errors.push(validationError('CONTENT_CONCEALMENT_FORBIDDEN', 'Foreground and background colors must remain distinguishable'))
  }
  const leftNav = navNodes.find(node => hasFixedLeftNavigation(node, styleText))
  const headingIds = headingNodes.map(node => attr(node, 'id')).filter(Boolean)
  const navTargets = []
  const navLabels = []
  let navHasExtraContent = false
  if (leftNav) {
    const visitNav = (node, insideLink = false) => {
      const isLink = node?.tagName === 'a'
      const nextInsideLink = insideLink || isLink
      if (node?.nodeName === '#text' && normalizeContent(node.value) && !insideLink) navHasExtraContent = true
      if (node?.tagName && !['nav', 'a', 'ul', 'ol', 'li'].includes(node.tagName)) navHasExtraContent = true
      if (node?.tagName === 'a') {
        const href = attr(node, 'href')
        if (href?.startsWith('#')) navTargets.push(href.slice(1))
        navLabels.push(normalizeHeading(nodeText(node)))
      }
      for (const child of node?.childNodes || []) visitNav(child, nextInsideLink)
    }
    visitNav(leftNav)
  }
  const bodyElements = elementChildren(body)
  const bodyStructureValid = navNodes.length === 1 && mainNodes.length === 1 &&
    bodyElements.length === 2 && bodyElements[0] === leftNav && bodyElements[1] === mainNodes[0]
  if (!leftNav || headingIds.length !== headingNodes.length ||
    navTargets.length !== headingIds.length || navHasExtraContent || !bodyStructureValid ||
    headingIds.some((id, index) => navTargets[index] !== id || navLabels[index] !== headings[index])) {
    errors.push(validationError('LEFT_NAV_REQUIRED', 'A fixed left navigation linking every section is required'))
  }

  const expectedHeadings = markdownHeadings(markdown)
  if (!expectedHeadings.length || expectedHeadings.length !== headings.length ||
    expectedHeadings.some((heading, index) => heading !== headings[index])) {
    errors.push(validationError('MARKDOWN_HEADINGS_CHANGED', 'HTML headings must preserve every Markdown section'))
  }
  const mainNode = mainNodes[0]
  const expectedText = markdownText(markdown)
  const actualText = normalizeContent(semanticText(mainNode))
  const excluded = new Set([mainNode, ...navNodes])
  const outsideText = node => {
    if (!node || excluded.has(node)) return ''
    let value = node.nodeName === '#text' ? node.value || '' : ''
    for (const child of node.childNodes || []) value += outsideText(child)
    return value
  }
  if (!bodyStructureValid || !expectedText || actualText !== expectedText ||
    normalizeContent(outsideText(body))) {
    errors.push(validationError('MARKDOWN_CONTENT_CHANGED', 'HTML content must preserve the complete Markdown report'))
  }

  return { valid: errors.length === 0, errors }
}
