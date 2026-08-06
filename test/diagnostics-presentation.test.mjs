import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCliDiagnosticSummary, persistenceStatusLabel, profileDiagnosticSummary } from '../src/diagnosticsPresentation.js'

test('persistence labels are localized and safe for every report status', () => {
  assert.equal(persistenceStatusLabel('ready'), '正常')
  assert.equal(persistenceStatusLabel('recovered'), '已从备份恢复')
  assert.equal(persistenceStatusLabel('unavailable'), '当前不可用')
  assert.equal(persistenceStatusLabel('unknown'), '未知')
})

test('profile diagnostic summary uses counts and health only', () => {
  assert.equal(profileDiagnosticSummary({
    total: 4, ready: 2, drifted: 1, missing: 1, codexHomeWritable: true
  }), '4 个档案 · 2 可用 · 1 漂移 · 1 缺失 · 配置目录可写')
})

test('CLI diagnostic summary shows availability without paths or errors', () => {
  const summary = formatCliDiagnosticSummary([
    { id: 'claude', installed: true, version: '1.2.3', path: 'C:\\Users\\Ada\\bin\\claude.cmd' },
    { id: 'codex', installed: true, version: '', error: 'token abc' },
    { id: 'opencode', installed: false, version: 'unused', error: 'not found' }
  ])

  assert.equal(summary, 'claude: 1.2.3 · codex: 已安装 · opencode: 未检测到')
  assert.doesNotMatch(summary, /Ada|abc|not found/)
})
