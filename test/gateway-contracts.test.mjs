import assert from 'node:assert/strict'
import test from 'node:test'

import { BaseAdapter, TIER } from '../electron/adapters/cliAdapter.js'
import { PermissionEngine } from '../electron/permission/engine.js'

async function loadContracts() {
  return import('../electron/gateway/contracts.js')
}

function validEvent(type) {
  const event = {
    type,
    sessionId: 'session-1',
    occurredAt: 1785370000000
  }
  if (type !== 'session_stopped') event.turnId = 'turn-1'
  if (type === 'decision_required') {
    event.decision = {
      decisionId: 'decision-1',
      kind: 'permission',
      title: '执行命令',
      summary: 'Bash: npm test',
      options: [
        { id: 'allow_once', label: '允许一次' },
        { id: 'deny', label: '拒绝' }
      ],
      responseMode: 'single'
    }
  }
  return event
}

test('gateway contracts accept only the six explicit lifecycle event types', async () => {
  const { GATEWAY_EVENT_TYPES, validateGatewayEvent } = await loadContracts()
  const expected = [
    'turn_started',
    'decision_required',
    'turn_completed',
    'turn_interrupted',
    'turn_failed',
    'session_stopped'
  ]

  assert.deepEqual([...GATEWAY_EVENT_TYPES], expected)
  for (const type of expected) {
    assert.equal(validateGatewayEvent(validEvent(type)).type, type)
  }
  for (const type of ['terminal', 'message', 'reasoning', 'tool_call', 'stats_update']) {
    assert.throws(
      () => validateGatewayEvent(validEvent(type)),
      (error) => error.code === 'INVALID_GATEWAY_EVENT'
    )
  }
})

test('gateway lifecycle events require stable identity and timing fields', async () => {
  const { validateGatewayEvent } = await loadContracts()

  assert.throws(
    () => validateGatewayEvent({ ...validEvent('turn_started'), sessionId: '' }),
    (error) => error.code === 'INVALID_GATEWAY_EVENT'
  )
  assert.throws(
    () => validateGatewayEvent({ ...validEvent('turn_completed'), turnId: '' }),
    (error) => error.code === 'INVALID_GATEWAY_EVENT'
  )
  assert.throws(
    () => validateGatewayEvent({ ...validEvent('turn_failed'), occurredAt: Number.NaN }),
    (error) => error.code === 'INVALID_GATEWAY_EVENT'
  )
  assert.equal(
    validateGatewayEvent(validEvent('session_stopped')).sessionId,
    'session-1'
  )
})

test('decision events require a complete supported decision shape without an expiry', async () => {
  const { validateGatewayEvent } = await loadContracts()
  const event = validateGatewayEvent(validEvent('decision_required'))

  assert.equal(event.decision.decisionId, 'decision-1')
  assert.equal('expiresAt' in event.decision, false)

  for (const missing of ['decisionId', 'kind', 'title', 'summary', 'options', 'responseMode']) {
    const invalid = validEvent('decision_required')
    delete invalid.decision[missing]
    assert.throws(
      () => validateGatewayEvent(invalid),
      (error) => error.code === 'INVALID_GATEWAY_DECISION'
    )
  }

  const invalidKind = validEvent('decision_required')
  invalidKind.decision.kind = 'unknown'
  assert.throws(
    () => validateGatewayEvent(invalidKind),
    (error) => error.code === 'INVALID_GATEWAY_DECISION'
  )
})

test('BaseAdapter exposes safe default gateway capabilities and emits a separate event', async () => {
  const engine = new PermissionEngine({
    onApprovalRequest: () => {},
    onApprovalResolved: () => {},
    onDecision: () => {}
  })
  const adapter = new BaseAdapter({
    id: 'test',
    displayName: 'Test',
    session: { id: 'session-1' },
    engine
  })
  const seen = []
  adapter.on('gateway-event', (event) => seen.push(event))

  assert.deepEqual(adapter.gatewayCapabilities, {
    decisions: false,
    planSnapshot: false,
    resultSnapshot: false
  })
  assert.equal(adapter.getDecisionContext(), null)
  assert.equal(adapter.getLatestPlanSnapshot('decision-1'), null)
  assert.equal(adapter.getLatestResultSnapshot('turn-1'), null)

  adapter.emitGatewayEvent({
    type: 'session_stopped',
    occurredAt: 1785370000000
  })
  assert.deepEqual(seen, [{
    type: 'session_stopped',
    sessionId: 'session-1',
    occurredAt: 1785370000000
  }])
})

test('BaseAdapter resolves a current permission decision but rejects an unknown decision', async () => {
  const requests = []
  const engine = new PermissionEngine({
    onApprovalRequest: (request) => requests.push(request),
    onApprovalResolved: () => {},
    onDecision: () => {}
  })
  engine.setSession('session-1', {
    tier: TIER.ASK_EVERYTHING,
    rulesetId: 'test',
    ruleset: {}
  })
  const adapter = new BaseAdapter({
    id: 'test',
    displayName: 'Test',
    session: { id: 'session-1' },
    engine
  })
  const pending = engine.decide('session-1', {
    tool: 'Bash',
    input: { command: 'npm test' }
  })

  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.deepEqual(
    await adapter.respondDecision(requests[0].requestId, { action: 'allow_once' }),
    { accepted: true }
  )
  assert.equal((await pending).verdict, 'allow')
  assert.deepEqual(
    await adapter.respondDecision('missing', { action: 'deny' }),
    { accepted: false, reason: 'unsupported' }
  )
})
