import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ClaudeAdapter,
  makeTurnFingerprint,
  userEntryText,
  transcriptHasUserTurn
} from '../electron/adapters/claudeAdapter.js'

const T0 = '2026-01-01T00:00:00.000Z' // 早于本轮
const T1 = '2026-06-01T00:00:00.000Z' // 晚于本轮
const SINCE = Date.parse('2026-03-01T00:00:00.000Z')

function makeFixture(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-turn-delivery-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, entries.map((line) => JSON.stringify(line)).join('\n'))
  return { dir, path }
}

test('Claude delivery binds the native session from a matching current TUI transcript filename', async () => {
  const nativeSessionId = '75b2eb81-2a47-4dc3-9803-6cf3f6a3993d'
  const dir = mkdtempSync(join(tmpdir(), 'ucli-turn-native-binding-'))
  const path = join(dir, `${nativeSessionId}.jsonl`)
  const prompt = 'Generate the bounded summary.'
  writeFileSync(path, JSON.stringify({
    type: 'user',
    timestamp: T1,
    message: { role: 'user', content: prompt }
  }))
  const session = { id: 'ucli-session', cwd: dir, cliSessionId: null }
  const adapter = new ClaudeAdapter({ session, engine: null, settings: {} })
  adapter._projectDir = () => dir
  const initEvents = []
  adapter.on('event', event => {
    if (event.type === 'init') initEvents.push(event.cliSessionId)
  })

  try {
    assert.equal(adapter._scanProjectTranscripts(makeTurnFingerprint(prompt), SINCE), true)
    assert.equal(session.cliSessionId, nativeSessionId)
    assert.deepEqual(initEvents, [nativeSessionId])
  } finally {
    await adapter.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makeTurnFingerprint collapses whitespace and truncates to 40 chars', () => {
  assert.equal(
    makeTurnFingerprint('  你 是  UCLI  的   报告提取器  \n 请读取 '),
    '你 是 UCLI 的 报告提取器 请读取'
  )
  assert.equal(makeTurnFingerprint('a'.repeat(80)).length, 40)
  assert.equal(makeTurnFingerprint(''), '')
  assert.equal(makeTurnFingerprint(null), '')
})

test('userEntryText extracts text from content-block, string, and message.content string forms', () => {
  assert.equal(userEntryText({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }), 'hello')
  assert.equal(userEntryText({ type: 'user', message: { content: 'hello' } }), 'hello')
  assert.equal(userEntryText({ type: 'user', content: 'hello' }), 'hello')
  assert.equal(userEntryText({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), '')
  assert.equal(userEntryText({ type: 'user' }), '')
})

test('transcriptHasUserTurn matches a user entry with the fingerprint after sinceMs', () => {
  const { dir, path } = makeFixture([
    { type: 'system', timestamp: T0, subtype: 'init' },
    { type: 'user', timestamp: T0, message: { content: [{ type: 'text', text: '旧的一轮 prompt' }] } },
    { type: 'user', timestamp: T1, message: { content: [{ type: 'text', text: '你是 UCLI 的报告提取器，请读取当前目录' }] } }
  ])
  try {
    const fp = makeTurnFingerprint('你是 UCLI 的报告提取器，请读取当前目录')
    assert.ok(transcriptHasUserTurn(path, fp, SINCE))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transcriptHasUserTurn ignores entries older than sinceMs and wrong content', () => {
  const { dir, path } = makeFixture([
    { type: 'user', timestamp: T0, message: { content: [{ type: 'text', text: '你是 UCLI 的报告提取器' }] } },
    { type: 'user', timestamp: T1, message: { content: [{ type: 'text', text: '完全不同的内容' }] } }
  ])
  try {
    const fp = makeTurnFingerprint('你是 UCLI 的报告提取器')
    assert.ok(!transcriptHasUserTurn(path, fp, SINCE), 'old entry matches but must be excluded by sinceMs')
    const wrongFp = makeTurnFingerprint('另一段 prompt')
    assert.ok(!transcriptHasUserTurn(path, wrongFp, 0), 'entry with different content must not match')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transcriptHasUserTurn tolerates malformed lines and missing fingerprint args', () => {
  const { dir, path } = makeFixture([
    'not json {',
    { type: 'user', timestamp: T1, message: { content: [{ type: 'text', text: '目标 prompt' }] } },
    { type: 'result', timestamp: T1, result: 'done' }
  ])
  try {
    assert.ok(transcriptHasUserTurn(path, makeTurnFingerprint('目标 prompt'), SINCE))
    assert.ok(!transcriptHasUserTurn(path, '', SINCE))
    assert.ok(!transcriptHasUserTurn(path, 'x', 0))
    assert.ok(!transcriptHasUserTurn(join(dir, 'missing.jsonl'), 'x', 0))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transcriptHasUserTurn matches multiline content against collapsed fingerprint', () => {
  const { dir, path } = makeFixture([
    {
      type: 'user',
      timestamp: T1,
      message: {
        content: [{ type: 'text', text: '你是 UCLI 的\n  报告提取器\n请读取当前目录下的 report.md' }]
      }
    }
  ])
  try {
    const fp = makeTurnFingerprint('你是 UCLI 的 报告提取器 请读取当前目录下的 report.md')
    assert.ok(transcriptHasUserTurn(path, fp, SINCE))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
