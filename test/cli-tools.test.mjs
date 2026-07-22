import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectCliTool, listCliToolDefinitions, runCliToolAction } from '../electron/cliTools.js'

test('CLI catalog exposes only fixed install and upgrade commands', () => {
  const tools = listCliToolDefinitions()
  assert.deepEqual(tools.map((tool) => tool.id), ['claude', 'codex'])
  assert.equal(tools[0].installCommand, 'npm install -g @anthropic-ai/claude-code')
  assert.equal(tools[1].installCommand, 'npm install -g @openai/codex')
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
