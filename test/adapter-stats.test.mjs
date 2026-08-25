import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { ClaudeAdapter, parseClaudeTranscriptStats } from '../electron/adapters/claudeAdapter.js'
import {
  buildCodexArgs,
  classifyCodexTerminalNotification,
  codexDescriptor,
  CodexAdapter,
  consumeOsc9Notifications,
  parseCodexTranscriptStats
} from '../electron/adapters/codexAdapter.js'
import { OpenCodeAdapter, openCodeDescriptor } from '../electron/adapters/openCodeAdapter.js'
import { getDb, openDb } from '../electron/persistence/db.js'
import { normalizeAdapterStatsEvent } from '../electron/usage/usageRecorder.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('counts current Claude TUI string user content as a turn', () => {
  const stats = parseClaudeTranscriptStats([
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Generate the bounded summary.' }
    })
  ])

  assert.equal(stats.turnsCount, 1)
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

test('Codex token statistics explicitly declare provider cost unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-unknown-cost-'))
  const transcript = join(root, 'rollout.jsonl')
  writeFileSync(transcript, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'native-1', model: 'gpt-5.5' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48 }
        }
      }
    })
  ].join('\n'))
  const adapter = new CodexAdapter({
    session: { id: 's1', cwd: root, cliSessionId: null },
    engine: null,
    settings: { codexHome: root }
  })
  const events = []
  adapter.on('event', event => events.push(event))
  adapter._transcriptPath = transcript

  try {
    adapter._extractStats()
    const update = events.find(event => event.type === 'stats_update')
    assert.equal(codexDescriptor.costAvailable, false)
    assert.equal(update.costAvailable, false)
    assert.equal(update.costUsd, null)
  } finally {
    await adapter.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex stats keep the current rollout ID when resumed history contains ancestor metadata', () => {
  const currentId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  const ancestorId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const stats = parseCodexTranscriptStats([
    JSON.stringify({
      type: 'session_meta',
      payload: { id: currentId, session_id: ancestorId }
    }),
    JSON.stringify({ type: 'session_meta', payload: { id: ancestorId } })
  ])

  assert.equal(stats.cliSessionId, currentId)
})

