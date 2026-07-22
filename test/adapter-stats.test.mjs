import test from 'node:test'
import assert from 'node:assert/strict'

import { parseClaudeTranscriptStats } from '../electron/adapters/claudeAdapter.js'
import { parseCodexTranscriptStats } from '../electron/adapters/codexAdapter.js'

test('parses Claude transcript stats from assistant usage and result modelUsage', () => {
  const stats = parseClaudeTranscriptStats([
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'deepseek-v4-pro',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 200,
          output_tokens: 30
        }
      }
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'next' }] }
    }),
    JSON.stringify({
      type: 'result',
      total_cost_usd: 0.0123,
      num_turns: 2,
      modelUsage: {
        'deepseek-v4-pro': { inputTokens: 300, outputTokens: 40, costUSD: 0.01 },
        'gpt-5.5': { inputTokens: 10, outputTokens: 5, costUSD: 0.0023 }
      }
    })
  ])

  assert.equal(stats.inputTokens, 310)
  assert.equal(stats.outputTokens, 45)
  assert.equal(stats.turnsCount, 2)
  assert.equal(stats.costUsd, 0.0123)
  assert.equal(stats.lastModel, 'gpt-5.5')
  assert.deepEqual(stats.modelBreakdown, [
    { model: 'deepseek-v4-pro', inputTokens: 300, outputTokens: 40, costUsd: 0.01 },
    { model: 'gpt-5.5', inputTokens: 10, outputTokens: 5, costUsd: 0.0023 }
  ])
})

test('parses Codex token_count events and session metadata', () => {
  const stats = parseCodexTranscriptStats([
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: '019f40f8-38d9-7670-8a29-0ed47d16af59',
        model: 'gpt-5.5'
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 780343,
            cached_input_tokens: 684288,
            output_tokens: 7263,
            reasoning_output_tokens: 1897,
            total_tokens: 787606
          },
          last_token_usage: {
            input_tokens: 86778,
            cached_input_tokens: 67968,
            output_tokens: 665,
            reasoning_output_tokens: 297,
            total_tokens: 87443
          },
          model_context_window: 258400
        }
      }
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } })
  ])

  assert.equal(stats.cliSessionId, '019f40f8-38d9-7670-8a29-0ed47d16af59')
  assert.equal(stats.inputTokens, 780343)
  assert.equal(stats.outputTokens, 7263)
  assert.equal(stats.cachedInputTokens, 684288)
  assert.equal(stats.reasoningOutputTokens, 1897)
  assert.equal(stats.totalTokens, 787606)
  assert.equal(stats.contextWindow, 258400)
  assert.equal(stats.turnsCount, 1)
  assert.equal(stats.lastModel, 'gpt-5.5')
})
