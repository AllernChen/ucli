import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSummaryTaskTitle,
  normalizeSummaryTaskMetadata,
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
