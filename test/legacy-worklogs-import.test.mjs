import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'
import { createLegacyWorkLogsImporter } from '../electron/summaries/legacyWorkLogsImporter.js'
import { createReportRepository } from '../electron/summaries/reportRepository.js'
import { assertSafeSummaryMarkdown } from '../electron/summaries/summaryMarkdownSafety.js'

const NOW = Date.parse('2026-08-25T08:00:00.000Z')
const ONE_MEBIBYTE = 1024 * 1024
const validMarkdown = `# Legacy work summary\n\n${'x'.repeat(ONE_MEBIBYTE)}`

async function createHarness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ucli-legacy-worklogs-'))
  const db = await openDb(join(root, 'ucli.db'))
  const repository = createReportRepository({ db, now: () => NOW })
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    repository,
    importer: createLegacyWorkLogsImporter({
      workLogsRoot: root,
      repository,
      timezone: 'Asia/Shanghai',
      now: () => NOW,
      ...overrides
    })
  }
}

async function symlinkOrSkip(t, target, link, type = 'file') {
  try {
    await symlink(target, link, type)
    return true
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
    t.skip('symlink creation is unavailable on this host')
    return false
  }
}

test('legacy markdown is imported once and never changes current report', async t => {
  const { root, repository, importer } = await createHarness(t)
  await writeFile(join(root, '2026-W33-summary.md'), validMarkdown)
  const first = await importer.run()
  const second = await importer.run()

  assert.deepEqual(first, { scanned: 1, imported: 1, existing: 0, rejected: 0 })
  assert.deepEqual(second, { scanned: 1, imported: 0, existing: 1, rejected: 0 })
  const [report] = repository.list().filter(item => item.executionMode === 'legacy-worklog-import')
  assert.equal(report.periodType, 'week')
  assert.equal(report.status, 'completed')
  assert.equal(report.isCurrent, false)
  assert.equal(report.coverage.legacyFormat, true)
  assert.equal(report.sourceHash, `sha256:${createHash('sha256').update(validMarkdown).digest('hex')}`)
  assert.match(report.legacyImportKey, /^sha256:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(report).includes(root), false)
})

test('legacy importer derives every cadence from its filename and ignores non-reports', async t => {
  const { root, repository, importer } = await createHarness(t)
  const files = [
    ['2026-08-10-summary.md', 'day'],
    ['2026-W33-summary.md', 'week'],
    ['2026-08-summary.md', 'month'],
    ['2026-Q3-summary.md', 'quarter'],
    ['2026-summary.md', 'year'],
    ['README.md', null],
    ['template.md', null],
    ['2026-W33-summary.html', null]
  ]
  for (const [name] of files) await writeFile(join(root, name), validMarkdown)

  assert.deepEqual(await importer.run(), { scanned: 5, imported: 5, existing: 0, rejected: 0 })
  assert.deepEqual(
    repository.list({ executionMode: 'legacy-worklog-import' }).map(report => report.periodType).sort(),
    ['day', 'month', 'quarter', 'week', 'year']
  )
})

test('legacy importer rejects unsafe content and isolates a failing file', async t => {
  const events = []
  const { root, repository, importer } = await createHarness(t, {
    onEvent: event => events.push(event)
  })
  const good = join(root, '2026-W33-summary.md')
  await writeFile(good, validMarkdown)
  const invalidUtf8 = Buffer.alloc(ONE_MEBIBYTE, 0x61)
  invalidUtf8[0] = 0xff
  await writeFile(join(root, '2026-W34-summary.md'), invalidUtf8)
  await writeFile(join(root, '2026-W35-summary.md'), 'x'.repeat(ONE_MEBIBYTE))
  await writeFile(join(root, '2026-W36-summary.md'), '# too small')
  await mkdir(join(root, '2026-W37-summary.md'))

  assert.deepEqual(await importer.run(), { scanned: 5, imported: 1, existing: 0, rejected: 4 })
  assert.equal(repository.list({ executionMode: 'legacy-worklog-import' }).length, 1)
  assert.deepEqual(events, Array.from({ length: 4 }, () => ({
    phase: 'legacy-worklog-import', code: 'SUMMARY_LEGACY_WORKLOG_REJECTED'
  })))
  assert.doesNotMatch(JSON.stringify(events), /legacy-worklogs|private|invalid|summary\.md/i)
})

