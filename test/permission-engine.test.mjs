import assert from 'node:assert/strict'
import test from 'node:test'

import { TIER } from '../electron/adapters/cliAdapter.js'
import { PermissionEngine } from '../electron/permission/engine.js'

function createEngine({ tier = TIER.SAFETY_RULES, ruleset = {}, onResolved = () => {} } = {}) {
  const requests = []
  const decisions = []
  const engine = new PermissionEngine({
    onApprovalRequest: (request) => requests.push(request),
    onApprovalResolved: onResolved,
    onDecision: (decision) => decisions.push(decision)
  })
  engine.setSession('s1', { tier, rulesetId: 'test', ruleset })
  return { engine, requests, decisions }
}

test('a requested permission stays pending until an explicit response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const resolved = []
  const { engine, requests } = createEngine({
    tier: TIER.ASK_EVERYTHING,
    onResolved: (request) => resolved.push(request)
  })

  const decision = engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'npm test' }
  })

  await Promise.resolve()
  assert.equal(requests.length, 1)
  t.mock.timers.tick(10 * 60 * 1000)

  assert.equal(engine.pendingCount(), 1)
  assert.deepEqual(resolved, [])
  assert.equal(engine.respondApproval(requests[0].requestId, 'allow'), true)
  assert.equal((await decision).verdict, 'allow')
})

test('the hard blacklist denies in every permission tier', async () => {
  for (const tier of [TIER.ALWAYS_AGREE, TIER.SAFETY_RULES, TIER.ASK_EVERYTHING]) {
    const { engine, requests } = createEngine({ tier })
    const result = await engine.decide('s1', {
      tool: 'Bash',
      input: { command: 'rm -rf /' }
    })

    assert.equal(result.verdict, 'deny')
    assert.equal(result.classification, 'blacklist')
    assert.equal(requests.length, 0)
  }
})

test('always-agree allows a non-blacklisted operation', async () => {
  const { engine, requests } = createEngine({
    tier: TIER.ALWAYS_AGREE,
    ruleset: { deny: ['Bash(blocked:*)'] }
  })

  const result = await engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'blocked operation' }
  })

  assert.equal(result.verdict, 'allow')
  assert.equal(result.classification, 'deny')
  assert.equal(requests.length, 0)
})

test('ask-everything waits for an explicit response', async () => {
  const { engine, requests } = createEngine({ tier: TIER.ASK_EVERYTHING })
  const decision = engine.decide('s1', {
    tool: 'Read',
    input: { file_path: 'README.md' }
  })

  await Promise.resolve()
  assert.equal(engine.pendingCount(), 1)
  assert.equal(requests.length, 1)
  assert.equal(engine.respondApproval(requests[0].requestId, 'deny'), true)

  const result = await decision
  assert.equal(result.verdict, 'deny')
  assert.equal(result.asked, true)
})

test('safety-rules denies deny matches without asking', async () => {
  const { engine, requests } = createEngine({
    ruleset: { deny: ['Bash(blocked:*)'] }
  })

  const result = await engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'blocked operation' }
  })

  assert.equal(result.verdict, 'deny')
  assert.equal(result.classification, 'deny')
  assert.equal(requests.length, 0)
})

test('safety-rules asks for high-risk matches', async () => {
  const { engine, requests } = createEngine({
    ruleset: { highRisk: ['Bash(risky:*)'] }
  })
  const decision = engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'risky operation' }
  })

  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].classification, 'high-risk')
  assert.equal(engine.respondApproval(requests[0].requestId, 'allow'), true)
  assert.equal((await decision).verdict, 'allow')
})

test('safety-rules allows allow matches and unmatched defaults', async () => {
  const { engine, requests } = createEngine({
    ruleset: { allow: ['Bash(safe:*)'] }
  })

  const allowed = await engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'safe operation' }
  })
  const unmatched = await engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'ordinary operation' }
  })

  assert.equal(allowed.verdict, 'allow')
  assert.equal(allowed.classification, 'allow')
  assert.equal(unmatched.verdict, 'allow')
  assert.equal(unmatched.classification, 'default')
  assert.equal(requests.length, 0)
})

test('an approval response is accepted only once', async () => {
  const resolved = []
  const { engine, requests } = createEngine({
    tier: TIER.ASK_EVERYTHING,
    onResolved: (request) => resolved.push(request)
  })
  const decision = engine.decide('s1', {
    tool: 'Bash',
    input: { command: 'npm test' }
  })

  await Promise.resolve()
  const requestId = requests[0].requestId
  assert.equal(engine.respondApproval(requestId, 'allow'), true)
  assert.equal(engine.respondApproval(requestId, 'deny'), false)
  assert.equal((await decision).verdict, 'allow')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].verdict, 'allow')
})
