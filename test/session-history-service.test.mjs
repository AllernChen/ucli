import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createSessionHistoryService } from '../electron/sessionHistoryService.js'

const claudeTranscript = readFileSync(
  new URL('./fixtures/history/claude.jsonl', import.meta.url),
  'utf8'
)
const codexTranscript = readFileSync(
  new URL('./fixtures/history/codex.jsonl', import.meta.url),
  'utf8'
)
const openCodeExport = JSON.parse(readFileSync(
  new URL('./fixtures/opencode/session-export.json', import.meta.url),
  'utf8'
))

test('history service resolves Claude source from stored session data and paginates it', async () => {
  const storedPath = 'C:\\Users\\Ada\\.claude\\projects\\ucli\\native-1.jsonl'
  const readCalls = []
  const service = createSessionHistoryService({
    resolveSession: (id) => id === 'ucli-session-1'
      ? { id, adapterId: 'claude', cwd: 'F:\\projects\\ucli', cliSessionId: 'native-1' }
      : null,
    resolveClaudeTranscript: (session) => {
      assert.equal(session.cliSessionId, 'native-1')
      return storedPath
    },
    readFile: (path, encoding) => {
      readCalls.push({ path, encoding })
      return claudeTranscript
    },
    exportOpenCode: async () => null
  })

  const page = await service.getPage('ucli-session-1', { before: null, limit: 2 })

  assert.equal(page.source, 'claude')
  assert.deepEqual(page.items.map((item) => item.role), ['assistant', 'tool'])
  assert.deepEqual(readCalls, [{ path: storedPath, encoding: 'utf8' }])
  assert.equal(page.complete, false)
})

test('history service loads Codex and OpenCode without accepting renderer paths or executables', async () => {
  const sessions = new Map([
    ['ucli-codex', {
      id: 'ucli-codex',
      adapterId: 'codex',
      cwd: 'F:\\projects\\ucli',
      cliSessionId: 'codex-native'
    }],
    ['ucli-opencode', {
      id: 'ucli-opencode',
      adapterId: 'opencode',
      cwd: 'F:\\projects\\ucli',
      cliSessionId: 'ses_fixture'
    }]
  ])
  const exportCalls = []
  const service = createSessionHistoryService({
    resolveSession: (id) => sessions.get(id) || null,
    resolveClaudeTranscript: () => null,
    resolveCodexTranscript: (session) => {
      assert.equal(session.cliSessionId, 'codex-native')
      return 'stored-codex.jsonl'
    },
    readFile: (path) => {
      assert.equal(path, 'stored-codex.jsonl')
      return codexTranscript
    },
    exportOpenCode: async (sessionId) => {
      exportCalls.push(sessionId)
      return openCodeExport
    }
  })

  const codex = await service.getPage('ucli-codex', { limit: 100, path: 'C:\\secret.txt' })
  const openCode = await service.getPage('ucli-opencode', {
    limit: 100,
    executable: 'C:\\malicious.exe'
  })

  assert.equal(codex.source, 'codex')
  assert.equal(codex.items.filter((item) => item.role === 'user').length, 2)
  assert.equal(openCode.source, 'opencode')
  assert.equal(openCode.items.filter((item) => item.role === 'assistant').length, 2)
  assert.deepEqual(exportCalls, ['ses_fixture'])
  await assert.rejects(
    service.getPage('../arbitrary-file', { before: null, limit: 100 }),
    /session not found/
  )
})

test('history service caches parsed provider history for at most five seconds', async () => {
  let clock = 1000
  let reads = 0
  const service = createSessionHistoryService({
    resolveSession: () => ({
      id: 'ucli-session',
      adapterId: 'claude',
      cwd: 'F:\\projects\\ucli',
      cliSessionId: 'native-1'
    }),
    resolveClaudeTranscript: () => 'stored.jsonl',
    readFile: () => {
      reads += 1
      return claudeTranscript
    },
    exportOpenCode: async () => null,
    now: () => clock
  })

  const newest = await service.getPage('ucli-session', { limit: 2 })
  await service.getPage('ucli-session', { before: newest.nextBefore, limit: 2 })
  assert.equal(reads, 1)

  clock += 5001
  await service.getPage('ucli-session', { limit: 2 })
  assert.equal(reads, 2)
})

test('history service reports unavailable provider sources without exposing a path', async () => {
  const service = createSessionHistoryService({
    resolveSession: () => ({
      id: 'ucli-session',
      adapterId: 'claude',
      cwd: 'F:\\private\\project',
      cliSessionId: 'missing'
    }),
    resolveClaudeTranscript: () => null,
    readFile: () => {
      throw new Error('C:\\private\\project\\secret.jsonl')
    },
    exportOpenCode: async () => null
  })

  await assert.rejects(
    service.getPage('ucli-session'),
    (error) => error.message === 'history source unavailable'
  )
})
