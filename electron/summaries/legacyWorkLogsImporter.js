import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { bucketStart, nextBucketStart } from '../usage/periods.js'
import { isWorkLogsWorkingFile } from './workLogsService.js'
import { assertSafeSummaryMarkdown } from './summaryMarkdownSafety.js'

const ONE_MEBIBYTE = 1024 * 1024
const MAX_LEGACY_BYTES = 5 * ONE_MEBIBYTE
const LEGACY_PATTERNS = Object.freeze([
  ['day', /^(\d{4})-(\d{2})-(\d{2})-summary\.md$/],
  ['week', /^(\d{4})-W(\d{2})-summary\.md$/],
  ['month', /^(\d{4})-(\d{2})-summary\.md$/],
  ['quarter', /^(\d{4})-Q([1-4])-summary\.md$/],
  ['year', /^(\d{4})-summary\.md$/]
])
const MARKDOWN_HEADING = /^(?:\uFEFF)?[ \t]{0,3}#{1,6}[ \t]+\S.*$/m

function importerError(code) {
  return Object.assign(new Error(code), { code })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function zonedDate(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  })
  let candidate = target
  for (let index = 0; index < 3; index += 1) {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]))
    const represented = Date.UTC(
      Number(fields.year), Number(fields.month) - 1, Number(fields.day),
      Number(fields.hour), Number(fields.minute), Number(fields.second)
    )
    candidate = target - (represented - candidate)
  }
  return candidate
}

function validCalendarDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day))
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
}

function weekStart(year, week) {
  if (week < 1 || week > 53) return null
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const mondayOffset = (jan4.getUTCDay() + 6) % 7
  const start = new Date(Date.UTC(year, 0, 4 - mondayOffset + (week - 1) * 7))
  const thursday = new Date(start.valueOf() + 3 * 24 * 60 * 60 * 1000)
  return thursday.getUTCFullYear() === year ? start : null
}

function parsePeriod(fileName, timeZone) {
  for (const [periodType, pattern] of LEGACY_PATTERNS) {
    const match = pattern.exec(fileName)
    if (!match) continue
    const year = Number(match[1])
    let date
    if (periodType === 'day') {
      const month = Number(match[2])
      const day = Number(match[3])
      if (!validCalendarDate(year, month, day)) return null
      date = { year, month, day }
    } else if (periodType === 'week') {
      const week = weekStart(year, Number(match[2]))
      if (!week) return null
      date = { year: week.getUTCFullYear(), month: week.getUTCMonth() + 1, day: week.getUTCDate() }
    } else if (periodType === 'month') {
      const month = Number(match[2])
      if (!validCalendarDate(year, month, 1)) return null
      date = { year, month, day: 1 }
    } else if (periodType === 'quarter') {
      date = { year, month: (Number(match[2]) - 1) * 3 + 1, day: 1 }
    } else {
      date = { year, month: 1, day: 1 }
    }
    const start = bucketStart(zonedDate(date.year, date.month, date.day, timeZone), periodType, { timeZone })
    return {
      periodType,
      start,
      endExclusive: nextBucketStart(start, periodType, { timeZone }),
      partial: false,
      timezone: timeZone
    }
  }
  return null
}

function safeCreatedAt(value, now) {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), now)) : now
}

function safeEvent(onEvent, code) {
  try { onEvent({ phase: 'legacy-worklog-import', code }) } catch { /* operational logging cannot block import */ }
}

function sameOrdinaryFile(first, second) {
  if (!first?.isFile() || first.isSymbolicLink?.() || !second?.isFile() || second.isSymbolicLink?.()) {
    return false
  }
  if (process.platform !== 'win32' || (first.ino !== 0 && second.ino !== 0)) {
    return first.dev === second.dev && first.ino === second.ino
  }
  return first.size === second.size && first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs && first.birthtimeMs === second.birthtimeMs
}

