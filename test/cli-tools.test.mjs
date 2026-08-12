import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import * as cliTools from '../electron/cliTools.js'

const { inspectCliTool, listCliToolDefinitions, runCliToolAction } = cliTools
const npmPrefix = process.platform === 'win32' ? 'F:\\npm' : '/opt/npm'
const npmBin = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin')

test('CLI catalog exposes only fixed install and upgrade commands', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map((tool) => tool.id), ['claude', 'codex', 'opencode', 'ucode'])
  assert.equal(tools[0].installCommand, 'npm install -g @anthropic-ai/claude-code')
  assert.equal(tools[1].installCommand, 'npm install -g @openai/codex')
  assert.equal(tools[2].installCommand, 'npm install -g opencode-ai')
  assert.equal(tools[2].upgradeCommand, 'npm install -g opencode-ai')
  assert.equal(tools[3].installCommand, 'npm install -g @allenchen77/ucode-cli')
  assert.equal(tools[3].upgradeCommand, 'npm install -g @allenchen77/ucode-cli')
})

test('CLI catalog keeps installation separate from safe summary execution', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map(tool => ({
    id: tool.id,
    safeForSummary: tool.safeForSummary,
    summaryExecutorAvailable: tool.summaryExecutorAvailable,
    summaryExecutorUnavailableReason: tool.summaryExecutorUnavailableReason
  })), [
    { id: 'claude', safeForSummary: true, summaryExecutorAvailable: true, summaryExecutorUnavailableReason: '' },
    { id: 'codex', safeForSummary: false, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'no-guaranteed-no-tools-mode' },
    { id: 'opencode', safeForSummary: true, summaryExecutorAvailable: true, summaryExecutorUnavailableReason: '' },
    { id: 'ucode', safeForSummary: false, summaryExecutorAvailable: false, summaryExecutorUnavailableReason: 'no-guaranteed-no-tools-mode' }
  ])
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
