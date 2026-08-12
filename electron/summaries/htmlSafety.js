import { parse, serialize } from 'parse5'

// HTML export sanitizer.
//
// AI CLI 产出的 HTML 当作不可信数据：清洗后只剥离会执行代码、加载外部资源、
// 注入事件处理器或用 CSS 隐藏/替换报告内容的节点与属性，其余（颜色、overflow、
// 多层选择器、是否含左侧导航、章节文字是否逐字相等）一律保留——这些是"质量"
// 而非"安全"，交给 prompt 尽力而为，不再硬性拒绝。

// 整个元素删除（脚本、嵌入、表单、媒体、外部资源载体等）。
const STRIP_ELEMENTS = new Set([
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'param',
  'applet', 'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup',
  'fieldset', 'legend', 'label', 'base', 'link', 'img', 'image', 'picture', 'source',
  'audio', 'video', 'track', 'canvas', 'svg', 'math', 'map', 'area', 'portal',
  'template', 'slot', 'noembed', 'noframes'
])

// 携带 URL 的属性：仅保留片段引用（#xxx，用于页内导航），其余一律删。
const RESOURCE_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlink:href',
  'ping', 'background', 'cite', 'longdesc', 'usemap', 'profile', 'manifest', 'code',
  'codebase', 'dynsrc', 'lowsrc'
])

// 直接删除的属性（交互/弹层/跳转能力）。
const STRIP_ATTRIBUTES = new Set([
  'http-equiv', 'target', 'popover', 'popovertarget', 'popovertargetaction',
  'autocomplete', 'tabindex'
])

// CSS 中纯隐藏/替换用途、静态报告基本用不到的属性：出现即删该声明。
const CONCEALMENT_PROPERTIES = new Set([
  'opacity', 'visibility', 'clip', 'clip-path', 'content', 'filter', 'mask',
  'mask-image', 'mask-border', 'box-shadow', 'transform', 'translate', 'rotate',
  'scale', 'text-indent', '-webkit-text-fill-color', 'all'
])

function validationError(code, message) {
  return { code, message }
}

function getAttr(node, name) {
  const lower = name.toLowerCase()
  return node?.attrs?.find(item => item.name.toLowerCase() === lower)?.value ?? null
}

function removeNode(node) {
  const parent = node?.parentNode
  if (!parent?.childNodes) return
  const index = parent.childNodes.indexOf(node)
  if (index >= 0) parent.childNodes.splice(index, 1)
}