test('Codex transcript scan emits a rebind when a newer resumed rollout is found', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-adapter-lineage-'))
  const cwd = 'F:\\projects\\ucli'
  const originalId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const currentId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  const originalDir = join(codexHome, 'sessions', '2026', '07', '31')
  const currentDir = join(codexHome, 'sessions', '2026', '08', '04')
  mkdirSync(originalDir, { recursive: true })
  mkdirSync(currentDir, { recursive: true })
  writeFileSync(join(originalDir, `rollout-${originalId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-31T10:45:56.141Z',
    payload: { id: originalId, timestamp: '2026-07-31T10:45:56.141Z', cwd }
  }) + '\n')
  writeFileSync(join(currentDir, `rollout-${currentId}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-04T03:16:45.513Z',
      payload: {
        id: currentId,
        forked_from_id: originalId,
        timestamp: '2026-08-04T03:16:44.963Z',
        cwd
      }
    }),
    JSON.stringify({ type: 'session_meta', payload: { id: originalId, cwd } })
  ].join('\n') + '\n')

  const session = { id: 'ucli-session', cwd, cliSessionId: originalId }
  const adapter = new CodexAdapter({ session, engine: null, settings: { codexHome } })
  const initEvents = []
  adapter.on('event', (event) => {
    if (event.type === 'init') initEvents.push(event)
  })
  try {
    adapter._extractStats()
    assert.equal(session.cliSessionId, currentId)
    assert.deepEqual(initEvents.map((event) => event.cliSessionId), [currentId])
  } finally {
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex latest transcript discovery ignores newer subagent rollouts', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-main-rollout-'))
  const cwd = 'F:\\projects\\ucli'
  const mainId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  const subagentId = '019fd0c3-a019-7ad0-a634-489043a4f49c'
  const dir = join(codexHome, 'sessions', '2026', '08', '05')
  mkdirSync(dir, { recursive: true })
  const mainPath = join(dir, `rollout-main-${mainId}.jsonl`)
  writeFileSync(mainPath, JSON.stringify({
    type: 'session_meta',
    payload: { id: mainId, timestamp: '2026-08-05T07:10:00.000Z', cwd }
  }) + '\n')
  writeFileSync(join(dir, `rollout-subagent-${subagentId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    payload: {
      id: subagentId,
      session_id: mainId,
      parent_thread_id: mainId,
      timestamp: '2026-08-05T07:11:49.365Z',
      cwd,
      thread_source: 'subagent'
    }
  }) + '\n')

  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd, cliSessionId: null },
    engine: null,
    settings: { codexHome }
  })
  adapter._startedAt = Date.parse('2026-08-05T07:00:00.000Z')
  try {
    assert.equal(adapter._findLatestTranscript(), mainPath)
  } finally {
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex native /resume rebinds to the uniquely created non-descendant rollout', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-native-resume-'))
  const cwd = 'F:\\projects\\ucli'
  const boundId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const selectedId = '019fd111-1111-7111-8111-111111111111'
  const unrelatedRootId = '019fd222-2222-7222-8222-222222222222'
  const unrelatedId = '019faaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'
  const dir = join(codexHome, 'sessions', '2026', '08', '05')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-bound-${boundId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: boundId, timestamp: '2026-08-05T06:00:00.000Z', cwd }
  }) + '\n')
  writeFileSync(join(dir, `rollout-unrelated-${unrelatedId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: unrelatedId, timestamp: '2026-08-05T06:30:00.000Z', cwd }
  }) + '\n')

  const session = { id: 'ucli-session', cwd, cliSessionId: boundId }
  const adapter = new CodexAdapter({ session, engine: null, settings: { codexHome } })
  adapter.ptyProc = { write() {} }
  const initEvents = []
  adapter.on('event', (event) => {
    if (event.type === 'init') initEvents.push(event.cliSessionId)
  })
  try {
    adapter.writeInput('/res')
    adapter.writeInput('ume\r')
    writeFileSync(join(dir, `rollout-selected-${selectedId}.jsonl`), JSON.stringify({
      type: 'session_meta',
      payload: {
        id: selectedId,
        forked_from_id: unrelatedId,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        cwd
      }
    }) + '\n')
    writeFileSync(join(dir, `rollout-root-${unrelatedRootId}.jsonl`), JSON.stringify({
      type: 'session_meta',
      payload: {
        id: unrelatedRootId,
        timestamp: new Date(Date.now() + 1500).toISOString(),
        cwd
      }
    }) + '\n')
    adapter._extractStats()

    assert.equal(session.cliSessionId, selectedId)
    assert.deepEqual(initEvents, [selectedId])
  } finally {
    adapter.ptyProc = null
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex cancels native /resume binding capture when the picker is dismissed', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-native-resume-cancel-'))
  const cwd = 'F:\\projects\\ucli'
  const boundId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const candidateId = '019fd333-3333-7333-8333-333333333333'
  const unrelatedId = '019faaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'
  const dir = join(codexHome, 'sessions', '2026', '08', '05')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-bound-${boundId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: boundId, timestamp: '2026-08-05T06:00:00.000Z', cwd }
  }) + '\n')
  writeFileSync(join(dir, `rollout-unrelated-${unrelatedId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: unrelatedId, timestamp: '2026-08-05T06:30:00.000Z', cwd }
  }) + '\n')

  const session = { id: 'ucli-session', cwd, cliSessionId: boundId }
  const adapter = new CodexAdapter({ session, engine: null, settings: { codexHome } })
  adapter.ptyProc = { write() {} }
  try {
    adapter.writeInput('/resume\r')
    adapter.writeInput('\x1b')
    writeFileSync(join(dir, `rollout-candidate-${candidateId}.jsonl`), JSON.stringify({
      type: 'session_meta',
      payload: {
        id: candidateId,
        forked_from_id: unrelatedId,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        cwd
      }
    }) + '\n')
    adapter._extractStats()

    assert.equal(session.cliSessionId, boundId)
  } finally {
    adapter.ptyProc = null
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex live transcript rebinding does not replay copied Gateway lifecycle events', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-gateway-rebind-'))
  const cwd = 'F:\\projects\\ucli'
  const originalId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const currentId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  const originalDir = join(codexHome, 'sessions', '2026', '07', '31')
  const currentDir = join(codexHome, 'sessions', '2026', '08', '04')
  mkdirSync(originalDir, { recursive: true })
  mkdirSync(currentDir, { recursive: true })
  const originalPath = join(originalDir, `rollout-${originalId}.jsonl`)
  const copiedEvents = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'historical-turn' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'historical-turn' } })
  ]
  writeFileSync(originalPath, [
    JSON.stringify({
      type: 'session_meta', payload: { id: originalId, timestamp: '2026-07-31T10:45:56.141Z', cwd }
    }),
    ...copiedEvents
  ].join('\n') + '\n')
  writeFileSync(join(currentDir, `rollout-${currentId}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: currentId, forked_from_id: originalId, timestamp: '2026-08-04T03:16:44.963Z', cwd }
    }),
    ...copiedEvents,
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn' } })
  ].join('\n') + '\n')

  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd, cliSessionId: originalId },
    engine: null,
    settings: { codexHome }
  })
  adapter._transcriptPath = originalPath
  adapter._primeGatewayCursor()
  const events = []
  adapter.on('gateway-event', (event) => events.push(event.type))
  try {
    adapter._extractStats()
    assert.deepEqual(events, ['turn_started', 'turn_completed'])
  } finally {
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex transcript stats throttle full lineage scans independently from terminal updates', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-lineage-throttle-'))
  const cwd = 'F:\\projects\\ucli'
  const sessionId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const dir = join(codexHome, 'sessions', '2026', '08', '05')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `rollout-${sessionId}.jsonl`)
  writeFileSync(transcript, JSON.stringify({
    type: 'session_meta', payload: { id: sessionId, cwd }
  }) + '\n')
  let scans = 0
  const adapter = new CodexAdapter({
    session: { id: 'ucli-session', cwd, cliSessionId: sessionId },
    engine: null,
    settings: {
      codexHome,
      codexSessionResolver: () => {
        scans += 1
        return { sessionId, path: transcript }
      }
    }
  })
  try {
    adapter._extractStats()
    adapter._extractStats()
    assert.equal(scans, 1)
  } finally {
    await adapter.dispose()
    rmSync(codexHome, { recursive: true, force: true })
  }
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

