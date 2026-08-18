import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshStatsPoller } from '../electron/adapters/dshStatsPoller.js'

test('poller aggregates tokens for active DSH web sessions and skips inactive ones', async () => {
  const aggregated = []
  const called = []
  const poller = createDshStatsPoller({
    entries: () => new Map([
      ['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }],
      ['s2', { session: { adapterId: 'deepseek-harness' }, surfaceState: null }],
      ['s3', { session: { adapterId: 'claude' }, surfaceState: { url: 'http://127.0.0.1:43128' } }]
    ]),
    dshClient: { aggregateTokenUsage: async (url) => { aggregated.push(url); return { input: 10, output: 4 } } },
    onStats: async (sessionId, tokens) => { called.push([sessionId, tokens]) }
  })
  await poller.tick()
  assert.deepEqual(aggregated, ['http://127.0.0.1:43127'])
  assert.deepEqual(called, [['s1', { input: 10, output: 4 }]])
})

test('poller swallows client failures and keeps the session untouched', async () => {
  let called = 0
  const poller = createDshStatsPoller({
    entries: () => new Map([['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }]]),
    dshClient: { aggregateTokenUsage: async () => { throw new Error('boom') } },
    onStats: async () => { called += 1 }
  })
  await poller.tick() // must not throw
  assert.equal(called, 0)
})

test('poller skips sessions whose client returns null', async () => {
  let called = 0
  const poller = createDshStatsPoller({
    entries: () => new Map([['s1', { session: { adapterId: 'deepseek-harness' }, surfaceState: { url: 'http://127.0.0.1:43127' } }]]),
    dshClient: { aggregateTokenUsage: async () => null },
    onStats: async () => { called += 1 }
  })
  await poller.tick()
  assert.equal(called, 0)
})
