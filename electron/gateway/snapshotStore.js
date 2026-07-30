import { randomUUID } from 'node:crypto'

import { redactDisplayText } from './redaction.js'
import {
  buildPlanUnavailableView,
  buildResultUnavailableView,
  planReviewActions
} from './viewModels.js'

function normalizeMarkdown(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    (typeof value.isWellFormed === 'function' && !value.isWellFormed())
  ) return null
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim()
}

function codePointLength(value) {
  return Array.from(value).length
}

function splitCodePoints(value, chunkSize) {
  const points = Array.from(value)
  const chunks = []
  for (let index = 0; index < points.length; index += chunkSize) {
    chunks.push(points.slice(index, index + chunkSize).join(''))
  }
  return chunks
}

function headingsOf(markdown) {
  return [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)]
    .map((match) => ({
      level: match[1].length,
      title: match[2].trim(),
      index: match.index,
      length: match[0].length
    }))
}

function goalOf(markdown, headings) {
  const goalIndex = headings.findIndex((heading) =>
    /^(?:goal|目标|objective)$/i.test(heading.title)
  )
  if (goalIndex < 0) return null
  const heading = headings[goalIndex]
  const end = headings[goalIndex + 1]?.index ?? markdown.length
  const section = markdown.slice(heading.index + heading.length, end)
  const paragraphs = section.split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return paragraphs[0] || null
}

function filePathsOf(markdown) {
  const pattern = /(?:[A-Za-z]:\\(?:[^\\\s`"'<>|]+\\)*[^\\\s`"'<>|]+|(?:\.{0,2}\/|\/)?(?:[\p{L}\p{N}_@.-]+[\\/])+[\p{L}\p{N}_@.-]+\.[A-Za-z0-9]{1,12})/gu
  const unique = []
  const seen = new Set()
  for (const match of markdown.matchAll(pattern)) {
    const path = match[0].replace(/[.,;:!?]+$/g, '')
    if (!seen.has(path)) {
      seen.add(path)
      unique.push(path)
    }
  }
  return unique
}

export function buildPlanOverview(value) {
  const markdown = normalizeMarkdown(value) || ''
  const headings = headingsOf(markdown)
  const filePaths = filePathsOf(markdown)
  const goal = goalOf(markdown, headings)
  if (!headings.length && !goal && !filePaths.length) {
    return {
      title: '内容预览',
      preview: Array.from(markdown).slice(0, 300).join(''),
      goal: null,
      headings: [],
      filePaths: [],
      headingCount: 0,
      fileCount: 0,
      characterCount: codePointLength(markdown)
    }
  }
  return {
    title: headings[0]?.title || '方案概览',
    goal,
    headings: headings.slice(1, 6).map((heading) => heading.title),
    filePaths: filePaths.slice(0, 8),
    headingCount: headings.length,
    fileCount: filePaths.length,
    characterCount: codePointLength(markdown)
  }
}

export class SnapshotStore {
  constructor({ chunkSize = 3000 } = {}) {
    this.chunkSize = Math.max(1, Math.floor(chunkSize))
    this._plans = new Map()
    this._results = new Map()
  }

  storePlan(value) {
    const markdown = normalizeMarkdown(value)
    if (!markdown) return buildPlanUnavailableView()
    const planSnapshotId = randomUUID()
    this._plans.set(planSnapshotId, markdown)
    return {
      available: true,
      planSnapshotId,
      overview: buildPlanOverview(markdown)
    }
  }

  storeResult(value) {
    const markdown = normalizeMarkdown(value)
    if (!markdown) return buildResultUnavailableView()
    const resultSnapshotId = randomUUID()
    this._results.set(resultSnapshotId, markdown)
    return {
      available: true,
      resultSnapshotId
    }
  }

  getPlanChunks(planSnapshotId) {
    const markdown = this._plans.get(planSnapshotId)
    if (!markdown) return null
    return this._chunks(markdown, { plan: true })
  }

  getResultChunks(resultSnapshotId) {
    const markdown = this._results.get(resultSnapshotId)
    if (!markdown) return null
    return this._chunks(markdown, { plan: false })
  }

  _chunks(markdown, { plan }) {
    const display = redactDisplayText(markdown)
    if (display.desktopOnly) {
      return [{
        index: 1,
        total: 1,
        markdown: display.text,
        desktopOnly: true,
        actions: []
      }]
    }
    const textChunks = splitCodePoints(display.text, this.chunkSize)
    return textChunks.map((text, index) => ({
      index: index + 1,
      total: textChunks.length,
      markdown: text,
      desktopOnly: false,
      actions: plan && index === textChunks.length - 1
        ? planReviewActions()
        : []
    }))
  }

  clear() {
    this._plans.clear()
    this._results.clear()
  }
}
