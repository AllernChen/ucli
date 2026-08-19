import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  exportOpenCodeSession,
  loadOpenCodeSessionStats,
  parseOpenCodeSessionStats
} from '../electron/openCodeStats.js'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/opencode/session-export.json', import.meta.url),
  'utf8'
))

test('uses exported session totals without double-counting step-finish usage', () => {
  const stats = parseOpenCodeSessionStats(fixture)

  assert.deepEqual(stats, {
    inputTokens: 4512,
    outputTokens: 54,
    cachedInputTokens: 22272,
    reasoningOutputTokens: 19,
    turnsCount: 2,
    completedTurnsCount: 2,
    costUsd: 0,
    costAvailable: true,
    lastModel: 'glm/glm-5.2',
    modelBreakdown: [{
      model: 'glm/glm-5.2',
      inputTokens: 4512,
      outputTokens: 54,
      costUsd: 0,
      costAvailable: true
    }]
  })
})

test('returns safe empty statistics for a malformed messages container', () => {
  const stats = parseOpenCodeSessionStats({
    info: { id: 'ses_broken', tokens: { input: 2, output: 3 } },
    messages: { unexpected: true }
  })

  assert.deepEqual(stats, {
    inputTokens: 2,
    outputTokens: 3,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    turnsCount: 0,
    completedTurnsCount: 0,
    costUsd: null,
    costAvailable: false,
    lastModel: null,
    modelBreakdown: []
  })
})

test('keeps unavailable OpenCode cost distinct from a real zero cost', () => {
  const source = structuredClone(fixture)
  delete source.info.cost
  for (const message of source.messages) delete message.info.cost

  const stats = parseOpenCodeSessionStats(source)

  assert.equal(stats.costUsd, null)
  assert.equal(stats.costAvailable, false)
  assert.deepEqual(stats.modelBreakdown, [{
    model: 'glm/glm-5.2',
    inputTokens: 4512,
    outputTokens: 54,
    costUsd: 0,
    costAvailable: false
  }])
})

test('keeps per-model usage separate when a session changes models', () => {
  const source = structuredClone(fixture)
  source.info.model = { id: 'gpt-5', providerID: 'openai' }
  source.messages[4].info.modelID = 'gpt-5'
  source.messages[4].info.providerID = 'openai'

  const stats = parseOpenCodeSessionStats(source)

  assert.equal(stats.lastModel, 'openai/gpt-5')
  assert.deepEqual(stats.modelBreakdown, [
    {
      model: 'glm/glm-5.2',
      inputTokens: 4427,
      outputTokens: 38,
      costUsd: 0,
      costAvailable: true
    },
    {
      model: 'openai/gpt-5',
      inputTokens: 85,
      outputTokens: 16,
      costUsd: 0,
      costAvailable: true
    }
  ])
})

test('returns zero usage for an empty export', () => {
  assert.deepEqual(parseOpenCodeSessionStats(null), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    turnsCount: 0,
    completedTurnsCount: 0,
    costUsd: null,
    costAvailable: false,
    lastModel: null,
    modelBreakdown: []
  })
})

test('loads a sanitized official export before parsing session statistics', async () => {
  const calls = []
  const stats = await loadOpenCodeSessionStats('ses_fixture', {
    execFileFn(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, JSON.stringify(fixture), '')
    }
  })

  assert.deepEqual(calls, [{
    file: 'opencode',
    args: ['export', 'ses_fixture', '--sanitize'],
    options: { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
  }])
  assert.equal(stats.inputTokens, 4512)
  assert.equal(stats.completedTurnsCount, 2)
})

test('uses the resolved Windows executable for an official export', async () => {
  const calls = []
  await loadOpenCodeSessionStats('ses_fixture', {
    executable: 'F:\\soft\\nvm\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe',
    execFileFn(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, JSON.stringify(fixture), '')
    }
  })

  assert.equal(calls[0].file, 'F:\\soft\\nvm\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe')
  assert.deepEqual(calls[0].args, ['export', 'ses_fixture', '--sanitize'])
})

