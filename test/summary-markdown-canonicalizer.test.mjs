import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalizeInteractiveSummaryMarkdown } from '../electron/summaries/summaryMarkdownCanonicalizer.js'

const CANONICAL = '# 摘要\n\n概览\n\n## 使用量分析\n\n数据\n\n## 项目进展\n\n### 项目 A\n\n#### 已完成\n\n## 跨项目观察\n\n观察\n\n## 下一步建议\n\n建议\n\n## 数据覆盖\n\n完整\n'

function assertInvalid(markdown) {
  assert.throws(() => canonicalizeInteractiveSummaryMarkdown(markdown), (error) => {
    assert.equal(error.code, 'SUMMARY_ARTIFACT_INVALID')
    return true
  })
}

test('peer h1 sections and their children become canonical hierarchy', () => {
  const source = '# 摘要\n\n概览\n\n# 使用量分析\n\n数据\n\n# 项目进展\n\n## 项目 A\n\n### 已完成\n\n# 跨项目观察\n\n观察\n\n# 下一步建议\n\n建议\n\n# 数据覆盖\n\n完整\n'
  const expected = '# 摘要\n\n概览\n\n## 使用量分析\n\n数据\n\n## 项目进展\n\n### 项目 A\n\n#### 已完成\n\n## 跨项目观察\n\n观察\n\n## 下一步建议\n\n建议\n\n## 数据覆盖\n\n完整\n'

  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(source), { markdown: expected, changed: true })
})

test('canonical headings are byte-for-byte unchanged', () => {
  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(CANONICAL), { markdown: CANONICAL, changed: false })
})

test('all-H2 required sections promote the title and preserve descendant hierarchy', () => {
  const source = [
    '## 摘要', '', '概览', '', '### 摘要详情', '', '#### 摘要条目', '',
    '## 使用量分析', '', '数据', '', '### 使用量详情', '',
    '## 项目进展', '', '进展', '', '### 项目详情', '',
    '## 跨项目观察', '', '观察', '', '### 观察详情', '',
    '## 下一步建议', '', '建议', '', '### 建议详情', '',
    '## 数据覆盖', '', '完整', '', '### 覆盖详情', ''
  ].join('\n')
  const expected = [
    '# 摘要', '', '概览', '', '## 摘要详情', '', '### 摘要条目', '',
    '## 使用量分析', '', '数据', '', '### 使用量详情', '',
    '## 项目进展', '', '进展', '', '### 项目详情', '',
    '## 跨项目观察', '', '观察', '', '### 观察详情', '',
    '## 下一步建议', '', '建议', '', '### 建议详情', '',
    '## 数据覆盖', '', '完整', '', '### 覆盖详情', ''
  ].join('\n')

  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(source), { markdown: expected, changed: true })
})

test('mixed H1/H2 required sections are canonicalized', () => {
  const source = CANONICAL.replace('## 使用量分析', '# 使用量分析').replace('## 跨项目观察', '# 跨项目观察')
  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(source), { markdown: CANONICAL, changed: true })
})

test('missing required headings are rejected', () => {
  assertInvalid(CANONICAL.replace('\n\n## 数据覆盖\n\n完整', ''))
})

test('duplicate required headings are rejected', () => {
  assertInvalid(CANONICAL.replace('\n\n## 数据覆盖\n\n完整', '\n\n## 数据覆盖\n\n完整\n\n## 数据覆盖\n\n重复'))
})

test('out-of-order required headings are rejected', () => {
  const source = CANONICAL.replace('## 使用量分析\n\n数据\n\n## 项目进展', '## 项目进展\n\n数据\n\n## 使用量分析')
  assertInvalid(source)
})

test('required headings must remain H1 or H2', () => {
  assertInvalid(CANONICAL.replace('## 项目进展', '### 项目进展'))
  assert.deepEqual(canonicalizeInteractiveSummaryMarkdown(CANONICAL.replace('### 项目 A', '# 项目 A')), {
    markdown: CANONICAL.replace('### 项目 A', '# 项目 A'),
    changed: false
  })
})

test('headings inside fences, blockquotes, and lists are not treated as required headings', () => {
  assertInvalid('```md\n# 摘要\n```\n\n' + CANONICAL.replace('# 摘要\n\n概览\n\n', ''))
  assertInvalid('> # 摘要\n\n' + CANONICAL.replace('# 摘要\n\n', ''))
  assertInvalid('- # 摘要\n\n' + CANONICAL.replace('# 摘要\n\n', ''))
})

test('setext headings are not accepted as required headings', () => {
  assertInvalid(CANONICAL.replace('# 摘要', '摘要\n===') )
})

test('nested H6 that would overflow after shifting is rejected', () => {
  assertInvalid(CANONICAL.replace('## 使用量分析\n\n数据', '# 使用量分析\n\n###### 数据'))
})

test('non-string input is rejected', () => {
  assertInvalid(null)
})
