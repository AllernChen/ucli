import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionCardActionItems } from '../src/sessionCardActions.js'

function terminalSession(overrides = {}) {
  return {
    id: 's1',
    adapterId: 'claude',
    status: 'running',
    capabilities: {
      surface: 'terminal',
      permissionOwner: 'ucli',
      historyOwner: 'ucli',
      statsOwner: 'ucli',
      gateway: true,
      bridge: false
    },
    ...overrides
  }
}

function dshWebSession(overrides = {}) {
  return {
    id: 's2',
    adapterId: 'deepseek-harness',
    status: 'offline',
    capabilities: {
      surface: 'web',
      permissionOwner: 'native',
      historyOwner: 'native',
      statsOwner: 'ucli',
      gateway: false,
      bridge: false
    },
    ...overrides
  }
}

test('session card actions expose stop/restart/rename/delete for a running terminal session', () => {
  const items = sessionCardActionItems(terminalSession())
  const keys = items.map(i => i.key)
  assert.deepEqual(keys, ['stop', 'restart', 'rename', 'delete'])
  assert.equal(items.find(i => i.key === 'delete').danger, true)
  assert.equal(items.find(i => i.key === 'stop').label, '停止进程')
})

test('stop action is hidden for non-running sessions', () => {
  const items = sessionCardActionItems(terminalSession({ status: 'offline' }))
  assert.equal(items.some(i => i.key === 'stop'), false)
  assert.equal(items.some(i => i.key === 'restart'), true)
})

test('DSH native web session uses maintenance gating and web copy', () => {
  const items = sessionCardActionItems(dshWebSession())
  // Offline web host: no stop (canStop false when status is offline).
  assert.equal(items.some(i => i.key === 'stop'), false)
  // Restart is still offered with the web-specific label.
  assert.equal(items.find(i => i.key === 'restart').label, '重启 Web 主机')
})
