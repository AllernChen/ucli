import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceSessionNotification,
  advanceTaskCompletion,
  describeApprovalNotification,
  describeSessionAttentionNotification,
  describeTaskCompletionNotification,
  operationTypeForTool,
  shouldShowApprovalNotification
} from '../electron/approvalNotification.js'

function windowState({ visible = true, minimized = false, focused = true, destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused
  }
}

test('approval notification is shown only while UCLI is not foreground-visible', () => {
  assert.equal(shouldShowApprovalNotification(windowState()), false)
  assert.equal(shouldShowApprovalNotification(windowState({ focused: false })), true)
  assert.equal(shouldShowApprovalNotification(windowState({ minimized: true })), true)
  assert.equal(shouldShowApprovalNotification(windowState({ visible: false })), true)
  assert.equal(shouldShowApprovalNotification(windowState({ destroyed: true })), false)
  assert.equal(shouldShowApprovalNotification(null), false)
})

test('approval notification identifies the session without exposing raw command details', () => {
  const result = describeApprovalNotification({
    tool: 'Bash',
    command: 'secret-command --token abc'
  }, {
    name: '发布会话',
    adapterId: 'claude'
  })

  assert.equal(result.title, 'UCLI 等待确认')
  assert.match(result.body, /发布会话/)
  assert.match(result.body, /执行命令/)
  assert.doesNotMatch(result.body, /secret-command|token/)
})

test('approval notification maps tool names to readable operation types', () => {
  assert.equal(operationTypeForTool('Bash'), '执行命令')
  assert.equal(operationTypeForTool('Edit'), '修改文件')
  assert.equal(operationTypeForTool('WebSearch'), '访问网络')
  assert.equal(operationTypeForTool('AskUserQuestion'), '回答问题')
  assert.equal(operationTypeForTool('ExitPlanMode'), '确认执行方案')
})

test('terminal attention notification includes operation type and session', () => {
  const result = describeSessionAttentionNotification({
    kind: 'approval',
    operation: '执行命令'
  }, {
    name: 'Codex 发布任务',
    adapterId: 'codex'
  })
  assert.equal(result.title, 'UCLI 等待确认')
  assert.match(result.body, /会话：Codex 发布任务/)
  assert.match(result.body, /操作：执行命令/)
})

test('DeepSeek Harness semantic attention uses the shared notification contract', () => {
  const result = describeSessionAttentionNotification({
    kind: 'approval',
    operation: 'DSH tool execution'
  }, {
    name: 'DSH release task',
    adapterId: 'deepseek-harness'
  })
  assert.match(result.body, /DSH release task/)
  assert.match(result.body, /DSH tool execution/)
})

test('task completion observes a restored-session baseline before notifying', () => {
  assert.deepEqual(advanceTaskCompletion(null, 0), { turns: null, completed: false })
  assert.deepEqual(advanceTaskCompletion(null, 7), { turns: 7, completed: false })
  assert.deepEqual(advanceTaskCompletion(7, 8), { turns: 8, completed: true })
  assert.deepEqual(advanceTaskCompletion(8, 8), { turns: 8, completed: false })
})

test('a new session notifies when its first turn completes', () => {
  assert.deepEqual(advanceTaskCompletion(0, 1), { turns: 1, completed: true })
})

test('task completion notification identifies the completed session', () => {
  const result = describeTaskCompletionNotification({
    name: '重构任务',
    adapterId: 'codex'
  })
  assert.equal(result.title, 'UCLI 任务已完成')
  assert.match(result.body, /重构任务/)
  assert.match(result.body, /操作：任务完成/)
})

test('duplicate session notifications from terminal and transcript are coalesced', () => {
  const first = advanceSessionNotification(null, 'complete:任务完成', 1000)
  assert.equal(first.deliver, true)
  const duplicate = advanceSessionNotification(first.state, 'complete:任务完成', 4000)
  assert.equal(duplicate.deliver, false)
  const approval = advanceSessionNotification(duplicate.state, 'approval:执行命令', 4500)
  assert.equal(approval.deliver, true)
})
