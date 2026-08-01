import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import * as cliTools from '../electron/cliTools.js'

const { inspectCliTool, listCliToolDefinitions, runCliToolAction } = cliTools

test('CLI catalog exposes only fixed install and upgrade commands', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map((tool) => tool.id), ['claude', 'codex', 'opencode', 'ucode'])
  assert.equal(tools[0].installCommand, 'npm install -g @anthropic-ai/claude-code')
  assert.equal(tools[1].installCommand, 'npm install -g @openai/codex')
  assert.equal(tools[2].installCommand, 'npm install -g opencode-ai')
  assert.equal(tools[2].upgradeCommand, 'opencode upgrade')
  const currentTarget = `${process.platform}-${process.arch}`
  if (['win32-x64', 'darwin-arm64', 'linux-x64'].includes(currentTarget)) {
    assert.match(tools[3].installCommand, /github\.com\/AllernChen\/U-Code\/releases\/latest\/download\//)
  } else {
    assert.match(tools[3].installCommand, /does not publish a GitHub Release asset/)
  }
  assert.doesNotMatch(tools[3].installCommand, /ucode\.xiaomi\.com|npm install/)
  assert.equal(tools[3].upgradeCommand, tools[3].installCommand)
})

test('U-Code installer selects only assets published by the GitHub release workflow', () => {
  assert.equal(typeof cliTools.buildUCodeInstallCommand, 'function')
  assert.match(cliTools.buildUCodeInstallCommand('win32', 'x64'), /ucode-windows-x64\.zip/)
  assert.match(cliTools.buildUCodeInstallCommand('darwin', 'arm64'), /ucode-darwin-arm64\.zip/)
  assert.match(cliTools.buildUCodeInstallCommand('linux', 'x64'), /ucode-linux-x64\.tar\.gz/)
  assert.throws(
    () => cliTools.buildUCodeInstallCommand('darwin', 'x64'),
    /U-Code does not publish a GitHub Release asset for darwin-x64/
  )
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

test('successful U-Code installation is immediately available to the running app', async () => {
  const originalPath = process.env.PATH
  process.env.PATH = 'F:\\existing-bin'
  try {
    const runner = async () => ({ code: 0, stdout: '0.1.9\n', stderr: '' })
    await runCliToolAction('ucode', 'install', runner)
    assert.equal(
      process.env.PATH.split(path.delimiter)[0],
      path.join(os.homedir(), '.ucode', 'bin')
    )
  } finally {
    process.env.PATH = originalPath
  }
})

test('U-Code inspection restores the persistent install directory after an app restart', async () => {
  const originalPath = process.env.PATH
  process.env.PATH = 'F:\\existing-bin'
  try {
    const installDir = path.join(os.homedir(), '.ucode', 'bin')
    const runner = async (command) => {
      assert.equal(process.env.PATH.split(path.delimiter)[0], installDir)
      return command.includes('--version')
        ? { code: 0, stdout: '0.1.9\n', stderr: '' }
        : { code: 0, stdout: `${path.join(installDir, 'ucode')}\n`, stderr: '' }
    }

    const status = await inspectCliTool('ucode', runner)
    assert.equal(status.installed, true)
    assert.equal(status.version, '0.1.9')
  } finally {
    process.env.PATH = originalPath
  }
})
