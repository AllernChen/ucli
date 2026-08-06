import test from 'node:test'
import assert from 'node:assert/strict'

import * as diagnosticsPresentation from '../src/sessionDiagnosticsPresentation.js'

const {
  sessionBindingAlertType,
  sessionBindingStateLabel
} = diagnosticsPresentation

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

test('copied session diagnostics expose only the support allowlist', () => {
  const text = diagnosticsPresentation.formatSessionDiagnosticsForClipboard({
    schemaVersion: 1,
    sessionId: 'ucli-session',
    adapterId: 'codex',
    cwd: 'C:\\Users\\private\\secret-project',
    status: 'offline',
    storedNativeSessionId: 'codex-original',
    resolvedNativeSessionId: 'codex-current',
    bindingState: 'stale',
    repairAvailable: true,
    lineage: [{
      sessionId: 'codex-current',
      forkedFromId: 'codex-original',
      startedAt: 1767225600000,
      updatedAt: 1767312000000,
      transcriptPath: 'C:\\Users\\private\\transcript.jsonl'
    }],
    prompt: 'private prompt',
    messageBody: 'private message'
  })

  assert.deepEqual(JSON.parse(text), {
    schemaVersion: 1,
    sessionId: 'ucli-session',
    adapterId: 'codex',
    status: 'offline',
    bindingState: 'stale',
    storedNativeSessionId: 'codex-original',
    resolvedNativeSessionId: 'codex-current',
    repairAvailable: true,
    lineage: [{
      sessionId: 'codex-current',
      forkedFromId: 'codex-original',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }]
  })
  assert.doesNotMatch(text, /secret-project|transcript\.jsonl|private prompt|private message/)
})
