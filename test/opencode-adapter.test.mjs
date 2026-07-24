import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpenCodeArgs,
  buildOpenCodePermission,
  classifyOpenCodeNotification,
  resolveOpenCodeLaunch
} from '../electron/adapters/openCodeAdapter.js'

test('OpenCode args preserve native TUI and resume the selected source session', () => {
  assert.deepEqual(buildOpenCodeArgs({
    model: 'anthropic/claude-sonnet-4-5',
    cliSessionId: 'ses_123'
  }), [
    '--model',
    'anthropic/claude-sonnet-4-5',
    '--session',
    'ses_123'
  ])
})

test('OpenCode safety rules allow trusted commands and ask for risky commands', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    allow: ['Bash(git status:*)'],
    highRisk: ['Bash(git push:*)'],
    deny: ['Write(~/.ssh/**)']
  })
  assert.equal(permission.bash['*'], 'allow')
  assert.equal(permission.bash['git status*'], 'allow')
  assert.equal(permission.bash['git push*'], 'ask')
  assert.equal(permission.edit['~/.ssh/**'], 'deny')
  assert.equal(permission.bash['rm -rf /*'], 'deny')
  assert.equal(permission.external_directory, 'ask')
})

test('OpenCode always-agree still enforces the hard blacklist', () => {
  const permission = buildOpenCodePermission('always-agree')
  assert.equal(permission['*'], 'allow')
  assert.equal(permission.bash['rm --no-preserve-root*'], 'deny')
  assert.equal(permission.edit['C:\\Windows*'], 'deny')
})

test('OpenCode attention messages distinguish approval from completion', () => {
  assert.deepEqual(classifyOpenCodeNotification('Permission requested for bash'), {
    kind: 'approval',
    operation: '确认 OpenCode 操作'
  })
  assert.deepEqual(classifyOpenCodeNotification('Session complete'), {
    kind: 'complete',
    operation: '任务完成'
  })
})

test('OpenCode Windows launch bypasses the npm cmd shim for ConPTY', () => {
  const launch = resolveOpenCodeLaunch([
    'F:\\soft\\nvm\\nodejs\\opencode',
    'F:\\soft\\nvm\\nodejs\\opencode.cmd'
  ], () => true, 'win32')
  assert.deepEqual(launch, {
    file: 'F:\\soft\\nvm\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe',
    prefixArgs: []
  })
})
