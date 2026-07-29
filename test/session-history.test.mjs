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
