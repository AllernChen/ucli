import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpenCodeArgs,
  buildOpenCodeConfigContent,
  buildOpenCodePermission,
  classifyOpenCodeNotification,
  OpenCodeAdapter,
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

test('OpenCode asks for non-blacklisted tools in ask-everything mode', () => {
  const permission = buildOpenCodePermission('ask-everything')
  assert.equal(permission['*'], 'ask')
  assert.equal(permission.bash['rm -rf /*'], 'deny')
})

test('OpenCode safely falls back to ask for an untranslatable risky regex', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    highRisk: ['Bash(re:curl\\s.*\\|\\s*(sh|bash))']
  })
  assert.equal(permission.bash['*'], 'ask')
})

test('OpenCode uses inline config content so permissions override project config', () => {
  const config = JSON.parse(buildOpenCodeConfigContent('safety-rules', {
    allow: ['Bash(git status:*)'],
    highRisk: ['Bash(git push:*)']
  }))

  assert.deepEqual(config.permission.bash, {
    '*': 'allow',
    'git status*': 'allow',
    'git push*': 'ask',
    'rm -rf /': 'deny',
    'rm -rf /*': 'deny',
    'rm -rf ~*': 'deny',
    'rm -rf $HOME*': 'deny',
    'rm --no-preserve-root*': 'deny',
    'mkfs*': 'deny',
    'format *': 'deny',
    'diskpart*clean*': 'deny',
    'dd *of=/dev/*': 'deny',
    'chmod -R 777 /*': 'deny',
    'del /s*C:\\Windows*': 'deny',
    'del /s*C:\\Users*': 'deny',
    'rmdir /s*C:\\Windows*': 'deny',
    'rmdir /s*C:\\Program Files*': 'deny'
  })
})

test('OpenCode adapter emits cumulative exported session statistics', async () => {
  const adapter = new OpenCodeAdapter({
    session: { id: 'ucli_opencode', cwd: 'F:\\projects\\sample', cliSessionId: 'ses_fixture', model: 'default' },
    engine: {},
    settings: {
      ruleset: {},
      statsReader: async () => ({
        inputTokens: 4512,
        outputTokens: 54,
        cachedInputTokens: 22272,
        reasoningOutputTokens: 19,
        turnsCount: 2,
        completedTurnsCount: 2,
        costUsd: 0,
        costAvailable: true,
        lastModel: 'glm/glm-5.2',
        modelBreakdown: [{ model: 'glm/glm-5.2', inputTokens: 4512, outputTokens: 54, costUsd: 0, costAvailable: true }]
      })
    }
  })
  const events = []
  adapter.on('event', (event) => events.push(event))

  await adapter._extractStats()

  assert.deepEqual(events.map(({ ts, sessionId, ...event }) => event), [{
    type: 'stats_update',
    usage: { inputTokens: 4512, outputTokens: 54, cachedInputTokens: 22272, reasoningOutputTokens: 19 },
    costUsd: 0,
    costAvailable: true,
    turns: 2,
    completedTurns: 2,
    model: 'glm/glm-5.2',
    modelBreakdown: [{ model: 'glm/glm-5.2', inputTokens: 4512, outputTokens: 54, costUsd: 0, costAvailable: true }]
  }])
})
