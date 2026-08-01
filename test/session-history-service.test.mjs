import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createSessionHistoryService,
  parseJsonLinesCooperatively
} from '../electron/sessionHistoryService.js'
import { parseCodexHistory } from '../electron/sessionHistory.js'

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

test('history service routes U-Code history through its own compatible exporter', async () => {
  const exportCalls = []
  const service = createSessionHistoryService({
    resolveSession: (id) => id === 'ucli-ucode'
      ? {
          id,
          adapterId: 'ucode',
          cwd: 'F:\\projects\\ucli',
          cliSessionId: 'ses_ucode'
        }
      : null,
    exportOpenCode: async (sessionId, adapterId) => {
      exportCalls.push({ sessionId, adapterId })
      return openCodeExport
    }
  })

  const page = await service.getPage('ucli-ucode', { limit: 100 })

  assert.equal(page.source, 'ucode')
  assert.equal(page.items.filter((item) => item.role === 'assistant').length, 2)
  assert.deepEqual(exportCalls, [{ sessionId: 'ses_ucode', adapterId: 'ucode' }])
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

test('history service rejects unsafe native session IDs before OpenCode export', async () => {
  let exports = 0
  const service = createSessionHistoryService({
    resolveSession: () => ({
      id: 'ucli-session',
      adapterId: 'opencode',
      cwd: 'F:\\projects\\ucli',
      cliSessionId: 'ses_safe & calc.exe'
    }),
    readFile: () => '',
    exportOpenCode: async () => {
      exports += 1
      return openCodeExport
    }
  })

  await assert.rejects(service.getPage('ucli-session'), /invalid native session id/)
  assert.equal(exports, 0)
})

test('history service evicts the least recently used session from a bounded cache', async () => {
  let reads = 0
  const service = createSessionHistoryService({
    resolveSession: (id) => ({
      id,
      adapterId: 'claude',
      cwd: 'F:\\projects\\ucli',
      cliSessionId: id
    }),
    resolveClaudeTranscript: (session) => `${session.id}.jsonl`,
    readFile: async () => {
      reads += 1
      return claudeTranscript
    },
    exportOpenCode: async () => null,
    cacheLimit: 2
  })

  await service.getPage('session-a')
  await service.getPage('session-b')
  await service.getPage('session-c')
  await service.getPage('session-a')

  assert.equal(reads, 4)
})

test('large transcript parsing yields to the event loop between bounded chunks', async () => {
  const records = Array.from({ length: 7 }, (_, index) => JSON.stringify({
    type: 'user',
    uuid: `message-${index}`,
    timestamp: `2026-07-29T02:00:0${index}.000Z`,
    message: {
      content: [{ type: 'text', text: `message ${index}` }]
    }
  })).join('\n')
  let yields = 0

  const items = await parseJsonLinesCooperatively(records, (lines) => lines, {
    chunkSize: 2,
    yieldControl: async () => {
      yields += 1
    }
  })

  assert.equal(items.length, 7)
  assert.ok(yields >= 3)
  assert.ok(items.every((item) => typeof item === 'object'))
})

test('large single-line transcripts are parsed off the main event loop', async () => {
  const content = JSON.stringify({
    type: 'user',
    uuid: 'large-message',
    timestamp: '2026-07-29T02:00:00.000Z',
    message: {
      content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }]
    }
  })
  let eventLoopTicks = 0
  const timer = setInterval(() => {
    eventLoopTicks += 1
  }, 0)

  try {
    const items = await parseJsonLinesCooperatively(content, (records) => records, {
      workerThresholdBytes: 1
    })
    assert.equal(items.length, 1)
    assert.ok(eventLoopTicks > 0)
  } finally {
    clearInterval(timer)
  }
})

test('cooperative normalization keeps Codex dual records in the same batch', async () => {
  const content = [
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-29T02:00:01.000Z',
      payload: {
        type: 'message',
        id: 'canonical-1',
        role: 'user',
        content: [{ type: 'input_text', text: 'one copy' }]
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T02:00:01.100Z',
      payload: { type: 'user_message', message: 'one copy' }
    })
  ].join('\n')

  const items = await parseJsonLinesCooperatively(content, parseCodexHistory, {
    chunkSize: 1,
    normalizeChunkSize: 1
  })

  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'one copy')
})

test('Codex dual records stay paired across ignored records and batch boundaries', async () => {
  const content = [
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-29T02:00:01.000Z',
      payload: { type: 'user_message', message: 'one copy' }
    }),
    JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-07-29T02:00:01.050Z',
      payload: { model: 'gpt-5' }
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-29T02:00:01.100Z',
      payload: {
        type: 'message',
        id: 'canonical-1',
        role: 'user',
        content: [{ type: 'input_text', text: 'one copy' }]
      }
    })
  ].join('\n')

  const items = await parseJsonLinesCooperatively(content, parseCodexHistory, {
    chunkSize: 1,
    normalizeChunkSize: 1
  })

  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'one copy')
})
