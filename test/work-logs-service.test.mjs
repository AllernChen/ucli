import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkLogsService } from '../electron/summaries/workLogsService.js'

const START = Date.UTC(2026, 7, 10) // 2026-08-10 00:00 UTC
const END = START + 7 * 24 * 60 * 60 * 1000

function fakeHistory(items = []) {
  return {
    loadRange: async () => ({ items, missing: false, truncated: false, nativeDigest: null })
  }
}

const FIXTURE_USAGE = {
  granularity: 'day',
  timezone: 'Asia/Shanghai',
  range: { start: START, endExclusive: END },
  totals: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, turns: 8, activeSessions: 1, approvals: 2 }
}

function fixtureSessions() {
  return [{
    id: 's1',
    session: { id: 's1', cwd: 'C:\\work\\proj', taskNote: '重构权限引擎' }
  }]
}

function fixtureItems() {
  return [
    { timestamp: START + 1000, role: 'user', text: '开始重构权限引擎' },
    { timestamp: START + 2000, role: 'assistant', text: '完成分类器重写' }
  ]
}

async function createTempRoot() {
  return mkdtemp(join(tmpdir(), 'worklogs-'))
}

function createService(workLogsRoot, overrides = {}) {
  return createWorkLogsService({
    workLogsRoot,
    historyService: overrides.historyService || fakeHistory(fixtureItems()),
    listSessions: overrides.listSessions || (async () => fixtureSessions()),
    snapshotUsage: overrides.snapshotUsage || (async () => FIXTURE_USAGE),
    defaultTimezone: overrides.defaultTimezone || 'Asia/Shanghai'
  })
}

test('prepare writes data/template/README and returns the workLogs directory and brief prompt', async (t) => {
  const workLogsRoot = await createTempRoot()
  t.after(() => rm(workLogsRoot, { recursive: true, force: true }))

  const service = createService(workLogsRoot)
  const result = await service.prepare({
    periodType: 'week',
    start: START,
    endExclusive: END,
    timezone: 'Asia/Shanghai'
  })

  assert.equal(result.workLogsDir, workLogsRoot)
  assert.equal(result.suggestedFileName, '2026-W33-summary.md')
  assert.match(result.briefPrompt, /2026-W33-summary\.md/)
  assert.match(result.briefPrompt, /2026-W33-summary\.html/)
  assert.match(result.briefPrompt, /untrusted data/)
  assert.match(result.briefPrompt, /data\.json/)
  assert.match(result.briefPrompt, /template\.md/)

  const data = JSON.parse(await readFile(join(workLogsRoot, 'data.json'), 'utf8'))
  assert.equal(data.period.periodType, 'week')
  assert.equal(data.period.timezone, 'Asia/Shanghai')
  assert.equal(data.period.start, new Date(START).toISOString())
  assert.equal(data.period.endExclusive, new Date(END).toISOString())
  assert.equal(data.usage.totals.inputTokens, 1200)
  assert.equal(data.coverage.sessionsDiscovered, 1)
  assert.ok(Array.isArray(data.evidenceBlocks))
  assert.equal(data.evidenceBlocks[0].projectPath, 'C:/work/proj')
  assert.match(data.evidenceBlocks[0].text, /开始重构权限引擎/)

  const template = await readFile(join(workLogsRoot, 'template.md'), 'utf8')
  assert.match(template, /## 1\. 报告结构/)
  assert.match(template, /## 2\. 分析约束/)
  assert.match(template, /## 3\. HTML 输出要求/)
  assert.match(template, /untrusted data/)
  assert.match(template, /\.kpis/)
  assert.match(template, /<nav aria-label="报告目录">/)

  const readme = await readFile(join(workLogsRoot, 'README.md'), 'utf8')
  assert.match(readme, /data\.json/)
  assert.match(readme, /template\.md/)
  assert.match(readme, /2026-W33-summary\.md/)
  assert.match(readme, /2026-W33-summary\.html/)
})

test('period stamp uses the requested timezone for every cadence', async (t) => {
  const workLogsRoot = await createTempRoot()
  t.after(() => rm(workLogsRoot, { recursive: true, force: true }))

  const service = createService(workLogsRoot)
  const expected = {
    day: '2026-08-10-summary.md',
    week: '2026-W33-summary.md',
    month: '2026-08-summary.md',
    quarter: '2026-Q3-summary.md',
    year: '2026-summary.md'
  }
  for (const [periodType, fileName] of Object.entries(expected)) {
    const result = await service.prepare({
      periodType, start: START, endExclusive: END, timezone: 'Asia/Shanghai'
    })
    assert.equal(result.suggestedFileName, fileName, periodType)
  }
})

test('prepare refuses an invalid period or timezone', async (t) => {
  const workLogsRoot = await createTempRoot()
  t.after(() => rm(workLogsRoot, { recursive: true, force: true }))
  const service = createService(workLogsRoot)

  for (const input of [
    { periodType: 'fortnight', start: START, endExclusive: END, timezone: 'Asia/Shanghai' },
    { periodType: 'week', start: 'not-a-number', endExclusive: END, timezone: 'Asia/Shanghai' },
    { periodType: 'week', start: END, endExclusive: START, timezone: 'Asia/Shanghai' },
    { periodType: 'week', start: START, endExclusive: END, timezone: 'Not/AZone' }
  ]) {
    await assert.rejects(() => service.prepare(input), error => error?.code === 'SUMMARY_PREPARE_INVALID')
  }
})

test('prepare writes only working files and never the per-period report', async (t) => {
  const workLogsRoot = await createTempRoot()
  t.after(() => rm(workLogsRoot, { recursive: true, force: true }))
  const service = createService(workLogsRoot)

  await service.prepare({ periodType: 'week', start: START, endExclusive: END, timezone: 'Asia/Shanghai' })
  await service.prepare({
    periodType: 'week',
    start: END,
    endExclusive: END + 7 * 24 * 60 * 60 * 1000,
    timezone: 'Asia/Shanghai'
  })

  for (const workingFile of ['data.json', 'template.md', 'README.md']) {
    assert.ok(await readFile(join(workLogsRoot, workingFile), 'utf8'), workingFile)
  }
  for (const reportFile of ['2026-W33-summary.md', '2026-W34-summary.md', '2026-W33-summary.html']) {
    await assert.rejects(
      () => readFile(join(workLogsRoot, reportFile), 'utf8'),
      { code: 'ENOENT' },
      reportFile
    )
  }
})
