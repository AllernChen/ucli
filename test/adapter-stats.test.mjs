import test from 'node:test'
import assert from 'node:assert/strict'

import { ClaudeAdapter, parseClaudeTranscriptStats } from '../electron/adapters/claudeAdapter.js'
import {
  buildCodexArgs,
  classifyCodexTerminalNotification,
  CodexAdapter,
  consumeOsc9Notifications,
  parseCodexTranscriptStats
} from '../electron/adapters/codexAdapter.js'
import { OpenCodeAdapter } from '../electron/adapters/openCodeAdapter.js'

test('parses Claude transcript stats from assistant usage and result modelUsage', () => {
  const stats = parseClaudeTranscriptStats([
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'deepseek-v4-pro',
        stop_reason: 'end_turn',
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
  assert.equal(stats.completedTurnsCount, 1)
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
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
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
  assert.equal(stats.completedTurnsCount, 1)
  assert.equal(stats.lastModel, 'gpt-5.5')
})

test('Codex transcript scan has a max wait during continuous TUI output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd: 'F:\\projects\\ucli', cliSessionId: null },
    engine: null,
    settings: {}
  })
  let scans = 0
  adapter._extractStats = () => { scans += 1 }

  for (let second = 0; second < 30; second++) {
    adapter._scheduleStatsUpdate()
    t.mock.timers.tick(1000)
  }

  assert.equal(scans, 1)
  await adapter.dispose()
})

test('Codex transcript scan still runs quickly after terminal output becomes idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd: 'F:\\projects\\ucli', cliSessionId: null },
    engine: null,
    settings: {}
  })
  let scans = 0
  adapter._extractStats = () => { scans += 1 }

  adapter._scheduleStatsUpdate()
  t.mock.timers.tick(1999)
  assert.equal(scans, 0)
  t.mock.timers.tick(1)
  assert.equal(scans, 1)
  await adapter.dispose()
})

test('Codex history replay unwraps current response_item message events', async () => {
  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd: 'F:\\projects\\ucli', cliSessionId: 'thread-1' },
    engine: null,
    settings: {}
  })
  const output = []
  adapter._write = (text) => output.push(text)

  adapter._formatEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'restore this user message' }]
    }
  })
  adapter._formatEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'restore this assistant message' }]
    }
  })

  assert.match(output.join(''), /restore this user message/)
  assert.match(output.join(''), /restore this assistant message/)
  await adapter.dispose()
})

test('Codex resume adopts the requested native session ID', async () => {
  const session = { id: 'ucli-session', cwd: 'F:\\projects\\ucli', cliSessionId: 'old-thread' }
  const adapter = new CodexAdapter({ session, engine: null, settings: {} })
  adapter.dispose = async () => {}
  adapter.start = async () => {}

  await adapter.resume('new-thread')
  assert.equal(session.cliSessionId, 'new-thread')
})

test('OpenCode retries native session discovery until its session is listed', async () => {
  const adapter = new OpenCodeAdapter({
    session: { id: 'ucli-session', cwd: 'F:\\tmp\\ucli-no-session', cliSessionId: null },
    engine: null,
    settings: {}
  })
  let scans = 0
  adapter.sessionDiscoveryDelayMs = 1
  adapter.sessionDiscoveryRetryMs = 1
  adapter.sessionDiscoveryMaxAttempts = 2
  adapter.sessionFinder = async () => {
    scans += 1
    return scans === 1 ? [] : [{ sessionId: 'ses_recovered', name: 'Recovered', startedAt: Date.now() }]
  }

  adapter._scheduleSessionDiscovery()
  const deadline = Date.now() + 1000
  while (scans < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.equal(scans, 2)
  assert.equal(adapter.session.cliSessionId, 'ses_recovered')
  await adapter.dispose()
})

test('Claude transcript scan has a max wait during continuous TUI output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = new ClaudeAdapter({
    session: { id: 'ucli-session', cwd: 'F:\\projects\\ucli', cliSessionId: null },
    engine: null,
    settings: {}
  })
  let scans = 0
  adapter._extractStats = () => { scans += 1 }

  for (let second = 0; second < 30; second++) {
    adapter._scheduleStatsUpdate()
    t.mock.timers.tick(1000)
  }

  assert.equal(scans, 1)
  await adapter.dispose()
})

test('Codex enables OSC 9 notifications for approvals and completed turns', () => {
  const args = buildCodexArgs({ cliSessionId: null, provider: null, model: null })
  assert.deepEqual(args.slice(0, 7), [
    '--no-alt-screen',
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"'
  ])
})

test('OSC 9 parser handles notification sequences split across PTY chunks', () => {
  const first = consumeOsc9Notifications('', '\u001b]9;Approval req')
  assert.deepEqual(first.messages, [])
  const second = consumeOsc9Notifications(first.pending, 'uested: npm test\u0007rest')
  assert.deepEqual(second.messages, ['Approval requested: npm test'])
  assert.equal(second.pending, '')
})

test('Codex terminal notification distinguishes approvals from completion', () => {
  assert.deepEqual(classifyCodexTerminalNotification('Approval requested: npm test'), {
    kind: 'approval',
    operation: '执行命令'
  })
  assert.deepEqual(classifyCodexTerminalNotification('Codex wants to edit 2 files'), {
    kind: 'approval',
    operation: '修改文件'
  })
  assert.deepEqual(classifyCodexTerminalNotification('Plan mode prompt: Implement this plan?'), {
    kind: 'approval',
    operation: '确认执行方案'
  })
  assert.deepEqual(classifyCodexTerminalNotification('Finished implementing the feature'), {
    kind: 'complete',
    operation: '任务完成'
  })
})
