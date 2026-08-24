import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
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

function preparationService(workspaceService, sessions = [
  { id: 's1', session: { id: 's1', cwd: 'C:\\work\\R&D', taskNote: '完成主流程' } },
  { id: 's2', session: { id: 's2', cwd: 'c:/WORK/R&D', taskNote: '继续主流程' } },
  {
    id: 's3',
    session: { id: 's3', cwd: 'C:\\work\\token=super-secret-value', taskNote: '安全项目' }
  }
], historyText = ({ start, sessionId, projectPath }) =>
  `周期-${start} session=${sessionId} token=super-secret-value ${projectPath}\\private.txt`) {
  const projectBySession = new Map(sessions.map(entry => [entry.id, entry.session?.cwd || entry.cwd || '']))
  return createSummaryPreparationService({
    workspaceService,
    listSessions: async () => sessions,
    historyService: {
      loadRange: async ({ start, sessionId }) => ({
        items: [{
          timestamp: start + 1,
          role: 'assistant',
          text: historyText({ start, sessionId, projectPath: projectBySession.get(sessionId) })
        }],
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
  const serializedData = JSON.stringify(firstData)
  assert.doesNotMatch(serializedData, /super-secret-value|C:[\\/]work[\\/]|R&amp;D/i)
  assert.equal('projectPath' in firstData.evidenceBlocks[0], false)
  assert.match(firstData.evidenceBlocks[0].projectId, /^project-[a-f0-9]{32}$/)
  assert.equal(firstData.evidenceBlocks[0].projectId, firstData.evidenceBlocks[1].projectId)
  assert.notEqual(firstData.evidenceBlocks[0].projectId, firstData.evidenceBlocks[2].projectId)
  for (const workspace of [first, second]) {
    const template = await readFile(join(workspace.path, 'input', 'template.md'), 'utf8')
    assert.match(template, /# 摘要/)
    assert.match(template, /安全项目标识/)
    assert.match(template, /模型名、命令、API 名称和其他 identifier/)
    assert.doesNotMatch(template, /原样保留项目路径/)
    assert.match(await readFile(join(workspace.path, 'input', 'README.md'), 'utf8'), /output\/report\.md/)
  }
  assert.deepEqual(Object.keys(firstResult).sort(), ['coverage', 'usageSnapshot', 'workspace'])
  assert.equal(firstResult.workspace, first)
  assert.equal(secondResult.workspace, second)
})

test('preparation derives stable platform-aware project identities without merging root and unknown', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-project-identities')
  const sessions = [
    { id: 'posix-upper', session: { id: 'posix-upper', cwd: '/srv/Repo' } },
    { id: 'posix-lower', session: { id: 'posix-lower', cwd: '/srv/repo' } },
    { id: 'drive-upper', session: { id: 'drive-upper', cwd: 'C:\\Repo' } },
    { id: 'drive-lower', session: { id: 'drive-lower', cwd: 'c:/repo' } },
    { id: 'unc-backslash', session: { id: 'unc-backslash', cwd: '\\\\Server\\Share\\Repo' } },
    { id: 'unc-slash', session: { id: 'unc-slash', cwd: '//server/share/repo' } },
    { id: 'posix-root', session: { id: 'posix-root', cwd: '/' } },
    { id: 'unknown', session: { id: 'unknown' } }
  ]
  await preparationService(workspaceService, sessions).prepare({
    report: report(workspace.id),
    workspace
  })
  const data = JSON.parse(await readFile(join(workspace.path, 'input', 'data.json'), 'utf8'))
  const ids = Object.fromEntries(data.evidenceBlocks.map(block => [block.id.slice('evidence:'.length), block.projectId]))

  assert.notEqual(ids['posix-upper'], ids['posix-lower'])
  assert.equal(ids['drive-upper'], ids['drive-lower'])
  assert.equal(ids['unc-backslash'], ids['unc-slash'])
  assert.notEqual(ids['posix-root'], ids.unknown)
  for (const projectId of Object.values(ids)) assert.match(projectId, /^project-[a-f0-9]{32}$/)
})

test('preparation preserves URL and command slashes while replacing a short POSIX project token', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-posix-path-boundaries')
  const sessions = [
    { id: 'root', session: { id: 'root', cwd: '/' } },
    { id: 'short', session: { id: 'short', cwd: '/a' } }
  ]
  const textBySession = {
    root: '调用 https://api.example.com/v1 并运行 /usr/bin/node',
    short: '读取 /a/file，但接口 /api 必须保留'
  }
  await preparationService(
    workspaceService,
    sessions,
    ({ sessionId }) => textBySession[sessionId]
  ).prepare({ report: report(workspace.id), workspace })
  const data = JSON.parse(await readFile(join(workspace.path, 'input', 'data.json'), 'utf8'))
  const blocks = Object.fromEntries(data.evidenceBlocks.map(block => [block.id.slice('evidence:'.length), block]))

  assert.match(blocks.root.text, /https:\/\/api\.example\.com\/v1/)
  assert.match(blocks.root.text, /\/usr\/bin\/node/)
  assert.doesNotMatch(blocks.short.text, /\/a\/file/)
  assert.match(blocks.short.text, /\[REDACTED:path\]\/file/)
  assert.match(blocks.short.text, /\/api/)
})

test('preparation redacts child paths when project roots include trailing separators', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-trailing-path-separators')
  const sessions = [
    { id: 'windows', session: { id: 'windows', cwd: 'C:\\work\\Repo\\' } },
    { id: 'posix', session: { id: 'posix', cwd: '/srv/repo/' } },
    { id: 'unc-project', session: { id: 'unc-project', cwd: '\\\\Server\\Share\\Repo\\' } },
    { id: 'unc-root', session: { id: 'unc-root', cwd: '\\\\Server\\Share\\' } },
    { id: 'drive-root', session: { id: 'drive-root', cwd: 'C:\\' } }
  ]
  const textBySession = {
    windows: '读取 C:/work/Repo 与 C:/work/Repo/secret.txt',
    posix: '读取 /srv/repo 与 /srv/repo/secret.txt',
    'unc-project': '读取 //Server/Share/Repo 与 //Server/Share/Repo/secret.txt',
    'unc-root': '读取 //Server/Share/secret.txt',
    'drive-root': '读取 C:/secret.txt'
  }
  await preparationService(
    workspaceService,
    sessions,
    ({ sessionId }) => textBySession[sessionId]
  ).prepare({ report: report(workspace.id), workspace })
  const data = JSON.parse(await readFile(join(workspace.path, 'input', 'data.json'), 'utf8'))

  assert.equal(data.evidenceBlocks.length, sessions.length)
  for (const block of data.evidenceBlocks) {
    assert.doesNotMatch(block.text, /(?:C:|\/srv\/repo|\/\/Server\/Share)/i, block.id)
    assert.match(block.text, /\[REDACTED:path\]/, block.id)
  }
})

test('preparation matches mixed Windows separators without changing POSIX path semantics', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-platform-path-semantics')
  const sessions = [
    { id: 'drive', session: { id: 'drive', cwd: 'C:\\work\\Repo\\' } },
    { id: 'unc', session: { id: 'unc', cwd: '\\\\Server\\Share\\Repo\\' } },
    { id: 'posix', session: { id: 'posix', cwd: '/srv/repo' } }
  ]
  const textBySession = {
    drive: '读取 c:/WORK\\Repo/secret.txt',
    unc: '读取 //server\\SHARE/Repo\\secret.txt',
    posix: '保留 /srv/repo\\notes.txt 和 /SRV/REPO/upper.txt；替换 /srv/repo/secret.txt'
  }
  await preparationService(
    workspaceService,
    sessions,
    ({ sessionId }) => textBySession[sessionId]
  ).prepare({ report: report(workspace.id), workspace })
  const data = JSON.parse(await readFile(join(workspace.path, 'input', 'data.json'), 'utf8'))
  const blocks = Object.fromEntries(data.evidenceBlocks.map(block => [block.id.slice('evidence:'.length), block]))

  assert.doesNotMatch(blocks.drive.text, /c:[\\/]/i)
  assert.match(blocks.drive.text, /\[REDACTED:path\]/)
  assert.doesNotMatch(blocks.unc.text, /[\\/]server[\\/]share/i)
  assert.match(blocks.unc.text, /\[REDACTED:path\]/)
  assert.match(blocks.posix.text, /\/srv\/repo\\notes\.txt/)
  assert.match(blocks.posix.text, /\/SRV\/REPO\/upper\.txt/)
  assert.doesNotMatch(blocks.posix.text, /\/srv\/repo\/secret\.txt/)
  assert.match(blocks.posix.text, /\[REDACTED:path\]\/secret\.txt/)
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

test('canonical markdown rejects required headings nested in a blockquote', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-nested-headings-blockquote')
  const markdown = REQUIRED_HEADINGS.map(heading => `> ${heading}`).join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), `${markdown}\n`)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects required headings nested in a list', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-nested-headings-list')
  const markdown = REQUIRED_HEADINGS.map((heading, index) =>
    `${index === 0 ? '- ' : '  '}${heading}`).join('\n\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), `${markdown}\n`)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
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
      waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
      error => error?.code === 'SUMMARY_ARTIFACT_INVALID',
      id
    )
  }
})

