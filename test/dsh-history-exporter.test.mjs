import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshHistoryExporter } from '../electron/adapters/dshHistoryExporter.js'

test('reuses a running web surface and only exports sessions last active at or after start', async () => {
  const exported = []
  const exporter = createDshHistoryExporter({
    getSessionUrl: () => 'http://127.0.0.1:43127',
    dshClient: {
      listSessions: async () => [
        { sessionId: 'a', updatedAt: 100 },
        { sessionId: 'b', updatedAt: 200 },
        { sessionId: 'c', updatedAt: 50 },
        { sessionId: 'd', updatedAt: 400 }
      ],
      exportSession: async (url, sessionId) => {
        assert.equal(url, 'http://127.0.0.1:43127')
        exported.push(sessionId)
        return `${sessionId}\n`
      }
    },
    parseHistory: (lines) => lines.filter(Boolean).map((line) => ({
      id: line, role: 'user', text: line, timestamp: 1
    }))
  })

  const result = await exporter(
    { id: 'u1', cwd: 'C:/proj' },
    { start: 100, endExclusive: 300 }
  )

  assert.equal(result.sourceKind, 'export')
  assert.equal(result.sourceTruncated, false)
  // `c` (updatedAt 50) ended before `start` and is excluded; `d` (updatedAt 400)
  // crosses `endExclusive` but stays included so loadRange can item-filter it.
  assert.deepEqual(result.items.map((item) => item.id), ['a', 'b', 'd'])
  assert.deepEqual(exported, ['a', 'b', 'd'])
})

test('launches a temporary web surface and stops it after exporting', async () => {
  let stopped = false
  const controller = {
    ready: Promise.resolve(),
    state: { url: 'http://127.0.0.1:43127' },
    stop: async () => { stopped = true }
  }
  let launched = null
  const exporter = createDshHistoryExporter({
    getSessionUrl: () => null,
    dshClient: {
      listSessions: async (url) => {
        assert.equal(url, 'http://127.0.0.1:43127')
        return [{ sessionId: 'a', updatedAt: 100 }]
      },
      exportSession: async () => '{"seq":1}\n'
    },
    selectLaunch: async () => ({ source: 'managed', launch: { file: 'node', prefixArgs: [] }, home: '/home' }),
    launchWeb: (runtime, cwd) => {
      launched = { runtime, cwd }
      return controller
    },
    parseHistory: (lines) => lines.filter(Boolean).map(() => ({ id: '1', role: 'user', text: 'x', timestamp: 1 }))
  })

  const result = await exporter({ id: 'u1', cwd: 'C:/proj' }, { start: 50, endExclusive: 200 })

  assert.equal(result.sourceKind, 'export')
  assert.equal(result.items.length, 1)
  assert.equal(stopped, true)
  assert.deepEqual(launched.runtime, { source: 'managed', launch: { file: 'node', prefixArgs: [] }, home: '/home' })
  assert.equal(launched.cwd, 'C:/proj')
})

test('stops the temporary web surface when readiness fails', async () => {
  let stopped = false
  const controller = {
    ready: Promise.reject(new Error('DSH_WEB_START_TIMEOUT')),
    state: { url: null },
    stop: async () => { stopped = true }
  }
  const exporter = createDshHistoryExporter({
    getSessionUrl: () => null,
    selectLaunch: async () => ({ source: 'managed', launch: { file: 'node', prefixArgs: [] }, home: '/home' }),
    launchWeb: () => controller,
    dshClient: { listSessions: async () => [], exportSession: async () => '' },
    parseHistory: () => []
  })

  const result = await exporter({ id: 'u1', cwd: 'C:/proj' }, { start: 0, endExclusive: 1 })

  assert.equal(result, null)
  assert.equal(stopped, true)
})

test('returns null when the temporary launch throws synchronously', async () => {
  const exporter = createDshHistoryExporter({
    getSessionUrl: () => null,
    selectLaunch: async () => ({ source: 'managed', launch: { file: 'node', prefixArgs: [] }, home: '/home' }),
    launchWeb: () => { throw new Error('DSH_VERSION_UNSUPPORTED') },
    dshClient: { listSessions: async () => [], exportSession: async () => '' },
    parseHistory: () => []
  })

  const result = await exporter({ id: 'u1', cwd: 'C:/proj' }, { start: 0, endExclusive: 1 })

  assert.equal(result, null)
})