test('legacy importer creates a new immutable version when a report file changes', async t => {
  const { root, repository, importer } = await createHarness(t)
  const file = join(root, '2026-W33-summary.md')
  await writeFile(file, validMarkdown)
  await utimes(file, new Date(NOW + 1000), new Date(NOW + 1000))
  await importer.run()
  const [first] = repository.list({ executionMode: 'legacy-worklog-import' })
  await writeFile(file, `${validMarkdown}\n新版内容`)
  await importer.run()
  const reports = repository.list({ executionMode: 'legacy-worklog-import' })

  assert.equal(reports.length, 2)
  assert.equal(reports[0].version, first.version + 1)
  assert.equal(reports[0].legacyImportKey === first.legacyImportKey, false)
  assert.equal(repository.get(first.id).markdown, validMarkdown)
  assert.equal(repository.get(first.id).isCurrent, false)
  assert.equal(reports.every(report => report.isCurrent === false), true)
  assert.equal(reports.every(report => report.createdAt <= NOW && report.createdAt >= 0), true)
})

test('legacy importer leaves source files read-only', async t => {
  const { root, importer } = await createHarness(t)
  const file = join(root, '2026-W33-summary.md')
  await writeFile(file, validMarkdown)
  const before = await readFile(file)
  await importer.run()
  assert.deepEqual(await readFile(file), before)
})

test('legacy importer rejects credentials and its workLogs path without persisting either', async t => {
  const events = []
  const { root, repository, importer } = await createHarness(t, {
    onEvent: event => events.push(event)
  })
  const credential = 'sk-live-abcdefghijklmnopqrstuv'
  await writeFile(join(root, '2026-W33-summary.md'), validMarkdown)
  await writeFile(join(root, '2026-W34-summary.md'), `${validMarkdown}\ncredential=${credential}`)
  await writeFile(join(root, '2026-W35-summary.md'), `${validMarkdown}\n${root}`)

  assert.deepEqual(await importer.run(), { scanned: 3, imported: 1, existing: 0, rejected: 2 })
  const stored = JSON.stringify(repository.list({ executionMode: 'legacy-worklog-import' }))
  assert.doesNotMatch(stored, new RegExp(credential))
  assert.equal(stored.includes(root), false)
  assert.deepEqual(events, Array.from({ length: 2 }, () => ({
    phase: 'legacy-worklog-import', code: 'SUMMARY_LEGACY_WORKLOG_UNSAFE'
  })))
})

test('legacy importer accepts a UTF-8 BOM with canonical markdown bytes', async t => {
  const { root, repository, importer } = await createHarness(t)
  const markdown = `\uFEFF${validMarkdown}`
  await writeFile(join(root, '2026-W33-summary.md'), markdown, 'utf8')

  assert.deepEqual(await importer.run(), { scanned: 1, imported: 1, existing: 0, rejected: 0 })
  assert.equal(repository.list()[0].markdown, validMarkdown)
  assert.equal(repository.list()[0].artifactMetadata.bytes, Buffer.byteLength(validMarkdown))
  assert.deepEqual(await importer.run(), { scanned: 1, imported: 0, existing: 1, rejected: 0 })
})

