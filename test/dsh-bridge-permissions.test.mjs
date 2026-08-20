import assert from 'node:assert/strict'
import test from 'node:test'

import { TIER } from '../electron/adapters/cliAdapter.js'
import {
  PermissionEngine,
  dshPermissionPolicyForTier
} from '../electron/permission/engine.js'

function createEngine({ tier, ruleset = {}, onApprovalResolved = () => {} } = {}) {
  const approvals = []
  const engine = new PermissionEngine({
    onApprovalRequest: (request) => approvals.push(request),
    onApprovalResolved,
    onDecision() {}
  })
  if (tier) engine.setSession('session-1', { tier, rulesetId: 'rules', ruleset })
  return { engine, approvals }
}

test('every DSH tier keeps workspace-write and routes native approval to the bridge deny answerer', () => {
  for (const tier of [TIER.ASK_EVERYTHING, TIER.SAFETY_RULES, TIER.ALWAYS_AGREE]) {
    assert.deepEqual(dshPermissionPolicyForTier(tier), {
      sandboxPreset: 'workspace-write',
      nativeApproval: 'bridge-deny'
    })
  }
  assert.throws(() => dshPermissionPolicyForTier('missing'), /Unknown permission tier/)
})

test('a missing or malformed DSH session policy denies instead of inheriting defaults', async () => {
  const { engine, approvals } = createEngine()
  const missing = await engine.decide('missing-session', {
    tool: 'bash', input: { command: 'npm test' }
  })
  assert.deepEqual(missing, {
    verdict: 'deny', classification: 'unavailable', reason: '权限会话不可用'
  })

  engine.setSession('bad-tier', { tier: 'unknown', rulesetId: 'rules', ruleset: {} })
  engine.setSession('bad-rules', { tier: TIER.SAFETY_RULES, rulesetId: 'absent' })
  for (const sessionId of ['bad-tier', 'bad-rules']) {
    const result = await engine.decide(sessionId, { tool: 'bash', input: { command: 'npm test' } })
    assert.equal(result.verdict, 'deny')
    assert.equal(result.classification, 'unavailable')
  }
  assert.deepEqual(approvals, [])
})

test('hard blacklist wins for shell, PowerShell, relative paths, and Code Mode nested leaves', async () => {
  const { engine, approvals } = createEngine({ tier: TIER.ALWAYS_AGREE })
  const calls = [
    { tool: 'bash', input: { command: 'rm -rf /' } },
    { tool: 'powershell', input: { command: 'Remove-Item -Recurse -Force C:\\' } },
    { tool: 'write_file', input: { path: '../.ssh/authorized_keys' }, cwd: 'C:\\Users\\alice\\workspace' },
    {
      tool: 'write_file', input: { path: '..\\System32\\drivers\\etc\\hosts' }, cwd: 'C:\\Windows\\Temp',
      bridgeContext: { rootCallId: 'run-code', nested: true, subagent: true }
    }
  ]
  for (const call of calls) {
    const result = await engine.decide('session-1', call)
    assert.equal(result.verdict, 'deny', JSON.stringify(call))
    assert.equal(result.classification, 'blacklist', JSON.stringify(call))
  }
  assert.equal(approvals.length, 0)
})

test('a downstream DSH ask forces exactly one UCLI prompt', async () => {
  const { engine, approvals } = createEngine({ tier: TIER.ALWAYS_AGREE })
  const pending = engine.decide('session-1', {
    tool: 'read_file', input: { path: 'README.md' }, approvalRequired: true
  })
  await Promise.resolve()
  assert.equal(approvals.length, 1)
  assert.equal(engine.pendingCount(), 1)
  assert.equal(engine.respondApproval('session-1', approvals[0].requestId, 'allow'), true)
  assert.equal((await pending).verdict, 'allow')
  assert.equal(approvals.length, 1)
})

test('removing a DSH session cancels its pending UCLI prompt fail-closed', async () => {
  const resolved = []
  const { engine, approvals } = createEngine({
    tier: TIER.ASK_EVERYTHING,
    onApprovalResolved: (request) => resolved.push(request)
  })
  const pending = engine.decide('session-1', {
    tool: 'bash', input: { command: 'npm test' }
  })
  await Promise.resolve()
  assert.equal(approvals.length, 1)
  assert.equal(engine.pendingCount(), 1)

  engine.removeSession('session-1')
  assert.deepEqual(await pending, {
    verdict: 'deny', classification: 'default', reason: '权限会话已取消', asked: true
  })
  assert.equal(engine.pendingCount(), 0)
  assert.equal(engine.respondApproval('session-1', approvals[0].requestId, 'allow'), false)
  assert.deepEqual(resolved, [{ ...approvals[0], verdict: 'deny' }])
})

test('approval responses validate verdict and session ownership before settling', async () => {
  const { engine, approvals } = createEngine({ tier: TIER.ASK_EVERYTHING })
  const pending = engine.decide('session-1', { tool: 'bash', input: { command: 'npm test' } })
  await Promise.resolve()
  const requestId = approvals[0].requestId
  assert.equal(engine.respondApproval('other-session', requestId, 'allow'), false)
  assert.equal(engine.respondApproval('session-1', requestId, 'maybe'), false)
  assert.equal(engine.pendingCount(), 1)
  assert.equal(engine.respondApproval('session-1', requestId, 'deny'), true)
  assert.equal((await pending).verdict, 'deny')
})

test('an aborted reverse bridge request cancels the pending engine prompt', async () => {
  const { engine, approvals } = createEngine({ tier: TIER.ASK_EVERYTHING })
  const controller = new AbortController()
  const pending = engine.decide('session-1', {
    tool: 'bash', input: { command: 'npm test' }, signal: controller.signal
  })
  await Promise.resolve()
  assert.equal(approvals.length, 1)
  controller.abort()
  assert.equal((await pending).verdict, 'deny')
  assert.equal(engine.pendingCount(), 0)
  assert.equal(engine.respondApproval('session-1', approvals[0].requestId, 'allow'), false)
})