test('canonical markdown rejects credential material before returning report bytes', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-credential')
  const markdown = `${VALID_MARKDOWN}\ntoken=super-secret-value\n`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects lexical and real workspace paths case-insensitively', async t => {
  const { temporaryRoot, workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-workspace-path')
  const alias = join(temporaryRoot, 'workspace-alias')
  try {
    await symlink(workspace.path, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows junction capability unavailable')
      return
    }
    throw error
  }
  for (const [name, leakedPath] of [
    ['lexical', alias],
    ['real', await realpath(alias)]
  ]) {
    const markdown = `${VALID_MARKDOWN}\n${leakedPath.toUpperCase().replaceAll('\\', '/')}\n`
    await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)
    await assert.rejects(
      waitForCanonicalMarkdown({ workspacePath: alias, deadlineMs: Date.now() + 2500 }),
      error => error?.code === 'SUMMARY_ARTIFACT_INVALID',
      name
    )
  }
})

test('canonical markdown ignores headings inside backtick and tilde fenced blocks', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-fenced-headings')
  const markdown = [
    '````markdown',
    '```',
    ...REQUIRED_HEADINGS,
    '```',
    '````',
    '~~~text',
    '<!-- ## 使用量分析 -->',
    '<div>## 项目进展</div>',
    ...REQUIRED_HEADINGS,
    '~~~~',
    ''
  ].join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects headings hidden in single and multiline HTML comments', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-html-comment')
  const markdown = [
    VALID_MARKDOWN,
    '<!-- ## 使用量分析 -->',
    '<!--',
    '## 项目进展',
    '## 跨项目观察',
    '-->',
    ''
  ].join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects raw HTML blocks even with a valid heading sequence', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-html-block')
  const markdown = `${VALID_MARKDOWN}\n<section><p>原始 HTML</p></section>\n`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown accepts Markdown autolinks while rejecting raw HTML', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-autolink')
  const markdown = `${VALID_MARKDOWN}\n参考：<https://example.com/report>\n`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 2500
  })
  assert.equal(result.markdown, markdown)
})