test('legacy importer rejects a symlink workLogs root', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ucli-legacy-worklogs-root-'))
  const target = join(sandbox, 'target')
  const linkedRoot = join(sandbox, 'workLogs')
  await mkdir(target)
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  if (!await symlinkOrSkip(t, target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')) return

  const repository = { async importCompleted() { throw new Error('must not import') } }
  const importer = createLegacyWorkLogsImporter({
    workLogsRoot: linkedRoot, repository, timezone: 'Asia/Shanghai', now: () => NOW
  })
  await assert.rejects(() => importer.run(), error => error?.code === 'SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED')
})

test('legacy importer rejects a report swapped to a symlink before open', async t => {
  const { root, repository } = await createHarness(t)
  const file = join(root, '2026-W33-summary.md')
  const backup = join(root, 'original-summary.md')
  const probe = join(root, 'symlink-capability-probe')
  await writeFile(file, validMarkdown)
  if (!await symlinkOrSkip(t, file, probe)) return
  await unlink(probe)
  let swapped = false
  const importer = createLegacyWorkLogsImporter({
    workLogsRoot: root,
    repository,
    timezone: 'Asia/Shanghai',
    now: () => NOW,
    fileSystem: {
      lstat,
      readdir,
      open: async candidate => {
        if (!swapped && candidate === file) {
          swapped = true
          await rename(file, backup)
          await symlink(backup, file, 'file')
        }
        return open(candidate, 'r')
      }
    }
  })

  assert.deepEqual(await importer.run(), { scanned: 1, imported: 0, existing: 0, rejected: 1 })
  assert.equal(repository.list({ executionMode: 'legacy-worklog-import' }).length, 0)
})

test('summary markdown safety rejects Windows and POSIX lexical root aliases', () => {
  assert.throws(
    () => assertSafeSummaryMarkdown('# Summary\nC:\\safe\\segment\\..\\workLogs', ['C:\\safe\\workLogs']),
    { code: 'SUMMARY_MARKDOWN_UNSAFE' }
  )
  assert.throws(
    () => assertSafeSummaryMarkdown('# Summary\n/var/lib/ucli/segment/../workLogs', ['/var/lib/ucli/workLogs']),
    { code: 'SUMMARY_MARKDOWN_UNSAFE' }
  )
})

test('legacy importer rejects a root swapped to a link after enumeration', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ucli-legacy-root-swap-'))
  const root = join(sandbox, 'workLogs')
  const moved = join(sandbox, 'moved-workLogs')
  const external = join(sandbox, 'external')
  await mkdir(root)
  await mkdir(external)
  await writeFile(join(root, '2026-W33-summary.md'), validMarkdown)
  await writeFile(join(external, '2026-W33-summary.md'), validMarkdown)
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const probe = join(sandbox, 'capability-probe')
  if (!await symlinkOrSkip(t, external, probe, linkType)) return
  await unlink(probe)
  let swapped = false
  const imported = []
  const importer = createLegacyWorkLogsImporter({
    workLogsRoot: root,
    repository: { async importCompleted(input) { imported.push(input); return { imported: true } } },
    timezone: 'Asia/Shanghai',
    now: () => NOW,
    fileSystem: {
      lstat,
      open,
      readdir: async (...args) => {
        const entries = await readdir(...args)
        if (!swapped) {
          swapped = true
          await rename(root, moved)
          await symlink(external, root, linkType)
        }
        return entries
      }
    }
  })

  await assert.rejects(() => importer.run(), error => error?.code === 'SUMMARY_LEGACY_WORKLOG_IMPORT_FAILED')
  assert.equal(imported.length, 0)
})

test('legacy importer bounds an oversized opened handle before any read', async t => {
  const { root, repository } = await createHarness(t)
  const file = join(root, '2026-W33-summary.md')
  await writeFile(file, validMarkdown)
  const pre = await lstat(file)
  const oversized = {
    dev: pre.dev,
    ino: pre.ino,
    size: 5 * ONE_MEBIBYTE + 2,
    mtimeMs: pre.mtimeMs,
    ctimeMs: pre.ctimeMs,
    birthtimeMs: pre.birthtimeMs,
    isFile: () => true,
    isSymbolicLink: () => false
  }
  const reads = []
  const importer = createLegacyWorkLogsImporter({
    workLogsRoot: root,
    repository,
    timezone: 'Asia/Shanghai',
    now: () => NOW,
    fileSystem: {
      lstat,
      readdir,
      open: async () => ({
        async stat() { return oversized },
        async read(buffer, offset, length) {
          reads.push(length)
          return { bytesRead: 0 }
        },
        async close() {}
      })
    }
  })

  assert.deepEqual(await importer.run(), { scanned: 1, imported: 0, existing: 0, rejected: 1 })
  assert.deepEqual(reads, [])
  assert.equal(reads.every(bytes => bytes <= 5 * ONE_MEBIBYTE + 1), true)
  assert.equal(repository.list({ executionMode: 'legacy-worklog-import' }).length, 0)
})

test('legacy importer rejects a handle whose final stat changes during reading', async t => {
  const { root, repository } = await createHarness(t)
  const file = join(root, '2026-W33-summary.md')
  await writeFile(file, validMarkdown)
  const pre = await lstat(file)
  const initial = {
    dev: pre.dev, ino: pre.ino, size: pre.size, mtimeMs: pre.mtimeMs,
    ctimeMs: pre.ctimeMs, birthtimeMs: pre.birthtimeMs,
    isFile: () => true, isSymbolicLink: () => false
  }
  const changed = { ...initial, mtimeMs: pre.mtimeMs + 1 }
  const source = Buffer.from(validMarkdown)
  let statCalls = 0
  let sent = false
  const importer = createLegacyWorkLogsImporter({
    workLogsRoot: root,
    repository,
    timezone: 'Asia/Shanghai',
    now: () => NOW,
    fileSystem: {
      lstat,
      readdir,
      open: async () => ({
        async stat() { return ++statCalls === 1 ? initial : changed },
        async read(buffer, offset) {
          if (sent) return { bytesRead: 0 }
          sent = true
          source.copy(buffer, offset)
          return { bytesRead: source.length }
        },
        async close() {}
      })
    }
  })

  assert.deepEqual(await importer.run(), { scanned: 1, imported: 0, existing: 0, rejected: 1 })
  assert.equal(repository.list({ executionMode: 'legacy-worklog-import' }).length, 0)
})
