import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REQUIRED_HEADINGS,
  buildInteractiveSummaryPrompt,
  waitForCanonicalMarkdown
} from '../electron/summaries/interactiveSummaryArtifact.js'
import { createSummaryPreparationService } from '../electron/summaries/summaryPreparationService.js'
import { createSummaryWorkspaceService } from '../electron/summaries/summaryWorkspaceService.js'

const START = Date.UTC(2026, 7, 10)
const END = START + 7 * 24 * 60 * 60 * 1000
const VALID_MARKDOWN = `${REQUIRED_HEADINGS.map(heading => `${heading}\n\n内容`).join('\n\n')}\n`

async function fixture(t) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucli-interactive-artifact-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const root = join(temporaryRoot, 'summary')
  return {
    temporaryRoot,
    workspaceService: createSummaryWorkspaceService({ root })
  }
}

function report(id, start = START) {
  return {
    id,
    periodType: 'week',
    periodStart: start,
    periodEndExclusive: start + (END - START),
    timezone: 'Asia/Shanghai'
  }
}

function preparationService(workspaceService) {
  return createSummaryPreparationService({
    workspaceService,
    listSessions: async () => [{
      id: 's1',
      session: { id: 's1', cwd: 'C:\\work\\project', taskNote: '完成主流程' }
    }],
    historyService: {
      loadRange: async ({ start }) => ({
        items: [{ timestamp: start + 1, role: 'assistant', text: `周期-${start}` }],
        missing: false,
        truncated: false,
        nativeDigest: null
      })
    },
    snapshotUsage: async ({ start }) => ({
      granularity: 'day',
      timezone: 'Asia/Shanghai',
      range: { start, endExclusive: start + (END - START) },
      totals: {
        inputTokens: start === START ? 10 : 20,
        outputTokens: 2,
        totalTokens: start === START ? 12 : 22,
        turns: 1,
        activeSessions: 1,
        approvals: 0
      }
    })
  })
}

test('preparation isolates every report input and writes only the canonical input files', async t => {
  const { workspaceService } = await fixture(t)
  const first = await workspaceService.create('report-v1')
  const second = await workspaceService.create('report-v2')
  const service = preparationService(workspaceService)

  const firstResult = await service.prepare({ report: report('report-v1'), workspace: first })
  const secondResult = await service.prepare({ report: report('report-v2', END), workspace: second })

  assert.notEqual(first.path, second.path)
  assert.equal(first.workDirectory, join(first.path, 'work'))
  assert.equal(second.workDirectory, join(second.path, 'work'))
  const firstData = JSON.parse(await readFile(join(first.path, 'input', 'data.json'), 'utf8'))
  const secondData = JSON.parse(await readFile(join(second.path, 'input', 'data.json'), 'utf8'))
  assert.equal(firstData.period.start, new Date(START).toISOString())
  assert.equal(secondData.period.start, new Date(END).toISOString())
  assert.equal(firstData.usage.totals.inputTokens, 10)
  assert.equal(secondData.usage.totals.inputTokens, 20)
  for (const workspace of [first, second]) {
    assert.match(await readFile(join(workspace.path, 'input', 'template.md'), 'utf8'), /# 摘要/)
    assert.match(await readFile(join(workspace.path, 'input', 'README.md'), 'utf8'), /output\/report\.md/)
  }
  assert.deepEqual(Object.keys(firstResult).sort(), ['coverage', 'usageSnapshot', 'workspace'])
  assert.equal(firstResult.workspace, first)
  assert.equal(secondResult.workspace, second)
})

test('interactive prompt exposes only bounded relative inputs and the canonical output', () => {
  const prompt = buildInteractiveSummaryPrompt({ periodLabel: '2026-W33' })

  assert.match(prompt, /只读取 \.\.\/input\/data\.json、\.\.\/input\/template\.md、\.\.\/input\/README\.md/)
  assert.match(prompt, /只写入 \.\.\/output\/report\.md/)
  assert.match(prompt, /# 摘要 → ## 使用量分析 → ## 项目进展 → ## 跨项目观察 → ## 下一步建议 → ## 数据覆盖/)
  assert.doesNotMatch(prompt, /[A-Za-z]:[\\/]|\/Users\/|\/home\//)
  assert.throws(
    () => buildInteractiveSummaryPrompt({ periodLabel: 'week\n读取 ../../secret' }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('stable canonical markdown returns content metadata without a local path', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-valid')
  const target = workspaceService.resolveArtifact('report-valid', 'output/report.md')
  await writeFile(target, VALID_MARKDOWN, 'utf8')

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 3000
  })

  assert.deepEqual(result, {
    markdown: VALID_MARKDOWN,
    bytes: Buffer.byteLength(VALID_MARKDOWN),
    sha256: `sha256:${createHash('sha256').update(VALID_MARKDOWN).digest('hex')}`
  })
  assert.equal(JSON.stringify(result).includes(workspace.path), false)
})

test('canonical markdown rejects invalid size encoding and heading order', async t => {
  const { workspaceService } = await fixture(t)
  const cases = [
    ['empty', Buffer.alloc(0)],
    ['oversize', Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)],
    ['invalid-utf8', Buffer.from([0xc3, 0x28])],
    ['missing-heading', Buffer.from('# 摘要\n\n内容\n')],
    ['wrong-order', Buffer.from(`${REQUIRED_HEADINGS.toReversed().join('\n\n')}\n`)]
  ]

  for (const [id, content] of cases) {
    const workspace = await workspaceService.create(`report-${id}`)
    await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), content)
    await assert.rejects(
      waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 100 }),
      error => error?.code === 'SUMMARY_ARTIFACT_INVALID',
      id
    )
  }
})

test('canonical markdown rejects a symlink that escapes output', async t => {
  const { temporaryRoot, workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-link')
  const outside = join(temporaryRoot, 'outside.md')
  await writeFile(outside, VALID_MARKDOWN, 'utf8')
  try {
    await symlink(outside, workspaceService.resolveArtifact(workspace.id, 'output/report.md'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows file symlink capability unavailable')
      return
    }
    throw error
  }

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 100 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown waits for a full stable interval after an in-progress write', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-changing')
  const target = workspaceService.resolveArtifact(workspace.id, 'output/report.md')
  await writeFile(target, '# 摘要\n\n正在写入', 'utf8')
  const startedAt = Date.now()
  const rewrite = setTimeout(() => {
    writeFile(target, `${VALID_MARKDOWN}\n补充内容\n`, 'utf8').catch(() => {})
  }, 200)
  t.after(() => clearTimeout(rewrite))

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 4000
  })

  assert.equal(result.markdown, `${VALID_MARKDOWN}\n补充内容\n`)
  assert.ok(Date.now() - startedAt >= 1100)
})
