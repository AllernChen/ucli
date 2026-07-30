import assert from 'node:assert/strict'
import test from 'node:test'

import { DecisionRegistry } from '../electron/gateway/decisionRegistry.js'

const DECISION = {
  decisionId: 'decision-1',
  kind: 'permission',
  title: 'Run command?',
  summary: 'npm test',
  options: [
    { id: 'allow_once', label: 'Allow once' },
    { id: 'deny', label: 'Deny' }
  ],
  responseMode: 'single'
}

test('decision resolution is first-writer-wins and audits only metadata', async () => {
  let release
  const calls = []
  const audits = []
  const registry = new DecisionRegistry({
    responder: async (sessionId, decisionId, response) => {
      calls.push({ sessionId, decisionId, response })
      await new Promise((resolve) => { release = resolve })
      return { accepted: true }
    },
    routeStore: { saveDecisionAudit: (record) => audits.push(record) }
  })
  registry.register(DECISION, 'session-1')
  const token = registry.issueActionToken('decision-1', 'allow_once')

  const winner = registry.resolve({
    decisionId: 'decision-1',
    response: { action: 'allow_once', actionToken: token },
    source: 'feishu'
  })
  const loser = await registry.resolve({
    decisionId: 'decision-1',
    response: { action: 'deny' },
    source: 'desktop'
  })
  assert.deepEqual(loser, { accepted: false, reason: 'already_resolved' })
  release()
  assert.deepEqual(await winner, { accepted: true })
  assert.equal(calls.length, 1)
  assert.equal(audits.length, 1)
  assert.deepEqual(
    Object.keys(audits[0]).sort(),
    ['decisionId', 'id', 'kind', 'resolvedAt', 'sessionId', 'source', 'verdict']
  )
  assert.equal(JSON.stringify(audits[0]).includes('npm test'), false)
})

test('remote action tokens are opaque, single-use, and bound to decision plus action', async () => {
  const registry = new DecisionRegistry({
    responder: async () => ({ accepted: true }),
    routeStore: { saveDecisionAudit: () => {} }
  })
  registry.register(DECISION, 'session-1')
  const token = registry.issueActionToken('decision-1', 'allow_once')
  assert.match(token, /^[A-Za-z0-9_-]{32,}$/)

  assert.deepEqual(await registry.resolve({
    decisionId: 'decision-1',
    response: { action: 'deny', actionToken: token },
    source: 'feishu'
  }), { accepted: false, reason: 'invalid_action_token' })

  assert.deepEqual(await registry.resolve({
    decisionId: 'decision-1',
    response: { action: 'allow_once', actionToken: token },
    source: 'feishu'
  }), { accepted: true })

  assert.deepEqual(await registry.resolve({
    decisionId: 'decision-1',
    response: { action: 'allow_once', actionToken: token },
    source: 'feishu'
  }), { accepted: false, reason: 'already_resolved' })
})

test('session cancellation and remote invalidation do not resolve other decisions', async () => {
  const registry = new DecisionRegistry({
    responder: async () => ({ accepted: true }),
    routeStore: { saveDecisionAudit: () => {} }
  })
  registry.register(DECISION, 'session-1')
  registry.register({ ...DECISION, decisionId: 'decision-2' }, 'session-2')
  const token = registry.issueActionToken('decision-2', 'deny')

  assert.equal(registry.cancelForSession('session-1', 'session_stopped'), 1)
  assert.deepEqual(registry.listPendingForSession('session-1'), [])
  assert.equal(registry.listPendingForSession('session-2').length, 1)

  registry.invalidateRemoteTokens('gateway_disabled')
  assert.deepEqual(await registry.resolve({
    decisionId: 'decision-2',
    response: { action: 'deny', actionToken: token },
    source: 'feishu'
  }), { accepted: false, reason: 'invalid_action_token' })
})

test('routed Feishu text is accepted only for explicit free-text decisions', async () => {
  const calls = []
  const registry = new DecisionRegistry({
    responder: async (_sessionId, _decisionId, response) => {
      calls.push(response)
      return { accepted: true }
    },
    routeStore: { saveDecisionAudit: () => {} }
  })
  registry.register({
    ...DECISION,
    decisionId: 'free-text',
    responseMode: 'free_text',
    options: []
  }, 'session-1')
  registry.register({
    ...DECISION,
    decisionId: 'button-only'
  }, 'session-1')

  assert.deepEqual(await registry.resolve({
    decisionId: 'free-text',
    response: { text: 'Use staging' },
    source: 'feishu'
  }), { accepted: true })
  assert.deepEqual(await registry.resolve({
    decisionId: 'button-only',
    response: { text: 'allow' },
    source: 'feishu'
  }), { accepted: false, reason: 'invalid_action_token' })
  assert.deepEqual(calls, [{ text: 'Use staging' }])
})
