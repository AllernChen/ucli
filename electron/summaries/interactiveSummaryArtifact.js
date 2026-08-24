import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

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

async function inspectCanonicalTarget(workspacePath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw artifactError()
  const target = path.resolve(workspacePath, 'output', 'report.md')
  const output = path.resolve(workspacePath, 'output')
  if (!isContained(workspacePath, target)) throw artifactError()

  let targetStat
  let realWorkspace
  let realOutput
  let realTarget
  try {
    targetStat = await lstat(target)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw artifactError()
    ;[realWorkspace, realOutput, realTarget] = await Promise.all([
      realpath(workspacePath),
      realpath(output),
      realpath(target)
    ])
  } catch (error) {
    if (error?.code === 'SUMMARY_ARTIFACT_INVALID') throw error
    if (error?.code === 'ENOENT') return null
    throw artifactError()
  }
  if (!isContained(realWorkspace, realOutput) || !isContained(realOutput, realTarget)) {
    throw artifactError()
  }
  if (targetStat.size < 1 || targetStat.size > MAX_MARKDOWN_BYTES) throw artifactError()
  return { target, stat: targetStat }
}

function decodeMarkdown(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw artifactError()
  }
}

function assertHeadingOrder(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd())
  let cursor = -1
  for (const heading of REQUIRED_HEADINGS) {
    const index = lines.indexOf(heading, cursor + 1)
    if (index === -1) throw artifactError()
    cursor = index
  }
}

async function readValidatedMarkdown(target) {
  let buffer
  try {
    buffer = await readFile(target)
  } catch {
    throw artifactError()
  }
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_MARKDOWN_BYTES) throw artifactError()
  const markdown = decodeMarkdown(buffer)
  assertHeadingOrder(markdown)
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

function sameStableFile(first, second) {
  return first.size === second.size && first.mtimeMs === second.mtimeMs &&
    first.dev === second.dev && first.ino === second.ino
}

export async function waitForCanonicalMarkdown({ workspacePath, signal, deadlineMs } = {}) {
  if (!Number.isFinite(deadlineMs)) throw artifactError()
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) throw abortError()
    const first = await inspectCanonicalTarget(workspacePath)
    if (!first) {
      await delay(Math.min(MISSING_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())), signal)
      continue
    }
    if (Date.now() + STABILITY_INTERVAL_MS > deadlineMs) throw artifactError()
    await delay(STABILITY_INTERVAL_MS, signal)
    const second = await inspectCanonicalTarget(workspacePath)
    if (!second || !sameStableFile(first.stat, second.stat)) continue
    const { buffer, markdown } = await readValidatedMarkdown(second.target)
    const finalStat = await lstat(second.target).catch(() => null)
    if (!finalStat || !sameStableFile(second.stat, finalStat) || finalStat.size !== buffer.byteLength) continue
    return {
      markdown,
      bytes: buffer.byteLength,
      sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`
    }
  }
  throw artifactError()
}
