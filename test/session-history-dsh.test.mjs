import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDshHistory } from '../electron/sessionHistory.js'

test('parseDshHistory maps user/assistant/tool events to normalized items', () => {
  const lines = [
    { seq: 1, type: 'user/message', time: 1000, data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { seq: 2, type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text: 'hi there' }] } } },
    { seq: 3, type: 'tool/result', time: 3000, data: { message: { content: [{ type: 'text', text: 'file written' }] } } },
    { seq: 4, type: 'request/header', time: 3000, data: {} }
  ]
  assert.deepEqual(parseDshHistory(lines.map(JSON.stringify)), [
    { id: '1', role: 'user', text: 'hello', timestamp: 1000000 },
    { id: '2', role: 'assistant', text: 'hi there', timestamp: 2000000 },
    { id: '3', role: 'tool', text: 'file written', timestamp: 3000000 }
  ])
})
