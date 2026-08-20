import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveSessionCapabilityState,
  deriveSessionMaintenanceCopy,
  deriveSessionMaintenanceState
} from '../src/sessionMaintenancePresentation.js'

const terminalCapabilities = {
  surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
  statsOwner: 'ucli', gateway: true, bridge: false
}

test('authoritative capabilities fail closed and distinguish bridged TUI from native Web', () => {
  assert.deepEqual(deriveSessionCapabilityState({ adapterId: 'deepseek-harness', capabilities: null }), {
    known: false,
    terminal: false,
    web: false,
    ucliPermission: false,
    ucliHistory: false,
    ucliStats: false,
    gateway: false
  })
  assert.deepEqual(deriveSessionCapabilityState({
    adapterId: 'deepseek-harness',
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: true
    }
  }), {
    known: true,
    terminal: true,
    web: false,
    ucliPermission: true,
    ucliHistory: true,
    ucliStats: true,
    gateway: true
  })
  assert.deepEqual(deriveSessionCapabilityState({
    adapterId: 'deepseek-harness',
    capabilities: {
      surface: 'web', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    }
  }), {
    known: true,
    terminal: false,
    web: true,
    ucliPermission: false,
    ucliHistory: false,
    ucliStats: false,
    gateway: false
  })
  assert.equal(deriveSessionCapabilityState({
    adapterId: 'claude',
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: false
    }
  }).gateway, true)
})

test('maintenance disables Web interruption and names the exact owned process boundary', () => {
  const web = {
    id: 'web', status: 'running', canStart: true, adapterId: 'deepseek-harness',
    capabilities: {
      surface: 'web', permissionOwner: 'native', historyOwner: 'native',
      statsOwner: 'native', gateway: false, bridge: false
    }
  }
  assert.equal(deriveSessionMaintenanceState(web).canInterrupt, false)
  assert.deepEqual(deriveSessionMaintenanceCopy(web), {
    stopTitle: '停止 Web 主机',
    stopHelp: '停止整个 DSH Web 主机，会话转为离线',
    restartTitle: '重启 Web 主机',
    restartHelp: '停止整个 DSH Web 主机后重新启动'
  })

  const tui = {
    ...web,
    capabilities: {
      surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
      statsOwner: 'ucli', gateway: true, bridge: true
    }
  }
  assert.equal(deriveSessionMaintenanceState(tui).canInterrupt, true)
  assert.equal(deriveSessionMaintenanceCopy(tui).stopTitle, '停止 TUI 进程')
})

test('active sessions expose interrupt, stop, restart, and remove actions', () => {
  for (const status of ['running', 'idle', 'waiting']) {
    assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status, canStart: true, capabilities: terminalCapabilities }), {
      canInterrupt: true,
      canStop: true,
      canRestart: true,
      canRemove: true,
      stopBeforeRestart: true
    })
  }
})

test('starting sessions can be stopped or restarted but not interrupted', () => {
  assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status: 'starting', canStart: true, capabilities: terminalCapabilities }), {
    canInterrupt: false,
    canStop: true,
    canRestart: true,
    canRemove: true,
    stopBeforeRestart: true
  })
})

test('offline, exited, and error sessions expose restart without soft interruption or stop', () => {
  for (const status of ['offline', 'exited', 'error']) {
    assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status, canStart: true, capabilities: terminalCapabilities }), {
      canInterrupt: false,
      canStop: false,
      canRestart: true,
      canRemove: true,
      stopBeforeRestart: status !== 'offline'
    })
  }
})

test('unavailable or missing sessions do not expose invalid lifecycle actions', () => {
  assert.deepEqual(deriveSessionMaintenanceState({ id: 'session-1', status: 'offline', canStart: false, capabilities: terminalCapabilities }), {
    canInterrupt: false,
    canStop: false,
    canRestart: false,
    canRemove: true,
    stopBeforeRestart: false
  })
  assert.deepEqual(deriveSessionMaintenanceState(), {
    canInterrupt: false,
    canStop: false,
    canRestart: false,
    canRemove: false,
    stopBeforeRestart: false
  })
})
