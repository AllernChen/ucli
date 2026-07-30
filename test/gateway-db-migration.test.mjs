import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDb } from '../electron/persistence/db.js'

const GATEWAY_TABLES = [
  'gateway_decision_audit',
  'gateway_message_routes',
  'gateway_secrets',
  'gateway_session_routes'
]

function tableNames(db) {
  return db.sql.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )[0].values.map(([name]) => name)
}

test('new databases add the four Gateway metadata tables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-db-new-'))
  const db = await openDb(join(dir, 'ucli.db'))
  try {
    assert.deepEqual(
      tableNames(db).filter((name) => name.startsWith('gateway_')),
      GATEWAY_TABLES
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy databases gain Gateway tables without changing existing records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-db-legacy-'))
  const path = join(dir, 'ucli.db')
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const legacy = new SQL.Database()
  legacy.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, adapter_id TEXT NOT NULL, native_session_id TEXT, name TEXT, task_note TEXT DEFAULT '', tier TEXT NOT NULL DEFAULT 'safety-rules', model TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run('CREATE TABLE session_stats (session_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, turns_count INTEGER, auto_allowed INTEGER, confirmed INTEGER, denied INTEGER)')
  legacy.run('CREATE TABLE model_stats (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, PRIMARY KEY(session_id, model))')
  legacy.run('CREATE TABLE rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL)')
  legacy.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  legacy.run("INSERT INTO sessions VALUES ('legacy-session', 'F:\\projects\\legacy', 'claude', NULL, 'Legacy', '', 'safety-rules', NULL, 'offline', 1, 2)")
  legacy.run("INSERT INTO rules VALUES ('default', 'Default', '{\"allow\":[]}' )")
  legacy.run("INSERT INTO settings VALUES ('app', '{\"theme\":\"dark\"}')")
  writeFileSync(path, Buffer.from(legacy.export()))
  legacy.close()

  const db = await openDb(path)
  try {
    assert.deepEqual(
      tableNames(db).filter((name) => name.startsWith('gateway_')),
      GATEWAY_TABLES
    )
    assert.equal(db.getSession('legacy-session').name, 'Legacy')
    assert.equal(db.getRules().default.name, 'Default')
    assert.equal(db.getSettings().theme, 'dark')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removing a session disables relay and routes while retaining decision audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-db-remove-'))
  const db = await openDb(join(dir, 'ucli.db'))
  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'claude',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    db.upsertGatewaySessionRoute({
      sessionId: 'session-1',
      relayEnabled: true,
      channelFingerprint: 'fingerprint-1',
      targetId: 'ou_target',
      rootMessageId: 'root-1',
      rootThreadId: 'thread-1',
      routeStatus: 'ready'
    })
    db.saveGatewayMessageRoute({
      messageId: 'message-1',
      sessionId: 'session-1',
      relayTaskId: 'task-1',
      decisionId: 'decision-1',
      routeKind: 'decision',
      channelFingerprint: 'fingerprint-1'
    })
    db.saveGatewayDecisionAudit({
      id: 'audit-1',
      sessionId: 'session-1',
      decisionId: 'decision-1',
      kind: 'permission',
      verdict: 'allow_once',
      source: 'feishu',
      resolvedAt: 10
    })

    db.removeSession('session-1')

    const [route] = db.listGatewaySessionRoutes()
    assert.equal(route.relayEnabled, false)
    assert.equal(route.routeStatus, 'inactive')
    assert.equal(db.resolveGatewayMessageRoute('message-1', 'fingerprint-1'), null)
    assert.equal(
      db.sql.exec('SELECT COUNT(*) FROM gateway_decision_audit')[0].values[0][0],
      1
    )
    assert.equal(db.getSession('session-1').status, 'removed')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
