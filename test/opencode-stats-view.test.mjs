import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

global.window = { ucli: {} }
const { useStatsStore } = await import('../src/stores/stats.js')

test('statistics totals keep unavailable OpenCode cost out of the known total', () => {
  setActivePinia(createPinia())
  const stats = useStatsStore()
  stats.perSession = {
    known: {
      tokens: { input: 10, output: 2 }, costUsd: 0, costAvailable: true,
      turns: 1, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 }
    },
    unavailable: {
      tokens: { input: 20, output: 3 }, costUsd: null, costAvailable: false,
      turns: 1, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 }
    }
  }

  stats._recomputeTotal()

  assert.equal(stats.total.costUsd, 0)
  assert.equal(stats.total.costUnavailableCount, 1)
})
