import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../electron/persistence/db.js'

test('removing a session hides it from the workbench but retains usage statistics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-retention-'))
  const db = await openDb(join(dir, 'ucli.db'))

  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'claude',
      native_session_id: 'native-1',
      provider: 'openai',
      source_provider: 'cubence_codex',
      tier: 'safety-rules',
      model: 'claude-test',
      status: 'offline',
      created_at: 1
    })
    db.upsertStats('session-1', {
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25,
      turnsDelta: 2,
      confirmed: 1
    })
    db.upsertModelStats('session-1', 'claude-test', {
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25
    })

    db.removeSession('session-1')

    assert.deepEqual(db.listSessions(), [])
    const [removed] = db.listSessions({ includeRemoved: true })
    assert.equal(removed.id, 'session-1')
    assert.equal(removed.status, 'removed')
    assert.equal(removed.provider, 'openai')
    assert.equal(removed.sourceProvider, 'cubence_codex')
    assert.ok(removed.removedAt)
    assert.equal(removed.stats.tokens.input, 120)
    assert.equal(removed.stats.costUsd, 0.25)
    assert.equal(db.getModelStats()[0].input_tokens, 120)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
