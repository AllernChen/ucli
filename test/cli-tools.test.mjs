import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as cliTools from '../electron/cliTools.js'

const { inspectCliTool, listCliToolDefinitions, runCliToolAction } = cliTools
const npmPrefix = process.platform === 'win32' ? 'F:\\npm' : '/opt/npm'
const npmBin = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin')

test('CLI catalog exposes only fixed install and upgrade commands', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map((tool) => tool.id), ['claude', 'codex', 'opencode', 'ucode', 'deepseek-harness'])
  assert.equal(tools[0].installCommand, 'npm install -g @anthropic-ai/claude-code')
  assert.equal(tools[1].installCommand, 'npm install -g @openai/codex')
  assert.equal(tools[2].installCommand, 'npm install -g opencode-ai')
  assert.equal(tools[2].upgradeCommand, 'npm install -g opencode-ai')
  assert.equal(tools[3].installCommand, 'npm install -g @allenchen77/ucode-cli')
  assert.equal(tools[3].upgradeCommand, 'npm install -g @allenchen77/ucode-cli')
  assert.equal(tools[4].executable, 'dsh')
  assert.equal(tools[4].installCommand, 'npm install -g @deepseek-ai/dsh@0.1.0-rc.6')
  assert.equal(tools[4].upgradeCommand, 'npm install -g @deepseek-ai/dsh@0.1.0-rc.6')
})

test('CLI catalog keeps installation separate from safe summary execution', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map(tool => ({
    id: tool.id,
    safeForSummary: tool.safeForSummary,
    summaryExecutorAvailable: tool.summaryExecutorAvailable,
    summaryExecutorUnavailableReason: tool.summaryExecutorUnavailableReason
  })), [
    { id: 'claude', safeForSummary: true, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'summary-authentication-unverified' },
    { id: 'codex', safeForSummary: false, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'no-guaranteed-no-tools-mode' },
    { id: 'opencode', safeForSummary: true, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'summary-authentication-unverified' },
    { id: 'ucode', safeForSummary: false, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'no-guaranteed-no-tools-mode' },
    { id: 'deepseek-harness', safeForSummary: false, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'unsupported-executor' }
  ])
})

test('DeepSeek Harness inventory exposes compatibility without resolved runtime paths', async () => {
  const status = await inspectCliTool('deepseek-harness', undefined, {
    dshRuntimeInspector: async () => ({
      installed: true,
      compatible: true,
      version: '0.1.0-rc.6',
      reason: '',
      launch: { file: 'C:\\sensitive\\absolute\\dsh', prefixArgs: [] }
    })
  })
  assert.equal(status.installed, true)
  assert.equal(status.compatible, true)
  assert.equal(status.version, '0.1.0-rc.6')
  assert.equal(status.path, '')
  assert.equal(JSON.stringify(status).includes('sensitive'), false)
})

test('DeepSeek Harness install action returns no raw process output or resolved home', async () => {
  const result = await runCliToolAction(
    'deepseek-harness',
    'install',
    async () => ({
      code: 1,
      stdout: 'C:\\Users\\private\\.dsh',
      stderr: 'registry-token=must-not-leak'
    }),
    {
      dshRuntimeInspector: async () => ({
        installed: false,
        compatible: false,
        version: '',
        reason: 'not-installed',
        launch: null
      })
    }
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 1)
  assert.equal('stdout' in result, false)
  assert.equal('stderr' in result, false)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(result).includes('.dsh'), false)
})

function installedRunner(version = '1.0.0') {
  return async (command) => {
    if (command === 'npm prefix -g') return { code: 0, stdout: `${npmPrefix}\n`, stderr: '' }
    if (command.startsWith('where ') || command.startsWith('command -v ')) {
      return { code: 0, stdout: `${npmBin}${path.sep}tool\n`, stderr: '' }
    }
    return { code: 0, stdout: `${version}\n`, stderr: '' }
  }
}

test('OpenCode inventory requires an allowlisted credential or validated auth bridge', {
  skip: process.platform === 'win32' && 'POSIX disk-auth semantics are covered on Linux'
}, async () => {
  const dataHome = mkdtempSync(path.join(tmpdir(), 'ucli-cli-auth-inventory-'))
  const env = { PATH: process.env.PATH, XDG_DATA_HOME: dataHome }
  try {
    const unavailable = await inspectCliTool('opencode', installedRunner('1.18.14'), { env, platform: 'linux' })
    assert.equal(unavailable.installed, true)
    assert.equal(unavailable.safeForSummary, true)
    assert.equal(unavailable.summaryExecutorAvailable, false)
    assert.equal(unavailable.summaryExecutorUnavailableReason, 'summary-authentication-unavailable')

    mkdirSync(path.join(dataHome, 'opencode'))
    writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      '{"openai":{"type":"api","key":"inventory-test-secret"}}',
      { mode: 0o600 }
    )
    const bridged = await inspectCliTool('opencode', installedRunner('1.18.14'), { env, platform: 'linux' })
    assert.equal(bridged.summaryExecutorAvailable, true)
    assert.equal(bridged.summaryExecutorUnavailableReason, '')
    assert.equal(JSON.stringify(bridged).includes('inventory-test-secret'), false)
  } finally {
    rmSync(dataHome, { recursive: true, force: true })
  }
})

