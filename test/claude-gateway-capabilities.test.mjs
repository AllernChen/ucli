import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ClaudeAdapter } from '../electron/adapters/claudeAdapter.js'

async function parser() {
  return import('../electron/adapters/claudeGatewayParser.js')
}

function fixtureLines(name) {
  return readFileSync(
    new URL(`./fixtures/gateway/${name}.jsonl`, import.meta.url),
    'utf8'
  ).trim().split('\n')
}

test('Claude parser exposes a pending plan decision and its full snapshot', async () => {
  const { extractClaudePlanSnapshot, parseClaudeGatewayState } = await parser()
  const state = parseClaudeGatewayState(fixtureLines('claude-plan'))

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'decision_required'
  ])
  assert.equal(state.currentDecision.decisionId, 'decision-plan')
  assert.equal(state.currentDecision.kind, 'plan_review')
  assert.equal(state.currentDecision.responseMode, 'plan_review')
  assert.equal('expiresAt' in state.currentDecision, false)
  assert.deepEqual(
    extractClaudePlanSnapshot(fixtureLines('claude-plan'), 'decision-plan'),
    {
      kind: 'plan_review',
      title: 'Gateway implementation',
      markdown: '# Gateway implementation\n\n## Goal\nConnect selected UCLI sessions.\n\n## Steps\n1. Add contracts.\n2. Add the Feishu channel.\n\nFiles: `electron/gateway/runtime.js`',
      provider: 'claude',
      nativeSessionId: 'claude-native-plan',
      capturedAt: Date.parse('2026-07-30T01:00:02.000Z')
    }
  )
})

test('Claude question decisions distinguish single, multi, and free-text responses', async () => {
  const { parseClaudeGatewayState } = await parser()
  const singleLines = fixtureLines('claude-question')
  const single = parseClaudeGatewayState(singleLines).currentDecision
  assert.equal(single.responseMode, 'single')
  assert.deepEqual(single.options.map((option) => option.id), ['q0:o0', 'q0:o1'])

  const multiRecord = JSON.parse(singleLines[2])
  multiRecord.message.content[0].input.questions[0].multiSelect = true
  const multi = parseClaudeGatewayState([
    singleLines[0],
    singleLines[1],
    JSON.stringify(multiRecord)
  ]).currentDecision
  assert.equal(multi.responseMode, 'multi')

  const freeRecord = structuredClone(multiRecord)
  freeRecord.message.content[0].input.questions[0].multiSelect = false
  freeRecord.message.content[0].input.questions[0].options = []
  const free = parseClaudeGatewayState([
    singleLines[0],
    singleLines[1],
    JSON.stringify(freeRecord)
  ]).currentDecision
  assert.equal(free.responseMode, 'free_text')
})

test('Claude parser emits completion only from an explicit end-turn record', async () => {
  const { extractClaudeResultSnapshot, parseClaudeGatewayState } = await parser()
  const lines = fixtureLines('claude-result')
  const state = parseClaudeGatewayState(lines)

  assert.equal(state.actualModel, 'claude-sonnet')

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'turn_completed'
  ])
  assert.deepEqual(extractClaudeResultSnapshot(lines, 'turn-result'), {
    kind: 'result',
    title: 'Claude result',
    markdown: 'Gateway 契约已经完成。\n\n测试全部通过。',
    provider: 'claude',
    nativeSessionId: 'claude-native-result',
    turnId: 'turn-result',
    capturedAt: Date.parse('2026-07-30T03:00:02.000Z')
  })
})

test('Claude parser does not infer snapshots from malformed or incomplete records', async () => {
  const {
    extractClaudePlanSnapshot,
    extractClaudeResultSnapshot,
    parseClaudeGatewayState
  } = await parser()

  assert.equal(extractClaudePlanSnapshot(['not-json'], 'decision-plan'), null)
  assert.equal(extractClaudeResultSnapshot(['{"type":"assistant"'], 'turn-result'), null)
  assert.deepEqual(parseClaudeGatewayState(['not-json']).events, [])
})

