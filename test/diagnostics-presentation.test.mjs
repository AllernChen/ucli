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

test('profile diagnostic summary adds safe Claude connection counts', () => {
  assert.equal(profileDiagnosticSummary({
    total: 3, ready: 2, drifted: 0, missing: 1, codexHomeWritable: true,
    claude: {
      total: 3,
      connectionModes: { subscription: 1, apiKey: 1, bearer: 1 },
      missingSecret: 1,
      modelSubstitutions: 2
    }
  }), '3 个档案 · 2 可用 · 0 漂移 · 1 缺失 · 配置目录可写 · Claude：1 登录态 / 1 API Key / 1 Bearer，1 缺少凭据，2 模型替换')
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
