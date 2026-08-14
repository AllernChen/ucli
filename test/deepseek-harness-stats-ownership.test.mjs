import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateOwnedModelStats,
  sessionUsesUcliStats
} from '../electron/usage/statsOwnership.js'

const TUI = {
  surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
  statsOwner: 'ucli', gateway: true, bridge: true
}
const WEB = {
  surface: 'web', permissionOwner: 'native', historyOwner: 'native',
  statsOwner: 'native', gateway: false, bridge: false
}

test('stats ownership accepts only authoritative UCLI-owned session capabilities', () => {
  assert.equal(sessionUsesUcliStats({ capabilities: TUI }), true)
  assert.equal(sessionUsesUcliStats({ capabilities: WEB }), false)
  assert.equal(sessionUsesUcliStats({}), false)
  assert.equal(sessionUsesUcliStats({ capabilities: undefined }), false)
  assert.equal(sessionUsesUcliStats({ capabilities: null }), false)
  assert.equal(sessionUsesUcliStats({ capabilities: { ...WEB, statsOwner: 'ucli' } }), false)
})

test('model aggregates omit native sessions instead of rendering zero-valued rows', () => {
  const rows = aggregateOwnedModelStats([
    { sessionId: 'tui', model: 'deepseek', inputTokens: 10, outputTokens: 4, costUsd: 0, costAvailable: false },
    { sessionId: 'web', model: 'deepseek', inputTokens: 900, outputTokens: 800, costUsd: 5, costAvailable: true },
    { sessionId: 'claude', model: 'sonnet', inputTokens: 20, outputTokens: 8, costUsd: 0.2, costAvailable: true }
  ], new Set(['tui', 'claude']))

  assert.deepEqual(rows, [
    {
      model: 'sonnet', input_tokens: 20, output_tokens: 8, cost_usd: 0.2,
      cost_unavailable_count: 0, session_count: 1
    },
    {
      model: 'deepseek', input_tokens: 10, output_tokens: 4, cost_usd: 0,
      cost_unavailable_count: 1, session_count: 1
    }
  ])
})