test('orchestrator records ledger observations beside legacy cumulative stats', () => {
  const source = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const statsCase = source.match(/case 'stats_update':[\s\S]*?case 'profile-model'/)?.[0] || ''

  assert.match(statsCase, /await usageRecorder\.observe\(/)
  assert.match(statsCase, /models:\s*evt\.models/)
  assert.match(statsCase, /modelBreakdown:\s*evt\.modelBreakdown/)
  assert.match(statsCase, /model:\s*evt\.model/)
  assert.match(statsCase, /db\.upsertStats\(sessionId,/)
  assert.match(statsCase, /db\.upsertModelStats\(sessionId,/)
  assert.match(source, /onApprovalResolved\(req\)[\s\S]*usageRecorder\.recordApproval\([\s\S]*approvalId:\s*req\.requestId/)
})

test('orchestrator drops native-owned stats before mutating or recording session state', () => {
  // Normalize CRLF so Windows checkouts (git autocrlf) still match the source
  // line patterns; the regex below anchors on literal \n line endings.
  const source = readFileSync(new URL('../electron/orchestrator.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
  const handler = source.match(/async function handleAdapterEvent[\s\S]*?\n  }\n/)?.[0] || ''
  const ownershipGate = handler.indexOf("evt?.type === 'stats_update' && !sessionUsesUcliStats(entry.session)")

  assert.ok(ownershipGate >= 0)
  assert.ok(ownershipGate < handler.indexOf('entry.updatedAt ='))
  assert.ok(ownershipGate < handler.indexOf('await usageRecorder.observe('))
  assert.ok(ownershipGate < handler.indexOf('db.upsertStats(sessionId,'))
  assert.ok(ownershipGate < handler.indexOf("send('session:event'"))
})

test('UCLI-owned adapter startup zeroes are synthetic while native DSH emits no stats', () => {
  for (const file of [
    'claudeAdapter.js',
    'codexAdapter.js',
    'openCodeAdapter.js'
  ]) {
    const source = readFileSync(new URL(`../electron/adapters/${file}`, import.meta.url), 'utf8')
    assert.match(
      source,
      /type:\s*'stats_update',[\s\S]{0,180}usage:\s*\{\s*inputTokens:\s*0,\s*outputTokens:\s*0\s*\},[\s\S]{0,180}synthetic:\s*true/,
      file
    )
  }
  const dshSource = readFileSync(
    new URL('../electron/adapters/deepSeekHarnessAdapter.js', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(dshSource, /type:\s*'stats_update'/)
  const orchestrator = readFileSync(
    new URL('../electron/orchestrator.js', import.meta.url),
    'utf8'
  )
  const statsCase = orchestrator.match(/case 'stats_update':[\s\S]*?case 'profile-model'/)?.[0] || ''
  assert.match(statsCase, /usageRecorder\.observe\(\{[\s\S]*synthetic:\s*evt\.synthetic/)
})

test('restored session totals and model totals survive a synthetic adapter restart', async () => {
  register('./fixtures/electron-stub-loader.mjs', import.meta.url)
  const electron = await import('electron')
  const handlers = new Map()
  electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler)

  const root = mkdtempSync(join(tmpdir(), 'ucli-restored-synthetic-'))
  const userData = join(root, 'user-data')
  mkdirSync(userData, { recursive: true })
  const sessionId = 'restored-opencode-session'
  const model = 'glm/glm-5.2'
  const dbPath = join(userData, 'ucli.db')
  const seed = await openDb(dbPath)
  seed.insertSession({
    id: sessionId,
    project_path: 'F:/projects/ucli',
    adapter_id: 'opencode',
    native_session_id: 'native-session',
    name: 'Restored',
    tier: 'safety-rules',
    model,
    status: 'offline',
    created_at: 1
  })
  seed.upsertStats(sessionId, {
    inputTokens: 100, outputTokens: 25, costUsd: null,
    costAvailable: false, turnsDelta: 4
  })
  seed.upsertModelStats(sessionId, model, {
    inputTokens: 100, outputTokens: 25, costUsd: null, costAvailable: false
  })
  seed.flush()
  seed.close()

  let eventHandler = null
  const fakeAdapter = {
    on(type, handler) { if (type === 'event') eventHandler = handler },
    async start() {
      await eventHandler({
        type: 'stats_update', synthetic: true,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: null, costAvailable: false, turns: 0, model
      })
      return true
    },
    async emitStats(inputTokens, outputTokens, turns) {
      await eventHandler({
        type: 'stats_update',
        usage: { inputTokens, outputTokens },
        costUsd: null, costAvailable: false, turns, model,
        modelBreakdown: [{
          model, inputTokens, outputTokens, costUsd: null, costAvailable: false
        }]
      })
    },
    async dispose() {}
  }
  const originalCreate = openCodeDescriptor.create
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.UCLI_TEST_USER_DATA = userData
  openCodeDescriptor.create = () => fakeAdapter
  let orchestrator = null
  const rendererEvents = []
  try {
    const { createOrchestrator } = await import(`../electron/orchestrator.js?synthetic-restored=${Date.now()}`)
    orchestrator = createOrchestrator()
    await orchestrator.initPersistence()
    orchestrator.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => rendererEvents.push({ channel, payload }) }
    })
    orchestrator.registerIpc()

    await handlers.get('session:restart')({}, sessionId)
    const syntheticEvent = rendererEvents.find(({ payload }) =>
      payload.type === 'stats_update' && payload.synthetic === true
    )?.payload
    assert.deepEqual(syntheticEvent.usage, { inputTokens: 100, outputTokens: 25 })
    assert.equal(syntheticEvent.turns, 4)
    let restored = (await handlers.get('session:list')()).find(item => item.id === sessionId)
    assert.deepEqual(restored.stats.tokens, { input: 100, output: 25 })
    assert.equal(restored.stats.turns, 4)
    assert.deepEqual(getDb().getModelStatsForSession(sessionId), [{
      model, input_tokens: 100, output_tokens: 25,
      cost_usd: 0, cost_available: 0
    }])

    await fakeAdapter.emitStats(100, 25, 4)
    await fakeAdapter.emitStats(110, 30, 5)
    restored = (await handlers.get('session:list')()).find(item => item.id === sessionId)
    assert.deepEqual(restored.stats.tokens, { input: 110, output: 30 })
    assert.equal(restored.stats.turns, 5)
    assert.deepEqual(getDb().getModelStatsForSession(sessionId), [{
      model, input_tokens: 110, output_tokens: 30,
      cost_usd: 0, cost_available: 0
    }])
    assert.deepEqual(
      getDb().queryUsageEvents({ scopes: ['session'], adapterIds: ['opencode'] })
        .map(event => ({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, turns: event.turns })),
      [
        { inputTokens: 100, outputTokens: 25, turns: 4 },
        { inputTokens: 10, outputTokens: 5, turns: 1 }
      ]
    )
  } finally {
    openCodeDescriptor.create = originalCreate
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

test('orchestrator stats normalization accepts nested and parser-style adapter fields', () => {
  assert.deepEqual(normalizeAdapterStatsEvent({
    type: 'stats_update', inputTokens: 40, outputTokens: 8,
    turnsCount: 3, completedTurnsCount: 2, lastModel: 'gpt-5.5',
    models: [{ model: 'gpt-5.5', inputTokens: 40, outputTokens: 8 }]
  }, { tokens: { input: 10, output: 2 }, turns: 1 }), {
    type: 'stats_update', inputTokens: 40, outputTokens: 8,
    turnsCount: 3, completedTurnsCount: 2, lastModel: 'gpt-5.5',
    models: [{ model: 'gpt-5.5', inputTokens: 40, outputTokens: 8 }],
    usage: { inputTokens: 40, outputTokens: 8 },
    turns: 3,
    completedTurns: 2,
    model: 'gpt-5.5'
  })

  const nested = normalizeAdapterStatsEvent({
    usage: { inputTokens: 50, outputTokens: 9, cachedInputTokens: 20 },
    turns: 4, model: 'claude-sonnet'
  })
  assert.deepEqual(nested.usage, {
    inputTokens: 50, outputTokens: 9, cachedInputTokens: 20
  })
})
