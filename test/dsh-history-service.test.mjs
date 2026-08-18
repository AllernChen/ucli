import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionHistoryService } from '../electron/sessionHistoryService.js'
import { parseDshHistory } from '../electron/sessionHistory.js'

test('DSH history loads via injected exporter', async () => {
  const service = createSessionHistoryService({
    resolveSession: () => ({ id: 'u1', adapterId: 'deepseek-harness', cwd: 'C:/proj' }),
    exportDshHistory: async (session, range) => {
      assert.equal(session.id, 'u1')
      assert.deepEqual(range, { start: 1000000, endExclusive: 2000000 })
      return {
        items: parseDshHistory([
          JSON.stringify({ seq: 1, type: 'user/message', time: 1500, data: { content: [{ type: 'text', text: 'x' }] } })
        ]),
        sourceKind: 'export',
        sourceTruncated: false
      }
    }
  })
  const page = await service.loadRange({ sessionId: 'u1', start: 1000000, endExclusive: 2000000 })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].role, 'user')
})

test('DSH history degrades when exporter returns null', async () => {
  const service = createSessionHistoryService({
    resolveSession: () => ({ id: 'u1', adapterId: 'deepseek-harness', cwd: 'C:/proj' }),
    exportDshHistory: async () => null
  })
  const page = await service.loadRange({ sessionId: 'u1', start: 1, endExclusive: 2 })
  assert.equal(page.missing, true)
})
