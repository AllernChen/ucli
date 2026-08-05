import test from 'node:test'
import assert from 'node:assert/strict'

import {
  sessionBindingAlertType,
  sessionBindingStateLabel
} from '../src/sessionDiagnosticsPresentation.js'

test('session binding states have stable localized explanations', () => {
  const cases = [
    ['current', '绑定正常'],
    ['stale', '发现更新的续接会话，可以修复'],
    ['unbound', '尚未绑定 Codex 会话'],
    ['missing', '本机找不到已绑定的 Codex 会话'],
    ['cwd_mismatch', '绑定会话与当前项目目录不一致'],
    ['unsupported', '当前 CLI 暂不支持会话绑定诊断'],
    ['unknown', '未知']
  ]

  for (const [state, expected] of cases) {
    assert.equal(sessionBindingStateLabel(state), expected)
  }
})

test('session binding alerts distinguish safe, repairable, and invalid states', () => {
  assert.equal(sessionBindingAlertType('current'), 'success')
  assert.equal(sessionBindingAlertType('stale'), 'warning')
  assert.equal(sessionBindingAlertType('missing'), 'error')
  assert.equal(sessionBindingAlertType('cwd_mismatch'), 'error')
  assert.equal(sessionBindingAlertType('unbound'), 'info')
  assert.equal(sessionBindingAlertType('unsupported'), 'info')
  assert.equal(sessionBindingAlertType('unknown'), 'info')
})