test('Claude parser cursor prevents duplicate lifecycle publication', async () => {
  const { parseClaudeGatewayState } = await parser()
  const lines = fixtureLines('claude-result')
  const first = parseClaudeGatewayState(lines)
  const second = parseClaudeGatewayState(lines, first.cursor)

  assert.equal(first.cursor, lines.length)
  assert.deepEqual(second.events, [])
  assert.equal(second.cursor, lines.length)
})

test('Claude parser maps explicit interrupted and failed results without terminal heuristics', async () => {
  const { parseClaudeGatewayState } = await parser()
  const prefix = fixtureLines('claude-result').slice(0, 2)
  const interrupted = parseClaudeGatewayState([
    ...prefix,
    JSON.stringify({
      type: 'result',
      subtype: 'interrupted',
      is_error: true,
      timestamp: '2026-07-30T03:00:02.000Z'
    })
  ])
  const failed = parseClaudeGatewayState([
    ...prefix,
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      timestamp: '2026-07-30T03:00:02.000Z'
    })
  ])

  assert.deepEqual(interrupted.events.map((event) => event.type), [
    'turn_started',
    'turn_interrupted'
  ])
  assert.deepEqual(failed.events.map((event) => event.type), [
    'turn_started',
    'turn_failed'
  ])
})

test('Claude decision encoder owns provider-native question and plan keystrokes', async () => {
  const { encodeClaudeDecisionResponse } = await parser()
  const question = (await parser()).parseClaudeGatewayState(
    fixtureLines('claude-question')
  ).currentDecision
  const plan = (await parser()).parseClaudeGatewayState(
    fixtureLines('claude-plan')
  ).currentDecision

  assert.deepEqual(
    encodeClaudeDecisionResponse(question, { optionId: 'q0:o1' }),
    ['\x1b[B', '\r']
  )
  assert.deepEqual(
    encodeClaudeDecisionResponse(
      { ...question, responseMode: 'free_text', options: [] },
      { text: '使用灰度环境' }
    ),
    ['使用灰度环境\r']
  )
  assert.deepEqual(
    encodeClaudeDecisionResponse(plan, { action: 'execute' }),
    ['\r']
  )
  assert.deepEqual(
    encodeClaudeDecisionResponse(plan, { action: 'reject' }),
    ['\x1b']
  )
  assert.deepEqual(
    encodeClaudeDecisionResponse(plan, { action: 'revise', text: '先补充回滚步骤' }),
    ['\x1b', '先补充回滚步骤\r']
  )
})

test('Claude adapter verifies the current decision before writing native input', async () => {
  const adapter = new ClaudeAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  const writes = []
  adapter._gatewayDecision = (await parser()).parseClaudeGatewayState(
    fixtureLines('claude-plan')
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
    await adapter.respondDecision('stale-decision', { action: 'execute' }),
    { accepted: false, reason: 'already_resolved' }
  )
  assert.deepEqual(
    await adapter.respondDecision('decision-plan', { action: 'execute' }),
    { accepted: true }
  )
  assert.deepEqual(writes, ['\r'])
  await adapter.dispose()
})

test('Claude hook passes user-decision tools through to the native prompt', () => {
  const runner = fileURLToPath(new URL('../resources/claudeHook.runner.mjs', import.meta.url))
  for (const toolName of ['AskUserQuestion', 'ExitPlanMode']) {
    const child = spawnSync(process.execPath, [runner], {
      input: JSON.stringify({
        tool_name: toolName,
        tool_input: { plan: '# Plan' }
      }),
      encoding: 'utf8',
      timeout: 1000,
      env: {
        ...process.env,
        UCLI_HOOK_PORT: '',
        UCLI_SESSION_ID: ''
      }
    })

    assert.equal(child.status, 0)
    assert.equal(child.stdout, '{}')
  }
})

test('Claude parser reports the latest valid init model after resume', async () => {
  const { parseClaudeGatewayState } = await parser()
  const state = parseClaudeGatewayState([
    { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-old' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'before resume' }] } },
    { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-new' }
  ])

  assert.equal(state.actualModel, 'claude-new')
})
