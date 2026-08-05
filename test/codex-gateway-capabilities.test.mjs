import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CodexAdapter } from '../electron/adapters/codexAdapter.js'

async function parser() {
  return import('../electron/adapters/codexGatewayParser.js')
}

function fixtureLines(name) {
  return readFileSync(
    new URL(`./fixtures/gateway/${name}.jsonl`, import.meta.url),
    'utf8'
  ).trim().split('\n')
}

test('Codex plan completion becomes a plan review instead of task completion', async () => {
  const { extractCodexPlanSnapshot, parseCodexGatewayState } = await parser()
  const lines = fixtureLines('codex-plan')
  const state = parseCodexGatewayState(lines)

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'decision_required'
  ])
  assert.equal(state.currentDecision.kind, 'plan_review')
  assert.deepEqual(extractCodexPlanSnapshot(lines, state.currentDecision.decisionId), {
    kind: 'plan_review',
    title: 'Codex Gateway',
    markdown: '# Codex Gateway\n\n## Goal\nConnect Codex decisions.\n\n## Steps\n1. Parse JSONL.\n2. Route replies.',
    provider: 'codex',
    nativeSessionId: 'codex-native-plan',
    capturedAt: Date.parse('2026-07-30T04:00:02.000Z')
  })
})

test('Codex uses task boundaries for completion and result snapshots', async () => {
  const { extractCodexResultSnapshot, parseCodexGatewayState } = await parser()
  const lines = fixtureLines('codex-result')
  const state = parseCodexGatewayState(lines)

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'turn_completed'
  ])
  assert.deepEqual(extractCodexResultSnapshot(lines, 'codex-turn-result'), {
    kind: 'result',
    title: 'Codex result',
    markdown: 'Codex Gateway 已完成。\n\n所有测试通过。',
    provider: 'codex',
    nativeSessionId: 'codex-native-result',
    turnId: 'codex-turn-result',
    capturedAt: Date.parse('2026-07-30T05:00:03.000Z')
  })
})

test('Codex parses request_user_input and native approval decisions', async () => {
  const { parseCodexGatewayState } = await parser()
  const prefix = fixtureLines('codex-result').slice(0, 2)
  const question = parseCodexGatewayState([
    ...prefix,
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-30T05:00:02.000Z',
      payload: {
        type: 'function_call',
        call_id: 'codex-question',
        name: 'request_user_input',
        arguments: JSON.stringify({
          questions: [{
            id: 'environment',
            header: '环境',
            question: '部署到哪个环境？',
            options: [
              { label: '测试环境', description: '先验证' },
              { label: '生产环境', description: '直接上线' }
            ]
          }]
        })
      }
    })
  ]).currentDecision
  const approval = parseCodexGatewayState([
    ...prefix,
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-30T05:00:02.000Z',
      payload: {
        type: 'function_call',
        call_id: 'codex-approval',
        name: 'shell_command',
        arguments: '{"command":"npm test"}'
      }
    })
  ]).currentDecision

  assert.equal(question.kind, 'question')
  assert.equal(question.responseMode, 'single')
  assert.deepEqual(question.options.map((option) => option.id), ['q0:o0', 'q0:o1'])
  assert.equal(approval.kind, 'permission')
  assert.match(approval.summary, /npm test/)
})

test('Codex pending custom tool call becomes a three-choice approval decision', async () => {
  const { parseCodexGatewayState } = await parser()
  const state = parseCodexGatewayState(fixtureLines('codex-approval'))

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'decision_required'
  ])
  assert.equal(state.currentDecision.kind, 'permission')
  assert.match(state.currentDecision.summary, /npm test/)
  assert.deepEqual(state.currentDecision.options.map((option) => option.id), [
    'allow_once',
    'allow_session',
    'deny'
  ])
})

test('Codex cursor deduplicates events and explicit turn_aborted maps to interruption', async () => {
  const { parseCodexGatewayState } = await parser()
  const lines = fixtureLines('codex-result')
  const first = parseCodexGatewayState(lines)
  assert.deepEqual(parseCodexGatewayState(lines, first.cursor).events, [])

  const interrupted = parseCodexGatewayState([
    ...lines.slice(0, 2),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-30T05:00:02.000Z',
      payload: { type: 'turn_aborted', turn_id: 'codex-turn-result' }
    })
  ])
  assert.deepEqual(interrupted.events.map((event) => event.type), [
    'turn_started',
    'turn_interrupted'
  ])
})

test('Codex adapter verifies current decisions and owns provider input', async () => {
  const adapter = new CodexAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  const writes = []
  adapter._gatewayDecision = (await parser()).parseCodexGatewayState(
    fixtureLines('codex-plan')
  ).currentDecision
  adapter.writeInput = (value) => {
    writes.push(value)
    return true
  }

  assert.deepEqual(adapter.gatewayCapabilities, {
    decisions: true,
    planSnapshot: true,
    resultSnapshot: true
  })
  assert.deepEqual(
    await adapter.respondDecision('stale', { action: 'execute' }),
    { accepted: false, reason: 'already_resolved' }
  )
  assert.deepEqual(
    await adapter.respondDecision(adapter._gatewayDecision.decisionId, { action: 'execute' }),
    { accepted: true }
  )
  assert.deepEqual(writes, ['Implement the approved plan.\r'])
  await adapter.dispose()
})

test('Codex Gateway identifies a resumed rollout by its current ID, not its ancestor session_id', async () => {
  const { parseCodexGatewayState } = await parser()
  const state = parseCodexGatewayState([
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019fcac6-0c62-7da1-92ff-454e53dab197',
        session_id: '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
      }
    })
  ])

  assert.equal(state.nativeSessionId, '019fcac6-0c62-7da1-92ff-454e53dab197')
})

test('Codex adapter writes the second approval choice back to the TUI', async () => {
  const adapter = new CodexAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  const writes = []
  adapter._gatewayDecision = (await parser()).parseCodexGatewayState(
    fixtureLines('codex-approval')
  ).currentDecision
  adapter.writeInput = (value) => {
    writes.push(value)
    return true
  }

  assert.deepEqual(
    await adapter.respondDecision('call-approval', { optionId: 'allow_session' }),
    { accepted: true }
  )
  assert.deepEqual(writes, ['\x1b[B', '\r'])
  await adapter.dispose()
})
