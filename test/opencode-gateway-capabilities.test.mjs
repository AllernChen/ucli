import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { OpenCodeAdapter } from '../electron/adapters/openCodeAdapter.js'

async function parser() {
  return import('../electron/adapters/openCodeGatewayParser.js')
}

function fixture(name) {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/gateway/${name}.json`, import.meta.url),
    'utf8'
  ))
}

test('OpenCode plan-agent completion becomes a plan review', async () => {
  const { extractOpenCodePlanSnapshot, parseOpenCodeGatewayState } = await parser()
  const source = fixture('opencode-plan-export')
  const state = parseOpenCodeGatewayState(source)

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'decision_required'
  ])
  assert.equal(state.currentDecision.kind, 'plan_review')
  assert.deepEqual(extractOpenCodePlanSnapshot(source, state.currentDecision.decisionId), {
    kind: 'plan_review',
    title: 'OpenCode Gateway',
    markdown: '# OpenCode Gateway\n\n## Goal\nConnect OpenCode decisions.\n\n## Steps\n1. Parse export.\n2. Route replies.',
    provider: 'opencode',
    nativeSessionId: 'opencode-native-plan',
    capturedAt: 1785384003000
  })
})

test('OpenCode explicit stop produces completion and a scoped result snapshot', async () => {
  const { extractOpenCodeResultSnapshot, parseOpenCodeGatewayState } = await parser()
  const source = fixture('opencode-result-export')
  const state = parseOpenCodeGatewayState(source)

  assert.deepEqual(state.events.map((event) => event.type), [
    'turn_started',
    'turn_completed'
  ])
  assert.deepEqual(extractOpenCodeResultSnapshot(source, 'opencode-turn-result'), {
    kind: 'result',
    title: 'OpenCode result',
    markdown: 'OpenCode Gateway 已完成。\n\n所有测试通过。',
    provider: 'opencode',
    nativeSessionId: 'opencode-native-result',
    turnId: 'opencode-turn-result',
    capturedAt: 1785385003000
  })
})

test('OpenCode AssistantMessage error union emits failed and interrupted lifecycle events', async () => {
  const { parseOpenCodeGatewayState } = await parser()
  const source = fixture('opencode-result-export')
  const terminal = error => parseOpenCodeGatewayState({
    ...source,
    messages: [
      source.messages[0],
      {
        ...source.messages[1],
        info: {
          ...source.messages[1].info,
          finish: 'stop',
          error,
          time: { ...source.messages[1].info.time, completed: 1785385003000 }
        }
      }
    ]
  }).events.map(event => event.type)

  assert.deepEqual(terminal({
    name: 'ProviderAuthError',
    data: { message: 'private provider detail' }
  }), ['turn_started', 'turn_failed'])
  assert.deepEqual(terminal({
    name: 'MessageAbortedError',
    data: { message: 'cancelled by operator' }
  }), ['turn_started', 'turn_interrupted'])
})

test('OpenCode pending question and permission tool states become decisions', async () => {
  const { parseOpenCodeGatewayState } = await parser()
  const source = fixture('opencode-result-export')
  source.messages[1] = {
    info: {
      role: 'assistant',
      id: 'opencode-pending',
      sessionID: source.info.id,
      agent: 'build',
      finish: 'tool-calls',
      time: { created: 1785385002000 }
    },
    parts: [{
      id: 'opencode-question',
      type: 'tool',
      tool: 'question',
      state: {
        status: 'running',
        input: {
          questions: [{
            header: '环境',
            question: '部署到哪个环境？',
            options: [{ label: '测试环境' }, { label: '生产环境' }]
          }]
        }
      }
    }]
  }
  const question = parseOpenCodeGatewayState(source).currentDecision
  assert.equal(question.kind, 'question')
  assert.deepEqual(question.options.map((option) => option.id), ['q0:o0', 'q0:o1'])

  source.messages[1].parts[0] = {
    id: 'opencode-permission',
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'pending',
      permissionID: 'permission-1',
      input: { command: 'npm test' }
    }
  }
  const permission = parseOpenCodeGatewayState(source).currentDecision
  assert.equal(permission.kind, 'permission')
  assert.equal(permission.decisionId, 'permission-1')
  assert.match(permission.summary, /npm test/)
})

test('OpenCode cursor deduplicates an unchanged export and malformed exports stay safe', async () => {
  const {
    extractOpenCodePlanSnapshot,
    extractOpenCodeResultSnapshot,
    parseOpenCodeGatewayState
  } = await parser()
  const source = fixture('opencode-result-export')
  const first = parseOpenCodeGatewayState(source)

  assert.deepEqual(parseOpenCodeGatewayState(source, first.cursor).events, [])
  assert.deepEqual(parseOpenCodeGatewayState({ messages: 'invalid' }).events, [])
  assert.equal(extractOpenCodePlanSnapshot({}, 'missing'), null)
  assert.equal(extractOpenCodeResultSnapshot({}, 'missing'), null)
})

test('OpenCode adapter verifies current decisions and uses provider-native plan transition', async () => {
  const source = fixture('opencode-plan-export')
  const adapter = new OpenCodeAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli', cliSessionId: source.info.id },
    engine: null,
    settings: {
      gatewayReader: async () => source
    }
  })
  const writes = []
  adapter._gatewayDecision = (await parser()).parseOpenCodeGatewayState(source).currentDecision
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
  assert.deepEqual(writes, ['\t', 'Implement the approved plan.\r'])
  await adapter.dispose()
})

test('OpenCode sendTurn returns the PTY write acceptance result', async () => {
  const adapter = new OpenCodeAdapter({
    session: { id: 'session-1', cwd: 'F:\\projects\\ucli' },
    engine: null,
    settings: {}
  })
  adapter.writeInput = value => value === 'accepted\r'

  assert.equal(await adapter.sendTurn('accepted'), true)
  assert.equal(await adapter.sendTurn('rejected'), false)
  await adapter.dispose()
})
