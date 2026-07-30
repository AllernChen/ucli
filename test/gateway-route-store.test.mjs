import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GatewayRouteStore } from '../electron/gateway/routeStore.js'
import { openDb } from '../electron/persistence/db.js'

test('Gateway routes resolve only by exact active message and channel fingerprint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-routes-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const store = new GatewayRouteStore(db)
  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'codex',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    store.upsertSessionRoute({
      sessionId: 'session-1',
      relayEnabled: true,
      channelFingerprint: 'fingerprint-1',
      targetId: 'oc_group',
      rootMessageId: 'root-1',
      rootThreadId: 'thread-1',
      routeStatus: 'ready'
    })
    store.saveMessageRoute({
      messageId: 'message-1',
      sessionId: 'session-1',
      relayTaskId: 'task-1',
      decisionId: 'decision-1',
      routeKind: 'decision',
      channelFingerprint: 'fingerprint-1',
      messageContent: 'must never persist'
    })

    const resolved = store.resolveMessageRoute('message-1', 'fingerprint-1')
    assert.deepEqual(resolved, {
      messageId: 'message-1',
      sessionId: 'session-1',
      relayTaskId: 'task-1',
      decisionId: 'decision-1',
      routeKind: 'decision',
      channelFingerprint: 'fingerprint-1',
      active: true,
      createdAt: resolved.createdAt
    })
    assert.equal(store.resolveMessageRoute('message-1', 'wrong'), null)
    const columns = db.sql.exec('PRAGMA table_info(gateway_message_routes)')[0].values
      .map((row) => row[1])
    assert.equal(columns.some((name) => /content|text|token|markdown/i.test(name)), false)

    store.deactivateFingerprint('fingerprint-1')
    assert.equal(store.resolveMessageRoute('message-1', 'fingerprint-1'), null)
    assert.equal(store.listSessionRoutes()[0].routeStatus, 'inactive')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relay selection updates without erasing an existing session root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-gateway-relay-selection-'))
  const db = await openDb(join(dir, 'ucli.db'))
  const store = new GatewayRouteStore(db)
  try {
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\demo',
      adapter_id: 'claude',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    store.upsertSessionRoute({
      sessionId: 'session-1',
      relayEnabled: true,
      channelFingerprint: 'fingerprint-1',
      rootMessageId: 'root-1',
      routeStatus: 'ready'
    })
    store.setRelayEnabled('session-1', false)

    const [route] = store.listSessionRoutes()
    assert.equal(route.relayEnabled, false)
    assert.equal(route.rootMessageId, 'root-1')
    assert.equal(route.channelFingerprint, 'fingerprint-1')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
