import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  historyPage,
  parseClaudeHistory,
  parseCodexHistory,
  parseOpenCodeHistory
} from '../electron/sessionHistory.js'

function fixtureLines(name) {
  return readFileSync(
    new URL(`./fixtures/history/${name}.jsonl`, import.meta.url),
    'utf8'
  ).split(/\r?\n/)
}

const openCodeFixture = JSON.parse(readFileSync(
  new URL('./fixtures/opencode/session-export.json', import.meta.url),
  'utf8'
))

test('all providers preserve complete user and assistant text turns', () => {
  const histories = [
    parseClaudeHistory(fixtureLines('claude')),
    parseCodexHistory(fixtureLines('codex')),
    parseOpenCodeHistory(openCodeFixture)
  ]

  for (const items of histories) {
    const conversation = items.filter((item) => item.role === 'user' || item.role === 'assistant')
    assert.deepEqual(conversation.map((item) => item.role), [
      'user', 'assistant', 'user', 'assistant'
    ])
    assert.ok(conversation.every((item) => item.text.length > 0))
    assert.ok(conversation.every((item) => typeof item.id === 'string' && item.id.length > 0))
  }
})

test('provider parsers expose tool summaries but omit reasoning and malformed objects', () => {
  const histories = [
    parseClaudeHistory(fixtureLines('claude')),
    parseCodexHistory(fixtureLines('codex')),
    parseOpenCodeHistory(openCodeFixture)
  ]

  for (const items of histories) {
    assert.ok(items.some((item) => item.role === 'tool'))
    assert.ok(items.every((item) => !item.text.includes('private reasoning')))
    assert.ok(items.every((item) => !item.text.includes('[redacted:reasoning]')))
    assert.ok(items.every((item) => !item.text.includes('[object Object]')))
  }
})

test('Codex history supports legacy root messages and removes adjacent dual-format duplicates', () => {
  const conversation = parseCodexHistory(fixtureLines('codex'))
    .filter((item) => item.role === 'user' || item.role === 'assistant')

  assert.deepEqual(conversation.map((item) => item.text), [
    'Codex first question',
    'Codex first answer',
    'Codex second question',
    'Codex second answer'
  ])
})

test('Codex history preserves adjacent identical canonical messages', () => {
  const conversation = parseCodexHistory([
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-29T02:00:01.000Z',
      payload: {
        type: 'message',
        id: 'codex-user-repeat-1',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-29T02:00:02.000Z',
      payload: {
        type: 'message',
        id: 'codex-user-repeat-2',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      }
    })
  ])

  assert.deepEqual(conversation.map((item) => item.id), [
    'codex-user-repeat-1:user',
    'codex-user-repeat-2:user'
  ])
})

test('Codex history only deduplicates a nearby event and canonical pair', () => {
  const canonicalThenLateEvent = parseCodexHistory([
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-29T02:00:01.000Z',
      payload: {
        type: 'message',
        id: 'canonical-1',
        role: 'user',
        content: [{ type: 'input_text', text: 'repeat later' }]
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T02:01:01.000Z',
      payload: { type: 'user_message', message: 'repeat later' }
    })
  ])
  const legacyThenEvent = parseCodexHistory([
    JSON.stringify({
      role: 'assistant',
      id: 'legacy-1',
      timestamp: '2026-07-29T02:00:01.000Z',
      content: 'same text'
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T02:00:01.100Z',
      payload: { type: 'agent_message', message: 'same text' }
    })
  ])

  assert.equal(canonicalThenLateEvent.length, 2)
  assert.equal(legacyThenEvent.length, 2)
})

test('normalized timestamps are milliseconds or null and remain chronological', () => {
  for (const items of [
    parseClaudeHistory(fixtureLines('claude')),
    parseCodexHistory(fixtureLines('codex')),
    parseOpenCodeHistory(openCodeFixture)
  ]) {
    assert.ok(items.every((item) => item.timestamp === null || Number.isFinite(item.timestamp)))
    const timestamps = items
      .map((item) => item.timestamp)
      .filter((timestamp) => timestamp !== null)
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b))
  }
})

test('history pages load newest items first and page backward without overlap', () => {
  const items = [
    { id: '1' },
    { id: '2' },
    { id: '3' },
    { id: '4' }
  ]

  const newest = historyPage(items, { before: null, limit: 2 })
  const older = historyPage(items, { before: newest.nextBefore, limit: 2 })

  assert.deepEqual(newest.items.map((item) => item.id), ['3', '4'])
  assert.deepEqual(older.items.map((item) => item.id), ['1', '2'])
  assert.deepEqual([...older.items, ...newest.items].map((item) => item.id), ['1', '2', '3', '4'])
  assert.equal(newest.complete, false)
  assert.equal(older.nextBefore, null)
  assert.equal(older.complete, true)
})

test('history pagination clamps unsafe limits and cursors', () => {
  const items = Array.from({ length: 250 }, (_, index) => ({ id: String(index) }))

  assert.equal(historyPage(items, { limit: 10_000 }).items.length, 200)
  assert.deepEqual(historyPage(items, { before: -10, limit: 20 }), {
    items: [],
    nextBefore: null,
    complete: true
  })
})
