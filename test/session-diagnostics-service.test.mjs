import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionDiagnosticsService } from '../electron/sessionDiagnosticsService.js'

const CWD = 'F:\\projects\\ucli'
const ORIGINAL_ID = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
const MIDDLE_ID = '019fbd2e-0167-7b20-8b58-5b37606e7442'
const CURRENT_ID = '019fcac6-0c62-7da1-92ff-454e53dab197'

function writeRollout(codexHome, day, id, {
  forkedFromId = null,
  cwd = CWD,
  timestamp = `2026-08-${day}T03:16:44.963Z`,
  threadSource = null
} = {}) {
  const directory = join(codexHome, 'sessions', '2026', '08', day)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `rollout-${id}.jsonl`), `${JSON.stringify({
    type: 'session_meta',
    timestamp,
    payload: {
      id,
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
      ...(threadSource ? { thread_source: threadSource } : {}),
      timestamp,
      cwd
    }
  })}\n`)
}

function createHarness(codexHome, session = {}) {
  const entry = {
    session: {
      id: '86c7ff49-9090-4e79-bf3f-b6428cae75ff',
      adapterId: 'codex',
      cwd: CWD,
      cliSessionId: ORIGINAL_ID,
      ...session
    },
    status: 'idle'
  }
  const persisted = []
  const published = []
  const service = createSessionDiagnosticsService({
    resolveSession: (sessionId) => sessionId === entry.session.id ? entry : null,
    getCodexHome: () => codexHome,
    persistBinding: async (sessionId, nativeSessionId) => {
      persisted.push({ sessionId, nativeSessionId })
    },
    publishBinding: (sessionId, nativeSessionId) => {
      published.push({ sessionId, nativeSessionId })
    }
  })
  return { entry, persisted, published, service }
}

test('diagnostics identify a stale Codex binding and expose only its same-project main-session lineage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-diagnostics-'))
  const codexHome = join(root, 'codex-home')
  try {
    writeRollout(codexHome, '01', ORIGINAL_ID, { timestamp: '2026-08-01T01:00:00.000Z' })
    writeRollout(codexHome, '02', MIDDLE_ID, {
      forkedFromId: ORIGINAL_ID,
      timestamp: '2026-08-02T01:00:00.000Z'
    })
    writeRollout(codexHome, '03', CURRENT_ID, {
      forkedFromId: MIDDLE_ID,
      timestamp: '2026-08-03T01:00:00.000Z'
    })
    writeRollout(codexHome, '04', '019fcac6-1111-7da1-92ff-454e53dab197', {
      forkedFromId: CURRENT_ID,
      threadSource: 'subagent',
      timestamp: '2026-08-04T01:00:00.000Z'
    })

    const { service } = createHarness(codexHome)
    const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')

    assert.equal(diagnostic.schemaVersion, 1)
    assert.equal(diagnostic.sessionId, '86c7ff49-9090-4e79-bf3f-b6428cae75ff')
    assert.equal(diagnostic.adapterId, 'codex')
    assert.equal(diagnostic.cwd, CWD)
    assert.equal(diagnostic.status, 'idle')
    assert.equal(diagnostic.storedNativeSessionId, ORIGINAL_ID)
    assert.equal(diagnostic.resolvedNativeSessionId, CURRENT_ID)
    assert.equal(diagnostic.bindingState, 'stale')
    assert.equal(diagnostic.repairAvailable, true)
    assert.deepEqual(diagnostic.lineage.map((item) => item.sessionId), [
      ORIGINAL_ID,
      MIDDLE_ID,
      CURRENT_ID
    ])
    assert.doesNotMatch(JSON.stringify(diagnostic), /rollout-|\\.jsonl|prompt|message|subagent/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diagnostics distinguish current, unbound, missing, cwd mismatch, and unsupported bindings', async (t) => {
  await t.test('current', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ucli-session-current-'))
    const codexHome = join(root, 'codex-home')
    try {
      writeRollout(codexHome, '03', CURRENT_ID)
      const { service } = createHarness(codexHome, { cliSessionId: CURRENT_ID })
      const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')
      assert.equal(diagnostic.bindingState, 'current')
      assert.equal(diagnostic.repairAvailable, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('unbound', async () => {
    const { service } = createHarness('F:\\missing-codex-home', { cliSessionId: null })
    const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')
    assert.equal(diagnostic.bindingState, 'unbound')
    assert.equal(diagnostic.resolvedNativeSessionId, null)
  })

  await t.test('missing', async () => {
    const { service } = createHarness('F:\\missing-codex-home')
    const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')
    assert.equal(diagnostic.bindingState, 'missing')
  })

  await t.test('cwd mismatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ucli-session-cwd-mismatch-'))
    const codexHome = join(root, 'codex-home')
    try {
      writeRollout(codexHome, '01', ORIGINAL_ID, { cwd: 'F:\\projects\\another' })
      const { service } = createHarness(codexHome)
      const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')
      assert.equal(diagnostic.bindingState, 'cwd_mismatch')
      assert.equal(diagnostic.repairAvailable, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('unsupported', async () => {
    const { service } = createHarness('F:\\missing-codex-home', { adapterId: 'claude' })
    const diagnostic = await service.get('86c7ff49-9090-4e79-bf3f-b6428cae75ff')
    assert.equal(diagnostic.bindingState, 'unsupported')
    assert.equal(diagnostic.repairAvailable, false)
  })
})

test('repair persists and publishes the latest descendant exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-repair-'))
  const codexHome = join(root, 'codex-home')
  try {
    writeRollout(codexHome, '01', ORIGINAL_ID)
    writeRollout(codexHome, '03', CURRENT_ID, { forkedFromId: ORIGINAL_ID })
    const { entry, persisted, published, service } = createHarness(codexHome)

    const first = await service.repair(entry.session.id)
    const second = await service.repair(entry.session.id)

    assert.equal(first.changed, true)
    assert.equal(first.previousNativeSessionId, ORIGINAL_ID)
    assert.equal(first.diagnostic.bindingState, 'current')
    assert.equal(second.changed, false)
    assert.equal(entry.session.cliSessionId, CURRENT_ID)
    assert.deepEqual(persisted, [{ sessionId: entry.session.id, nativeSessionId: CURRENT_ID }])
    assert.deepEqual(published, [{ sessionId: entry.session.id, nativeSessionId: CURRENT_ID }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repair never overwrites a binding changed concurrently by native resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-session-repair-race-'))
  const codexHome = join(root, 'codex-home')
  try {
    writeRollout(codexHome, '01', ORIGINAL_ID)
    writeRollout(codexHome, '03', CURRENT_ID, { forkedFromId: ORIGINAL_ID })
    const { entry, persisted, published, service } = createHarness(codexHome)

    const repairPromise = service.repair(entry.session.id)
    entry.session.cliSessionId = CURRENT_ID
    const result = await repairPromise

    assert.equal(result.changed, false)
    assert.equal(result.diagnostic.bindingState, 'current')
    assert.equal(entry.session.cliSessionId, CURRENT_ID)
    assert.deepEqual(persisted, [])
    assert.deepEqual(published, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repair rejects bindings that cannot be resolved safely', async () => {
  const { service } = createHarness('F:\\missing-codex-home')
  await assert.rejects(
    service.repair('86c7ff49-9090-4e79-bf3f-b6428cae75ff'),
    /无法从本机 Codex 会话中安全修复绑定/
  )
  await assert.rejects(service.get('missing-ucli-session'), /会话不存在/)
})
