import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

import { redactEvidenceText } from './redaction.js'
import { createSummaryMarkdownParser } from './summaryMarkdownParser.js'

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024
const STABILITY_INTERVAL_MS = 1000
const MISSING_POLL_INTERVAL_MS = 50

export const REQUIRED_HEADINGS = Object.freeze([
  '# 摘要',
  '## 使用量分析',
  '## 项目进展',
  '## 跨项目观察',
  '## 下一步建议',
  '## 数据覆盖'
])

const REQUIRED_HEADING_TOKENS = Object.freeze(REQUIRED_HEADINGS.map(heading => {
  const markerEnd = heading.indexOf(' ')
  return Object.freeze({
    tag: `h${markerEnd}`,
    content: heading.slice(markerEnd + 1)
  })
}))
const validationMarkdownParser = createSummaryMarkdownParser({ html: true })

function artifactError() {
  return Object.assign(new Error('Invalid canonical summary artifact'), {
    code: 'SUMMARY_ARTIFACT_INVALID'
  })
}

function abortError() {
  return Object.assign(new Error('Summary artifact validation aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  })
}

function requireSafeLabel(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw artifactError()
  }
  return value.trim()
}

export function buildInteractiveSummaryPrompt({ periodLabel } = {}) {
  const label = requireSafeLabel(periodLabel)
  return [
    `为 ${label} 生成工作总结。`,
    '只读取 ../input/data.json、../input/template.md、../input/README.md。',
    '只写入 ../output/report.md；不要生成 HTML，不要改动其他文件。',
    `标题必须按此顺序出现：${REQUIRED_HEADINGS.join(' → ')}。`
  ].join('\n')
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function checkActive(signal, deadlineMs) {
  if (signal?.aborted) throw abortError()
  if (Date.now() >= deadlineMs) throw artifactError()
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino
}

function sameStableFile(first, second) {
  return sameFile(first, second) && first.size === second.size && first.mtimeMs === second.mtimeMs
}

function normalizedPathText(value) {
  return String(value).replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase()
}

function assertSafeMarkdown(markdown, unsafePaths) {
  if (redactEvidenceText(markdown).total > 0) throw artifactError()
  const normalized = normalizedPathText(markdown)
  for (const unsafePath of unsafePaths) {
    const candidate = normalizedPathText(unsafePath)
    if (candidate && normalized.includes(candidate)) throw artifactError()
  }
}

async function resolvedPath(value, signal, deadlineMs) {
  const resolved = await realpath(value)
  checkActive(signal, deadlineMs)
  return resolved
}

async function pathStat(value, signal, deadlineMs) {
  const result = await lstat(value)
  checkActive(signal, deadlineMs)
  return result
}

async function openCanonicalTarget(workspacePath, signal, deadlineMs) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw artifactError()
  checkActive(signal, deadlineMs)
  const target = path.resolve(workspacePath, 'output', 'report.md')
  const output = path.resolve(workspacePath, 'output')
  if (!isContained(workspacePath, target)) throw artifactError()

  let realWorkspace
  let realOutput
  let realTarget
  let targetStat
  try {
    realWorkspace = await resolvedPath(workspacePath, signal, deadlineMs)
    realOutput = await resolvedPath(output, signal, deadlineMs)
    targetStat = await pathStat(target, signal, deadlineMs)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw artifactError()
    realTarget = await resolvedPath(target, signal, deadlineMs)
  } catch (error) {
    if (error?.code === 'SUMMARY_ARTIFACT_INVALID' || error?.code === 'ABORT_ERR') throw error
    if (error?.code === 'ENOENT') {
      checkActive(signal, deadlineMs)
      return null
    }
    throw artifactError()
  }
  if (!isContained(realWorkspace, realOutput) || !isContained(realOutput, realTarget) ||
    targetStat.size < 1 || targetStat.size > MAX_MARKDOWN_BYTES) {
    throw artifactError()
  }

  let handle
  try {
    handle = await open(target, 'r')
    checkActive(signal, deadlineMs)
    const openedStat = await handle.stat()
    checkActive(signal, deadlineMs)
    if (!openedStat.isFile() || !sameStableFile(targetStat, openedStat)) throw artifactError()
    checkActive(signal, deadlineMs)
    return { handle, stat: openedStat, target, output, realWorkspace }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'SUMMARY_ARTIFACT_INVALID' || error?.code === 'ABORT_ERR') throw error
    if (error?.code === 'ENOENT') {
      checkActive(signal, deadlineMs)
      return null
    }
    throw artifactError()
  }
}