test('canonical markdown ignores HTML-looking text in inline escaped and indented code contexts', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-markdown-code-contexts')
  const markdown = [
    VALID_MARKDOWN.trimEnd(),
    '使用 `<div>` 作为示例。',
    '使用 ``<span data-value="`">`` 作为双反引号示例。',
    String.raw`使用 \<div> 作为转义文本。`,
    '',
    '    <div>四空格缩进代码</div>',
    '\t<div>Tab 缩进代码</div>',
    ''
  ].join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 2500
  })
  assert.equal(result.markdown, markdown)
})

test('canonical markdown treats a heading after an unmatched paragraph backtick as a real duplicate', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-unmatched-backtick-duplicate')
  const markdown = [
    VALID_MARKDOWN.trimEnd(),
    '普通段落 `未闭合',
    '# 摘要',
    '后续段落 `收尾',
    ''
  ].join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown accepts a multiline code span within one Markdown paragraph', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-multiline-code-span')
  const markdown = [
    VALID_MARKDOWN.trimEnd(),
    '说明 ``跨行代码开始',
    '仍在同一段落内`` 结束。',
    ''
  ].join('\n')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 2500
  })
  assert.equal(result.markdown, markdown)
})

test('canonical markdown rejects a repeated canonical heading', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-repeated-heading')
  const markdown = `${VALID_MARKDOWN}\n## 使用量分析\n\n重复章节\n`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects an early out-of-order heading followed by a valid sequence', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-early-heading')
  const markdown = `## 项目进展\n\n提前章节\n\n${VALID_MARKDOWN}`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
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
  let finalWriteAt = 0
  const rewrite = setTimeout(() => {
    finalWriteAt = Date.now()
    writeFile(target, `${VALID_MARKDOWN}\n补充内容\n`, 'utf8').catch(() => {})
  }, 200)
  t.after(() => clearTimeout(rewrite))

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 4000
  })

  assert.equal(result.markdown, `${VALID_MARKDOWN}\n补充内容\n`)
  assert.ok(Date.now() - startedAt >= 1100)
  assert.ok(Date.now() - finalWriteAt >= 1000)
})

