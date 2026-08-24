import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SUMMARY_EXECUTION_MODE,
  INTERACTIVE_SUMMARY_PHASE,
  INTERACTIVE_SUMMARY_TERMINAL_PHASES,
  assertInteractiveSummaryPhase,
  isPersistedSummaryErrorText,
  safeInteractiveSummaryError
} from '../electron/summaries/interactiveSummaryContracts.js'

test('interactive summary contracts are closed and safe for consumers', () => {
  assert.deepEqual(Object.values(SUMMARY_EXECUTION_MODE), [
    'isolated-runner',
    'interactive-cli',
    'legacy-worklog-import'
  ])
  assert.deepEqual(Object.values(INTERACTIVE_SUMMARY_PHASE), [
    'preparing',
    'starting',
    'awaiting-delivery',
    'running',
    'validating',
    'completed',
    'failed',
    'interrupted',
    'cancelled'
  ])
  assert.deepEqual([...INTERACTIVE_SUMMARY_TERMINAL_PHASES], [
    'completed',
    'failed',
    'interrupted',
    'cancelled'
  ])

  for (const phase of Object.values(INTERACTIVE_SUMMARY_PHASE)) {
    assert.equal(assertInteractiveSummaryPhase(phase), phase)
  }
  assert.throws(
    () => assertInteractiveSummaryPhase('waiting-forever'),
    { code: 'SUMMARY_RUN_PHASE_INVALID' }
  )
})

test('persisted summary errors use one closed central allowlist', () => {
  for (const value of [
    null,
    'SUMMARY_GENERATION_FAILED',
    'SUMMARY_CANCELLED',
    'SUMMARY_READY_TIMEOUT',
    'SUMMARY_TURN_NOT_CONFIRMED',
    'SUMMARY_RUN_TIMEOUT',
    'SUMMARY_ARTIFACT_INVALID',
    'SUMMARY_RUN_FAILED',
    'SUMMARY_AUTOMATIC_DUPLICATE:safe-report_1.2-abc'
  ]) assert.equal(isPersistedSummaryErrorText(value), true)

  for (const value of [
    'SUMMARY_PROVIDER_FAILED',
    'ARBITRARY_UPPERCASE_CODE',
    `SUMMARY_RUN_FAILED:AKIA${'A'.repeat(16)}`,
    'SUMMARY_GENERATION_FAILED:leaked-suffix',
    'SUMMARY_AUTOMATIC_DUPLICATE:../../private'
  ]) assert.equal(isPersistedSummaryErrorText(value), false)
})

test('terminal summary phases are an immutable read-only collection', () => {
  const expected = ['completed', 'failed', 'interrupted', 'cancelled']

  assert.equal(INTERACTIVE_SUMMARY_TERMINAL_PHASES.size, expected.length)
  assert.equal(INTERACTIVE_SUMMARY_TERMINAL_PHASES.has('completed'), true)
  assert.equal(INTERACTIVE_SUMMARY_TERMINAL_PHASES.has('running'), false)
  assert.throws(() => INTERACTIVE_SUMMARY_TERMINAL_PHASES.add('running'), TypeError)
  assert.throws(() => INTERACTIVE_SUMMARY_TERMINAL_PHASES.delete('completed'), TypeError)
  assert.throws(() => INTERACTIVE_SUMMARY_TERMINAL_PHASES.clear(), TypeError)
  assert.deepEqual([...INTERACTIVE_SUMMARY_TERMINAL_PHASES], expected)
})

test('interactive summary errors expose only whitelisted codes and messages', () => {
  const safeErrors = [
    ['SUMMARY_READY_TIMEOUT', 'AI CLI 启动超时'],
    ['SUMMARY_TURN_NOT_CONFIRMED', '生成指令未确认送达'],
    ['SUMMARY_RUN_TIMEOUT', '工作总结生成超时'],
    ['SUMMARY_ARTIFACT_INVALID', '生成的 Markdown 报告无效'],
    ['SUMMARY_RUN_FAILED', '工作总结生成失败']
  ]

  for (const [code, message] of safeErrors) {
    const result = safeInteractiveSummaryError(
      Object.assign(new Error(`C:\\secret\\${code}.txt`), { code }),
      'SUMMARY_RUN_FAILED'
    )
    assert.deepEqual(result, { code, message })
    assert.doesNotMatch(JSON.stringify(result), /secret|\.txt/i)
  }

  const unknownErrorCode = safeInteractiveSummaryError(
    Object.assign(new Error('C:\\secret\\prompt.txt'), { code: 'SUMMARY_PRIVATE_FAILURE' }),
    'SUMMARY_RUN_FAILED'
  )
  const unknownFallbackCode = safeInteractiveSummaryError(
    new Error('C:\\secret\\transcript.txt'),
    'SUMMARY_PRIVATE_FALLBACK'
  )

  for (const result of [unknownErrorCode, unknownFallbackCode]) {
    assert.deepEqual(result, {
      code: 'SUMMARY_RUN_FAILED',
      message: '工作总结生成失败'
    })
    assert.doesNotMatch(JSON.stringify(result), /secret|prompt|transcript|\.txt/i)
  }
})
