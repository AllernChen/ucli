import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadOpenCodeSessionStats, parseOpenCodeSessionStats } from '../electron/openCodeStats.js'

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
