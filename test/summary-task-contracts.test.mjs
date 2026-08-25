import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSummaryTaskTitle,
  normalizeSummaryTaskMetadata,
  summaryTaskErrorMeta,
  summaryTaskStatusMeta
} from '../shared/summaryTaskContracts.js'

test('default summary task title follows the historical naming rule', () => {
  assert.equal(buildSummaryTaskTitle({
    periodType: 'week',
    createdAt: Date.UTC(2026, 7, 25, 1, 50),
    timezone: 'Asia/Shanghai'
  }), '工作总结（每周）2026-08-25 09:50')
})

test('summary task metadata validates title and note boundaries', () => {
  assert.deepEqual(normalizeSummaryTaskMetadata({
    title: '  周报复盘  ', taskNote: '第一行\r\n第二行'
  }), { title: '周报复盘', taskNote: '第一行\n第二行' })
  assert.throws(
    () => normalizeSummaryTaskMetadata({ title: 'bad\nname', taskNote: '' }),
    { code: 'INVALID_SUMMARY_TASK_METADATA' }
  )
  for (const title of ['\n周报', '周报\n', '\r周报', '周报\r', '\t周报', '周报\t']) {
    assert.throws(
      () => normalizeSummaryTaskMetadata({ title, taskNote: '' }),
      { code: 'INVALID_SUMMARY_TASK_METADATA' }
    )
  }
  assert.throws(
    () => normalizeSummaryTaskMetadata({ title: 'x', taskNote: 'a'.repeat(1001) }),
    { code: 'INVALID_SUMMARY_TASK_METADATA' }
  )
})

test('completed database status wins when runPhase is absent', () => {
  assert.deepEqual(
    summaryTaskStatusMeta({ status: 'completed', runPhase: null }),
    { label: '已完成', color: 'green', detail: '总结已生成' }
  )
})

test('summary task error metadata exposes only actionable allowlisted failures', () => {
  const cases = [
    ['SUMMARY_ARTIFACT_INVALID', {
      code: 'SUMMARY_ARTIFACT_INVALID',
      message: '报告已生成，但内容结构或安全校验未通过。',
      action: '请检查生成内容后重试。'
    }],
    ['SUMMARY_ARTIFACT_MISSING', {
      code: 'SUMMARY_ARTIFACT_MISSING',
      message: 'AI CLI 未写出报告文件。',
      action: '请确认 AI CLI 已完成后重试。'
    }],
    ['SUMMARY_TURN_NOT_CONFIRMED', {
      code: 'SUMMARY_TURN_NOT_CONFIRMED',
      message: '生成指令未确认送达 AI CLI。',
      action: '请重新生成总结。'
    }],
    ['SUMMARY_RUN_TIMEOUT', {
      code: 'SUMMARY_RUN_TIMEOUT',
      message: '生成超过允许时间。',
      action: '请重试生成总结。'
    }]
  ]
  for (const [errorText, expected] of cases) {
    assert.deepEqual(summaryTaskErrorMeta(errorText), expected)
  }
  assert.deepEqual(summaryTaskErrorMeta('C:\\private\\secret provider output'), {
    code: 'SUMMARY_RUN_FAILED',
    message: '工作总结生成失败。',
    action: '请重试生成总结。'
  })
})