function isFragmentUrl(value) {
  const trimmed = String(value || '').trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function keepAttribute(tag, attr) {
  const name = String(attr.name || '').toLowerCase()
  const value = String(attr.value || '')
  if (name.startsWith('on')) return false
  if (STRIP_ATTRIBUTES.has(name)) return false
  if (name === 'hidden') return false
  if (name === 'aria-hidden' && value.toLowerCase() === 'true') return false
  if (RESOURCE_ATTRIBUTES.has(name) && !isFragmentUrl(value)) return false
  return true
}

function sanitizeNode(node) {
  if (!node) return
  const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null
  if (tag) {
    if (STRIP_ELEMENTS.has(tag)) { removeNode(node); return }
    if (tag === 'meta' && String(getAttr(node, 'http-equiv')).toLowerCase() === 'refresh') {
      removeNode(node); return
    }
    const next = []
    for (const attr of node.attrs || []) {
      if (!keepAttribute(tag, attr)) continue
      if (attr.name.toLowerCase() === 'style') {
        const cleaned = sanitizeCss(attr.value)
        if (cleaned.trim()) attr.value = cleaned
        else continue
      }
      next.push(attr)
    }
    node.attrs = next
    if (tag === 'style') {
      for (const child of node.childNodes || []) {
        if (child.nodeName === '#text') child.value = sanitizeCss(child.value || '')
      }
    }
  }
  for (const child of [...(node.childNodes || [])]) sanitizeNode(child)
}

function extractText(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return String(node.value || '')
  if (node.nodeName === '#comment') return ''
  let value = ''
  for (const child of node.childNodes || []) value += extractText(child)
  return value
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

function decodeCssEscapes(value) {
  return String(value || '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\r\n\f])/g, '$1')
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
    if (char === '"' || char === "'") { quote = char; continue }
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

function isTransparentValue(value) {
  return /\btransparent\b|#[0-9a-f]{4}(?:[^0-9a-f]|$)|#[0-9a-f]{8}(?:[^0-9a-f]|$)|\b(?:rgba|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(|\/\s*(?:0(?:\.0+)?%|0\.\d+)/i.test(value)
}

function hasExternalResource(value) {
  return /(?:https?:)?\/\//i.test(value) ||
    /\burl\s*\(/i.test(value) ||
    /\b(?:image-set|cross-fade|image|element|paint)\s*\(/i.test(value) ||
    /\bjavascript:/i.test(value) ||
    /\bdata:/i.test(value)
}

function isConcealingOffset(property, value) {
  if (!['left', 'top', 'right', 'bottom'].includes(property)) return false
  return /-\d{3,}/.test(value)
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

function shouldDropDeclaration(property, value) {
  const p = String(property || '').toLowerCase()
  const v = String(value || '')
  if (CONCEALMENT_PROPERTIES.has(p)) return true
  if (p === 'display' && /^\s*none\b/.test(v)) return true
  if ((p === 'font-size') && /^\s*0+(?:\.0+)?(?:px|rem|em|%|pt|pc)?\s*$/.test(v)) return true
  if (p === 'font' && /(^|\s)0+(?:\.0+)?(?:px|rem|em|pt)?(\s|$)/.test(v)) return true
  if (isConcealingOffset(p, v)) return true
  if (/\bvar\s*\(/i.test(v)) return true
  if (isTransparentValue(v)) return true
  if (hasExternalResource(v)) return true
  return false
}

function sanitizeDeclarations(body) {
  const declarations = cssDeclarations(body)
  if (!declarations) return ''
  const foreground = declarations.find(item => item.property === 'color')
  const background = declarations.find(item =>
    item.property === 'background' || item.property === 'background-color')
  const sameOpaquePair = foreground && background &&
    canonicalSolidColor(foreground.value) && canonicalSolidColor(background.value) &&
    canonicalSolidColor(foreground.value) === canonicalSolidColor(background.value)
  const kept = []
  for (const declaration of declarations) {
    if (shouldDropDeclaration(declaration.property, declaration.value)) continue
    if (sameOpaquePair && (declaration.property === 'color' ||
      declaration.property === 'background' || declaration.property === 'background-color')) continue
    kept.push(`${declaration.property}: ${declaration.value}`)
  }
  return kept.join('; ')
}

function rebuildCss(css) {
  let out = ''
  let i = 0
  const n = css.length
  while (i < n) {
    let j = i
    while (j < n && css[j] !== '{') j += 1
    if (j >= n) { out += css.slice(i); break }
    const head = css.slice(i, j)
    let depth = 1
    let k = j + 1
    while (k < n && depth > 0) {
      if (css[k] === '{') depth += 1
      else if (css[k] === '}') depth -= 1
      k += 1
    }
    const body = css.slice(j + 1, k - 1)
    const prelude = head.trim().toLowerCase()
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') ||
      prelude.startsWith('@keyframes') || prelude.startsWith('@-webkit-keyframes')) {
      const inner = rebuildCss(body)
      if (inner.trim()) out += `${head}{${inner}}`
    } else if (prelude && !prelude.startsWith('@')) {
      const declarations = sanitizeDeclarations(body)
      if (declarations.trim()) out += `${head}{${declarations}}`
    }
    i = k
  }
  return out
}

function sanitizeCss(css) {
  const decoded = stripCssComments(decodeCssEscapes(String(css || '')))
  const stripped = decoded
    .replace(/@(?:import|charset|namespace|use|layer)\b[^;{}]*[;{][^{}]*\}?/gi, ' ')
    .replace(/@(?:font-face|page|document|viewport|counter-style|font-feature-values|property)\b[^{}]*\{[^{}]*\}/gi, ' ')
  return rebuildCss(stripped)
}

export function sanitizeSummaryHtml({ html } = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, code: 'HTML_DOCUMENT_REQUIRED', message: 'AI CLI did not return an HTML document' }
  }
  let document
  try {
    document = parse(html, { sourceCodeLocationInfo: false })
  } catch {
    return { ok: false, code: 'HTML_DOCUMENT_REQUIRED', message: 'AI CLI output could not be parsed as HTML' }
  }
  sanitizeNode(document)
  const text = extractText(document).trim()
  if (!text) {
    return { ok: false, code: 'HTML_DOCUMENT_REQUIRED', message: 'Sanitized document has no visible content' }
  }
  return { ok: true, html: serialize(document) }
}
