import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SUMMARY_EXECUTION_MODE,
  INTERACTIVE_SUMMARY_PHASE,
  INTERACTIVE_SUMMARY_TERMINAL_PHASES,
  assertInteractiveSummaryPhase,
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

  assert.deepEqual(
    safeInteractiveSummaryError(
      Object.assign(new Error('C:\\secret\\prompt.txt'), { code: 'SUMMARY_READY_TIMEOUT' }),
      'SUMMARY_RUN_FAILED'
    ),
    { code: 'SUMMARY_READY_TIMEOUT', message: 'AI CLI 启动超时' }
  )
  assert.deepEqual(
    safeInteractiveSummaryError(new Error('C:\\secret\\prompt.txt'), 'SUMMARY_RUN_FAILED'),
    { code: 'SUMMARY_RUN_FAILED', message: '工作总结生成失败' }
  )
})