test('canonical markdown binds validation to the final file after an atomic replacement', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-atomic-replace')
  const target = workspaceService.resolveArtifact(workspace.id, 'output/report.md')
  const replacement = join(workspace.path, 'output', 'replacement.md')
  await writeFile(target, `${VALID_MARKDOWN}\n旧版本\n`, 'utf8')
  await writeFile(replacement, `${VALID_MARKDOWN}\n新版本\n`, 'utf8')
  let replacementAt = 0
  const replacementDone = new Promise((resolve, reject) => {
    const replace = setTimeout(async () => {
      try {
        replacementAt = Date.now()
        await rm(target)
        await rename(replacement, target)
        resolve()
      } catch (error) {
        reject(error)
      }
    }, 200)
    t.after(() => clearTimeout(replace))
  })

  const result = await waitForCanonicalMarkdown({
    workspacePath: workspace.path,
    deadlineMs: Date.now() + 4000
  })
  await replacementDone

  assert.equal(result.markdown, `${VALID_MARKDOWN}\n新版本\n`)
  assert.ok(Date.now() - replacementAt >= 1000)
})

test('canonical markdown rejects an output directory link that escapes the workspace', async t => {
  const { temporaryRoot, workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-output-link')
  const output = join(workspace.path, 'output')
  const outside = join(temporaryRoot, 'outside-output')
  await rm(output, { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'report.md'), VALID_MARKDOWN, 'utf8')
  try {
    await symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows junction capability unavailable')
      return
    }
    throw error
  }

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: Date.now() + 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown rejects when the deadline expires after the stability wait', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-late-deadline')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), VALID_MARKDOWN)
  const realNow = Date.now
  const switchAt = realNow() + 500
  Date.now = () => realNow() < switchAt ? 1000 : 3000
  t.after(() => { Date.now = realNow })

  await assert.rejects(
    waitForCanonicalMarkdown({ workspacePath: workspace.path, deadlineMs: 2500 }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown cancellation wins during the final stability window', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-late-cancel')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), VALID_MARKDOWN)
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), 900)
  t.after(() => clearTimeout(abort))

  await assert.rejects(
    waitForCanonicalMarkdown({
      workspacePath: workspace.path,
      signal: controller.signal,
      deadlineMs: Date.now() + 2500
    }),
    error => error?.code === 'ABORT_ERR'
  )
})

test('canonical markdown cancellation wins after stability during a chunked 5 MiB read', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-read-cancel')
  const maximumBytes = 5 * 1024 * 1024
  const markdown = `${VALID_MARKDOWN}${'x'.repeat(maximumBytes - Buffer.byteLength(VALID_MARKDOWN))}`
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), markdown)
  const controller = new AbortController()
  let chunks = 0

  await assert.rejects(
    waitForCanonicalMarkdown({
      workspacePath: workspace.path,
      signal: controller.signal,
      deadlineMs: Date.now() + 4000,
      onReadChunk() {
        chunks += 1
        controller.abort()
      }
    }),
    error => error?.code === 'ABORT_ERR'
  )
  assert.equal(chunks, 1)
})

test('canonical markdown rejects an asynchronous read hook instead of awaiting it with an open handle', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-async-read-hook')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), VALID_MARKDOWN)

  await assert.rejects(
    waitForCanonicalMarkdown({
      workspacePath: workspace.path,
      deadlineMs: Date.now() + 2500,
      onReadChunk() {
        return Promise.resolve()
      }
    }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
})

test('canonical markdown consumes a rejected asynchronous read hook before failing closed', async t => {
  const { workspaceService } = await fixture(t)
  const workspace = await workspaceService.create('report-rejected-read-hook')
  await writeFile(workspaceService.resolveArtifact(workspace.id, 'output/report.md'), VALID_MARKDOWN)
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  await assert.rejects(
    waitForCanonicalMarkdown({
      workspacePath: workspace.path,
      deadlineMs: Date.now() + 2500,
      onReadChunk() {
        return Promise.reject(new Error('test hook rejection'))
      }
    }),
    error => error?.code === 'SUMMARY_ARTIFACT_INVALID'
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})