test('OpenCode inventory rejects linked auth but accepts explicit allowlisted provider env', async (t) => {
  const dataHome = mkdtempSync(path.join(tmpdir(), 'ucli-cli-linked-auth-'))
  const authDirectory = path.join(dataHome, 'opencode')
  mkdirSync(authDirectory)
  const target = path.join(dataHome, 'real-auth.json')
  writeFileSync(target, '{"openai":{"type":"api"}}', { mode: 0o600 })
  try {
    try {
      symlinkSync(target, path.join(authDirectory, 'auth.json'), 'file')
      const linked = await inspectCliTool('opencode', installedRunner(), {
        env: { PATH: process.env.PATH, XDG_DATA_HOME: dataHome },
        platform: 'linux'
      })
      assert.equal(linked.summaryExecutorAvailable, false)
      assert.equal(linked.summaryExecutorUnavailableReason, 'unsafe-auth-file')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
      t.diagnostic('symlink creation is unavailable on this host')
    }
    const explicit = await inspectCliTool('opencode', installedRunner(), {
      env: {
        PATH: process.env.PATH,
        XDG_DATA_HOME: dataHome,
        OPENAI_API_KEY: 'allowlisted-test-value',
        AWS_SECRET_ACCESS_KEY: 'must-not-count'
      },
      platform: 'linux'
    })
    assert.equal(explicit.summaryExecutorAvailable, true)
    assert.equal(explicit.summaryExecutorUnavailableReason, '')
  } finally {
    rmSync(dataHome, { recursive: true, force: true })
  }
})

test('Claude inventory does not assume system login crosses the isolated home boundary', {
  skip: process.platform === 'win32' && 'POSIX disk-auth semantics are covered on Linux'
}, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ucli-claude-cli-auth-'))
  try {
    const noCredential = await inspectCliTool('claude', installedRunner('2.0.0'), {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      homeDirectory: home,
      platform: 'linux'
    })
    assert.equal(noCredential.summaryExecutorAvailable, false)
    assert.equal(noCredential.summaryExecutorUnavailableReason, 'requires-allowlisted-env-or-managed-profile')

    mkdirSync(path.join(home, '.claude'))
    writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      '{"x":1}',
      { mode: 0o600 }
    )
    const invalidShape = await inspectCliTool('claude', installedRunner('2.0.0'), {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      homeDirectory: home,
      platform: 'linux'
    })
    assert.equal(invalidShape.summaryExecutorAvailable, false)
    writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"inventory-secret"}}',
      { mode: 0o600 }
    )
    const bridged = await inspectCliTool('claude', installedRunner('2.0.0'), {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      homeDirectory: home,
      platform: 'linux'
    })
    assert.equal(bridged.summaryExecutorAvailable, true)
    assert.equal(bridged.summaryAuthenticationSource, 'auth-file')
    assert.equal(JSON.stringify(bridged).includes('inventory-secret'), false)

    const explicit = await inspectCliTool('claude', installedRunner('2.0.0'), {
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'allowlisted-test-value' },
      homeDirectory: home
    })
    assert.equal(explicit.summaryExecutorAvailable, true)
    assert.equal(explicit.summaryExecutorUnavailableReason, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Claude macOS inventory probes Keychain login with an isolated no-model auth status command', async () => {
  const calls = []
  const runner = async (command, _timeout, env) => {
    calls.push({ command, env })
    if (command.includes('auth status')) {
      return { code: 0, stdout: '{"loggedIn":true,"authMethod":"oauth"}', stderr: '' }
    }
    if (command.startsWith('where ') || command.startsWith('command -v ')) {
      return { code: 0, stdout: '/usr/local/bin/claude\n', stderr: '' }
    }
    return { code: 0, stdout: '2.0.0\n', stderr: '' }
  }
  const status = await inspectCliTool('claude', runner, {
    platform: 'darwin',
    env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: 'https://attacker.invalid' }
  })
  assert.equal(status.summaryExecutorAvailable, true)
  assert.equal(status.summaryAuthenticationSource, 'keychain')
  const probe = calls.find(call => call.command === 'claude auth status --json')
  assert.ok(probe)
  assert.ok(probe.env.HOME)
  assert.notEqual(probe.env.HOME, process.env.HOME)
  assert.equal(probe.env.ANTHROPIC_BASE_URL, undefined)
})