async function currentPathMatches(candidate, signal, deadlineMs) {
  try {
    const currentWorkspace = await resolvedPath(path.dirname(candidate.output), signal, deadlineMs)
    const currentOutput = await resolvedPath(candidate.output, signal, deadlineMs)
    const currentStat = await pathStat(candidate.target, signal, deadlineMs)
    const currentTarget = await resolvedPath(candidate.target, signal, deadlineMs)
    if (!isContained(currentWorkspace, currentOutput) || !isContained(currentOutput, currentTarget)) {
      throw artifactError()
    }
    const matches = normalizedPathText(currentWorkspace) === normalizedPathText(candidate.realWorkspace) &&
      currentStat.isFile() && !currentStat.isSymbolicLink() &&
      sameStableFile(candidate.stat, currentStat)
    checkActive(signal, deadlineMs)
    return matches
  } catch (error) {
    if (error?.code === 'SUMMARY_ARTIFACT_INVALID' || error?.code === 'ABORT_ERR') throw error
    if (error?.code === 'ENOENT') {
      checkActive(signal, deadlineMs)
      return false
    }
    throw artifactError()
  }
}

function decodeMarkdown(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw artifactError()
  }
}

function assertHeadingOrder(markdown) {
  const tokens = validationMarkdownParser.parse(markdown, {})
  const found = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'html_block' || token.type === 'html_inline' ||
      token.children?.some(child => child.type === 'html_block' || child.type === 'html_inline')) {
      throw artifactError()
    }
    if (token.type !== 'heading_open') continue
    const inline = tokens[index + 1]
    const required = REQUIRED_HEADING_TOKENS.find(heading =>
      heading.tag === token.tag && heading.content === inline?.content)
    if (required) found.push(required)
  }
  if (found.length !== REQUIRED_HEADING_TOKENS.length ||
    found.some((heading, index) => heading !== REQUIRED_HEADING_TOKENS[index])) {
    throw artifactError()
  }
}

async function readFromHandle(handle, size, signal, deadlineMs, onReadChunk) {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < buffer.byteLength) {
    checkActive(signal, deadlineMs)
    const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset)
    checkActive(signal, deadlineMs)
    if (bytesRead === 0) return null
    offset += bytesRead
    if (onReadChunk) {
      const hookResult = onReadChunk({ bytesRead, offset, total: buffer.byteLength })
      if (hookResult && typeof hookResult.then === 'function') {
        Promise.resolve(hookResult).catch(() => {})
        throw artifactError()
      }
      checkActive(signal, deadlineMs)
    }
  }
  checkActive(signal, deadlineMs)
  return buffer
}

function validateMarkdown(buffer, unsafePaths) {
  if (!buffer || buffer.byteLength < 1 || buffer.byteLength > MAX_MARKDOWN_BYTES) throw artifactError()
  const markdown = decodeMarkdown(buffer)
  assertHeadingOrder(markdown)
  assertSafeMarkdown(markdown, unsafePaths)
  return { buffer, markdown }
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function waitForCanonicalMarkdown({ workspacePath, signal, deadlineMs, onReadChunk } = {}) {
  if (!Number.isFinite(deadlineMs) || (onReadChunk !== undefined && typeof onReadChunk !== 'function')) {
    throw artifactError()
  }
  while (true) {
    checkActive(signal, deadlineMs)
    const candidate = await openCanonicalTarget(workspacePath, signal, deadlineMs)
    checkActive(signal, deadlineMs)
    if (!candidate) {
      await delay(Math.min(MISSING_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())), signal)
      checkActive(signal, deadlineMs)
      continue
    }
    try {
      if (Date.now() + STABILITY_INTERVAL_MS > deadlineMs) throw artifactError()
      await delay(STABILITY_INTERVAL_MS, signal)
      checkActive(signal, deadlineMs)
      const stableStat = await candidate.handle.stat()
      checkActive(signal, deadlineMs)
      if (!sameStableFile(candidate.stat, stableStat) ||
        !await currentPathMatches(candidate, signal, deadlineMs)) continue
      checkActive(signal, deadlineMs)
      const buffer = await readFromHandle(candidate.handle, stableStat.size, signal, deadlineMs, onReadChunk)
      checkActive(signal, deadlineMs)
      const finalStat = await candidate.handle.stat()
      checkActive(signal, deadlineMs)
      if (!buffer || !sameStableFile(stableStat, finalStat) || finalStat.size !== buffer.byteLength ||
        !await currentPathMatches(candidate, signal, deadlineMs)) continue
      checkActive(signal, deadlineMs)
      const realWorkspace = await resolvedPath(workspacePath, signal, deadlineMs)
      const { markdown } = validateMarkdown(buffer, [workspacePath, realWorkspace])
      checkActive(signal, deadlineMs)
      await candidate.handle.close()
      candidate.handle = null
      checkActive(signal, deadlineMs)
      return {
        markdown,
        bytes: buffer.byteLength,
        sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`
      }
    } catch (error) {
      if (error?.code === 'SUMMARY_ARTIFACT_INVALID' || error?.code === 'ABORT_ERR') throw error
      throw artifactError()
    } finally {
      await candidate.handle?.close().catch(() => {})
    }
  }
}
