import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prepareDecisionSummary,
  redactDisplayText
} from '../electron/gateway/redaction.js'

test('display redaction removes headers, credentials, URL queries, and environment secrets', () => {
  const source = [
    'Authorization: Bearer auth-value',
    'password=hunter2 secret: abc token="xyz" api_key=key-value',
    'https://example.com/run?token=url-token&safe=yes&password=url-password',
    'API_KEY=env-key NORMAL=value'
  ].join('\n')
  const result = redactDisplayText(source)

  assert.equal(result.desktopOnly, false)
  assert.equal(result.text.includes('auth-value'), false)
  assert.equal(result.text.includes('hunter2'), false)
  assert.equal(result.text.includes('url-token'), false)
  assert.equal(result.text.includes('env-key'), false)
  assert.equal(result.text.includes('safe=yes'), true)
  assert.equal(result.redacted, true)
})

test('decision summaries truncate by Unicode code point and offer full detail', () => {
  const result = prepareDecisionSummary('😀'.repeat(1001))
  assert.equal(Array.from(result.summary.replace(/…$/, '')).length, 1000)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.actions, [{ id: 'view_full', label: '查看完整内容' }])
})

test('binary, NUL, and non-string content stays on the desktop', () => {
  for (const value of ['hello\0secret', Buffer.from([0, 1, 2])]) {
    const result = redactDisplayText(value)
    assert.equal(result.desktopOnly, true)
    assert.equal(result.text, '内容无法安全展示，请在 UCLI 中查看')
  }
})