test('Windows inventory never advertises disk credentials as safe summary authentication', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ucli-windows-inventory-auth-'))
  const dataHome = path.join(root, 'data')
  mkdirSync(path.join(root, '.claude'))
  mkdirSync(path.join(dataHome, 'opencode'), { recursive: true })
  writeFileSync(
    path.join(root, '.claude', '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"must-not-bridge"}}'
  )
  writeFileSync(
    path.join(dataHome, 'opencode', 'auth.json'),
    '{"openai":{"type":"api","key":"must-not-bridge"}}'
  )
  try {
    const claude = await inspectCliTool('claude', installedRunner(), {
      platform: 'win32',
      homeDirectory: root,
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root }
    })
    const opencode = await inspectCliTool('opencode', installedRunner(), {
      platform: 'win32',
      homeDirectory: root,
      env: { PATH: process.env.PATH, XDG_DATA_HOME: dataHome }
    })
    for (const status of [claude, opencode]) {
      assert.equal(status.summaryExecutorAvailable, false)
      assert.equal(status.summaryExecutorUnavailableReason, 'windows-disk-auth-bridge-unavailable')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode upgrade runs the npm global installer', async () => {
  const originalPath = process.env.PATH
  try {
    const calls = []
    const runner = async (command) => {
      calls.push(command)
      if (command === 'npm prefix -g') {
        return { code: 0, stdout: `${npmPrefix}\n`, stderr: '' }
      }
      return command.includes('--version')
        ? { code: 0, stdout: '1.18.14\n', stderr: '' }
        : { code: 0, stdout: 'F:\\npm\\opencode.cmd\n', stderr: '' }
    }

    const result = await runCliToolAction('opencode', 'upgrade', runner)

    assert.equal(calls[0], 'npm install -g opencode-ai')
    assert.equal(result.command, 'npm install -g opencode-ai')
    assert.equal(result.ok, true)
  } finally {
    process.env.PATH = originalPath
  }
})

test('CLI inspection parses path and version', async () => {
  const calls = []
  const runner = async (command) => {
    calls.push(command)
    if (command.startsWith('where ') || command.startsWith('command -v ')) {
      return { code: 0, stdout: 'F:\\bin\\claude.cmd\r\n', stderr: '' }
    }
    return { code: 0, stdout: '2.0.0\r\n', stderr: '' }
  }
  const status = await inspectCliTool('claude', runner)
  assert.equal(status.installed, true)
  assert.equal(status.path, 'F:\\bin\\claude.cmd')
  assert.equal(status.version, '2.0.0')
  assert.equal(calls.length, 2)
})

test('CLI action rejects unknown tools and operations before spawning', async () => {
  await assert.rejects(() => runCliToolAction('shell', 'install'), /unknown CLI tool/)
  await assert.rejects(() => runCliToolAction('claude', 'run-anything'), /unsupported CLI action/)
})

test('U-Code install refreshes npm global bin without preferring the legacy release directory', async () => {
  const originalPath = process.env.PATH
  process.env.PATH = 'F:\\existing-bin'
  try {
    const calls = []
    const runner = async (command) => {
      calls.push(command)
      if (command === 'npm prefix -g') {
        return { code: 0, stdout: `${npmPrefix}\n`, stderr: '' }
      }
      return command.includes('--version')
        ? { code: 0, stdout: '0.2.1\n', stderr: '' }
        : { code: 0, stdout: 'F:\\npm\\ucode.cmd\n', stderr: '' }
    }

    const result = await runCliToolAction('ucode', 'install', runner)

    assert.equal(calls[0], 'npm install -g @allenchen77/ucode-cli')
    assert.equal(result.command, 'npm install -g @allenchen77/ucode-cli')
    assert.equal(process.env.PATH.split(path.delimiter)[0], npmBin)
    assert.equal(process.env.PATH.toLowerCase().includes('.ucode'), false)
  } finally {
    process.env.PATH = originalPath
  }
})

test('U-Code inspection refreshes npm global bin before resolving path and version', async () => {
  const originalPath = process.env.PATH
  process.env.PATH = 'F:\\existing-bin'
  try {
    const runner = async (command) => {
      if (command === 'npm prefix -g') {
        return { code: 0, stdout: `${npmPrefix}\n`, stderr: '' }
      }
      assert.equal(process.env.PATH.split(path.delimiter)[0], npmBin)
      return command.includes('--version')
        ? { code: 0, stdout: '0.2.1\n', stderr: '' }
        : { code: 0, stdout: 'F:\\npm\\ucode.cmd\n', stderr: '' }
    }

    const status = await inspectCliTool('ucode', runner)
    assert.equal(status.installed, true)
    assert.equal(status.version, '0.2.1')
    assert.equal(process.env.PATH.split(path.delimiter)[0], npmBin)
  } finally {
    process.env.PATH = originalPath
  }
})