async function readHandle(handle, size) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (bytesRead === 0) throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
    offset += bytesRead
  }
  return bytes
}

export function createLegacyWorkLogsImporter({
  workLogsRoot,
  repository,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  now = Date.now,
  onEvent = () => {},
  fileSystem = { lstat, open, readdir }
} = {}) {
  if (typeof workLogsRoot !== 'string' || !workLogsRoot.trim()) throw new TypeError('workLogsRoot is required')
  if (!repository || typeof repository.importCompleted !== 'function') {
    throw new TypeError('repository.importCompleted is required')
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0) } catch {
    throw new TypeError('timezone is invalid')
  }
  if (!fileSystem || ['lstat', 'open', 'readdir'].some(method => typeof fileSystem[method] !== 'function')) {
    throw new TypeError('fileSystem must provide lstat, open, and readdir')
  }

  return {
    async run() {
      let entries
      try {
        const rootStat = await fileSystem.lstat(workLogsRoot)
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
          throw importerError('SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED')
        }
        entries = await fileSystem.readdir(workLogsRoot, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED') throw error
        if (error?.code === 'ENOENT') return { scanned: 0, imported: 0, existing: 0, rejected: 0 }
        throw importerError('SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED')
      }
      const candidates = entries
        .filter(entry => !isWorkLogsWorkingFile(entry.name) && parsePeriod(entry.name, timezone))
        .sort((left, right) => left.name.localeCompare(right.name))
      const result = { scanned: candidates.length, imported: 0, existing: 0, rejected: 0 }
      for (const entry of candidates) {
        try {
          const period = parsePeriod(entry.name, timezone)
          const filePath = join(workLogsRoot, entry.name)
          const metadata = await fileSystem.lstat(filePath)
          if (!metadata.isFile() || metadata.isSymbolicLink() ||
            metadata.size < ONE_MEBIBYTE || metadata.size > MAX_LEGACY_BYTES) {
            throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
          }
          let handle
          let bytes
          try {
            handle = await fileSystem.open(filePath, 'r')
            const opened = await handle.stat()
            if (!sameOrdinaryFile(metadata, opened)) throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
            const current = await fileSystem.lstat(filePath)
            if (!sameOrdinaryFile(metadata, current)) throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
            bytes = await readHandle(handle, opened.size)
            const final = await handle.stat()
            if (final.size !== bytes.length || final.size < ONE_MEBIBYTE || final.size > MAX_LEGACY_BYTES) {
              throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
            }
          } finally {
            await handle?.close().catch(() => {})
          }
          let markdown
          try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
            throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
          }
          if (!MARKDOWN_HEADING.test(markdown)) throw importerError('SUMMARY_LEGACY_WORKLOG_REJECTED')
          try { assertSafeSummaryMarkdown(markdown, [workLogsRoot]) } catch {
            throw importerError('SUMMARY_LEGACY_WORKLOG_UNSAFE')
          }
          const sourceHash = `sha256:${sha256(markdown)}`
          const timestamp = safeCreatedAt(metadata.mtimeMs, now())
          const imported = await repository.importCompleted({
            ...period,
            generatedBy: 'manual',
            markdown,
            sourceHash,
            legacyImportKey: `sha256:${sha256(`${entry.name}\0${markdown}`)}`,
            coverage: { legacyFormat: true },
            artifactMetadata: { canonical: 'markdown', bytes: Buffer.byteLength(markdown), sha256: sourceHash },
            createdAt: timestamp,
            updatedAt: timestamp
          })
          if (imported.imported) result.imported += 1
          else result.existing += 1
        } catch (error) {
          result.rejected += 1
          safeEvent(onEvent, error?.code === 'SUMMARY_LEGACY_WORKLOG_UNSAFE'
            ? 'SUMMARY_LEGACY_WORKLOG_UNSAFE'
            : 'SUMMARY_LEGACY_WORKLOG_REJECTED')
        }
      }
      return result
    }
  }
}
