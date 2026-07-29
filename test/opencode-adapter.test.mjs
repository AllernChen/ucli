import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpenCodeArgs,
  buildOpenCodeConfigContent,
  buildOpenCodePermission,
  classifyOpenCodeNotification,
  OpenCodeAdapter,
  resolveOpenCodeCmdShim,
  resolveOpenCodeLaunch
} from '../electron/adapters/openCodeAdapter.js'

test('OpenCode resume targets the source session without overriding its historical model', () => {
  assert.deepEqual(buildOpenCodeArgs({
    model: 'anthropic/claude-sonnet-4-5',
    cliSessionId: 'ses_123'
  }), [
    '--session',
    'ses_123'
  ])
})

test('OpenCode new sessions can still start with the selected model', () => {
  assert.deepEqual(buildOpenCodeArgs({
    model: 'anthropic/claude-sonnet-4-5',
    cliSessionId: null
  }), [
    '--model',
    'anthropic/claude-sonnet-4-5'
  ])
})

test('OpenCode rejects unsafe model identifiers before building process arguments', () => {
  assert.throws(() => buildOpenCodeArgs({
    model: 'provider/model & calc.exe',
    cliSessionId: null
  }), /invalid OpenCode model/)
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
  assert.deepEqual(permission.external_directory, { '*': 'allow' })
})

test('OpenCode network permissions use action values instead of pattern objects', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    allow: ['WebFetch(*)', 'WebSearch(*)']
  })

  assert.equal(permission.webfetch, 'allow')
  assert.equal(permission.websearch, 'allow')
})

test('OpenCode network permission fallback applies to the whole unsupported pattern tool', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    allow: ['WebFetch(github.com)'],
    highRisk: ['WebFetch(untrusted.example)', 'WebSearch(*)']
  })

  assert.equal(permission.webfetch, 'ask')
  assert.equal(permission.websearch, 'ask')
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

test('OpenCode safely resolves direct executable and Node cmd shims without invoking cmd.exe', () => {
  const directShim = [
    '@ECHO off',
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*'
  ].join('\r\n')
  const nodeShim = [
    '@ECHO off',
    '"%~dp0\\node.exe" "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*'
  ].join('\r\n')
  const existing = new Set([
    'F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.exe',
    'F:\\tools\\node.exe',
    'F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js'
  ])

  assert.deepEqual(resolveOpenCodeCmdShim(
    'F:\\tools\\opencode.cmd',
    directShim,
    (path) => existing.has(path)
  ), {
    file: 'F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.exe',
    prefixArgs: []
  })
  assert.deepEqual(resolveOpenCodeCmdShim(
    'F:\\tools\\opencode.cmd',
    nodeShim,
    (path) => existing.has(path)
  ), {
    file: 'F:\\tools\\node.exe',
    prefixArgs: ['F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js']
  })
})

test('OpenCode cmd shim expansion preserves the trailing separator semantics of %~dp0', () => {
  const shim = '"%~dp0node.exe" "%~dp0node_modules\\opencode-ai\\bin\\opencode.js" %*'
  const existing = new Set([
    'F:\\tools\\node.exe',
    'F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js'
  ])

  assert.deepEqual(resolveOpenCodeCmdShim(
    'F:\\tools\\opencode.cmd',
    shim,
    (path) => existing.has(path)
  ), {
    file: 'F:\\tools\\node.exe',
    prefixArgs: ['F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js']
  })
})

test('OpenCode safely extracts the fixed entrypoint from a standard npm cmd shim', () => {
  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'IF EXIST "%~dp0node.exe" (',
    '  SET "_prog=%~dp0node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || "%_prog%" "%~dp0node_modules\\opencode-ai\\bin\\opencode.js" %*'
  ].join('\r\n')
  const existing = new Set([
    'F:\\tools\\node.exe',
    'F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js'
  ])

  assert.deepEqual(resolveOpenCodeCmdShim(
    'F:\\tools\\opencode.cmd',
    shim,
    (path) => existing.has(path)
  ), {
    file: 'F:\\tools\\node.exe',
    prefixArgs: ['F:\\tools\\node_modules\\opencode-ai\\bin\\opencode.js']
  })
})

test('OpenCode rejects cmd shims containing shell operators', () => {
  const maliciousShim = '"%~dp0\\node.exe" "%~dp0\\opencode.js" & calc.exe %*'

  assert.equal(resolveOpenCodeCmdShim(
    'F:\\tools\\opencode.cmd',
    maliciousShim,
    () => true
  ), null)
})

test('OpenCode launch uses a safely parsed cmd shim when the fixed npm path is absent', () => {
  const shim = 'F:\\custom\\opencode.cmd'
  const executable = 'F:\\custom\\runtime\\opencode.exe'
  const launch = resolveOpenCodeLaunch(
    [shim],
    (path) => path === executable,
    'win32',
    () => `"${executable}" %*`
  )

  assert.deepEqual(launch, { file: executable, prefixArgs: [] })
})

test('OpenCode Windows launch never falls back to a command interpreter', () => {
  assert.throws(
    () => resolveOpenCodeLaunch(
      ['F:\\custom\\opencode.cmd'],
      () => false,
      'win32',
      () => '@ECHO off\r\nopencode %*'
    ),
    /safe OpenCode executable not found/
  )
})

test('OpenCode asks for non-blacklisted tools in ask-everything mode', () => {
  const permission = buildOpenCodePermission('ask-everything')
  assert.equal(permission['*'], 'ask')
  assert.equal(permission.bash['rm -rf /*'], 'deny')
})

test('OpenCode safely falls back to ask for an untranslatable risky regex', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    highRisk: ['Bash(re:powershell\\s+.*iex)']
  })
  assert.equal(permission.bash['*'], 'ask')
})

test('OpenCode translates trusted network-pipe risk rules without asking for every Bash command', () => {
  const permission = buildOpenCodePermission('safety-rules', {
    highRisk: [
      'Bash(re:curl\\s.*\\|\\s*(sh|bash))',
      'Bash(re:wget\\s.*\\|\\s*(sh|bash))'
    ]
  })

  assert.equal(permission.bash['*'], 'allow')
  assert.equal(permission.bash['curl *|*sh*'], 'ask')
  assert.equal(permission.bash['curl *|*bash*'], 'ask')
  assert.equal(permission.bash['wget *|*sh*'], 'ask')
  assert.equal(permission.bash['wget *|*bash*'], 'ask')
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