test('exports sanitized OpenCode source by default for statistics', async () => {
  const calls = []
  const source = await exportOpenCodeSession('ses_fixture', {
    executable: 'opencode.exe',
    prefixArgs: ['--wrapper'],
    execFileFn(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, JSON.stringify(fixture), '')
    }
  })

  assert.equal(source.info.id, 'ses_fixture')
  assert.equal(source.messages.length, 5)
  assert.deepEqual(calls, [{
    file: 'opencode.exe',
    args: ['--wrapper', 'export', 'ses_fixture', '--sanitize'],
    options: {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024
    }
  }])
})

test('exports unsanitized OpenCode source when complete history is requested', async () => {
  const calls = []
  await exportOpenCodeSession('ses_fixture', {
    executable: 'opencode.exe',
    sanitize: false,
    execFileFn(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, JSON.stringify(fixture), '')
    }
  })

  assert.deepEqual(calls[0].args, ['export', 'ses_fixture'])
})

test('sanitized export never falls back through a Windows command shell', async () => {
  let executions = 0
  const source = await exportOpenCodeSession('ses_fixture', {
    executable: 'cmd.exe',
    prefixArgs: ['/c', 'opencode'],
    execFileFn(_file, _args, _options, callback) {
      executions += 1
      callback(null, JSON.stringify(fixture), '')
    }
  })

  assert.equal(source, null)
  assert.equal(executions, 0)
})

test('sums per-message usage when a session export omits the info.tokens aggregate', () => {
  // ucode's `export` records usage only on assistant messages; it has no
  // session-level `info.tokens`, `info.cost`, `info.model`, or `finish` field.
  const source = {
    info: { id: 'ses_ucode', version: '2.1.220', time: { created: 1, updated: 2 } },
    messages: [
      {
        info: {
          role: 'user', agent: 'main',
          model: { providerID: 'anthropic', modelID: 'unknown' },
          id: 'msg_u1', sessionID: 'ses_ucode'
        },
        parts: [{ type: 'text', text: 'hello' }]
      },
      {
        info: {
          role: 'assistant', modelID: 'glm-5.3', providerID: 'anthropic', mode: 'build',
          cost: 0,
          tokens: { input: 37797, output: 333, reasoning: 0, cache: { read: 1984, write: 0 } },
          id: 'msg_a1', sessionID: 'ses_ucode'
        },
        parts: [{ type: 'text', text: 'hi' }]
      },
      {
        info: {
          role: 'assistant', modelID: 'deepseek-v4-pro', providerID: 'anthropic', mode: 'build',
          cost: 0,
          tokens: { input: 910969, output: 26576, reasoning: 512, cache: { read: 4096, write: 0 } },
          id: 'msg_a2', sessionID: 'ses_ucode'
        },
        parts: [{ type: 'text', text: 'done' }]
      }
    ]
  }

  const stats = parseOpenCodeSessionStats(source)

  assert.equal(stats.inputTokens, 948766)
  assert.equal(stats.outputTokens, 26909)
  assert.equal(stats.cachedInputTokens, 6080)
  assert.equal(stats.reasoningOutputTokens, 512)
  assert.equal(stats.turnsCount, 1)
  assert.equal(stats.lastModel, 'anthropic/deepseek-v4-pro')
  assert.equal(stats.costAvailable, false)
  assert.equal(stats.costUsd, null)
  assert.deepEqual(stats.modelBreakdown, [
    {
      model: 'anthropic/glm-5.3',
      inputTokens: 37797,
      outputTokens: 333,
      costUsd: 0,
      costAvailable: true
    },
    {
      model: 'anthropic/deepseek-v4-pro',
      inputTokens: 910969,
      outputTokens: 26576,
      costUsd: 0,
      costAvailable: true
    }
  ])
})
