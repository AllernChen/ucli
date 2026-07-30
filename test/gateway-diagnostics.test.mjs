import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDiagnosticsService,
  sanitizeGatewayDiagnostics
} from '../electron/diagnosticsService.js'

const runtime = {
  generatedAt: '2026-07-30T08:00:00.000Z',
  appVersion: '0.4.10',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '32.3.3',
  nodeVersion: '20.19.0'
}

test('Gateway diagnostics export only allowlisted redacted state and counts', async () => {
  const service = createDiagnosticsService({
    getRuntime: () => runtime,
    inspectCliTools: async () => [],
    getPersistence: () => ({ available: true }),
    getGateway: () => ({
      desiredEnabled: true,
      phase: 'error',
      channelType: 'feishu',
      target: { type: 'group', id: 'oc_super_secret_target' },
      selectedSessionCount: 2,
      readySessionCount: 1,
      lastConnectedAt: 1785398400000,
      errorCode: 'permission_denied',
      errorMessage: 'raw error contains app-secret-value',
      operatorOpenIds: ['ou_private_operator'],
      appSecret: 'app-secret-value',
      ciphertext: 'encrypted-secret-value',
      messageBody: 'private task body',
      actionToken: 'private-action-token',
      rowCounts: {
        sessionRoutes: 2,
        messageRoutes: 8,
        decisionAudits: 3
      }
    }),
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: () => {}
  })

  const report = await service.getReport()

  assert.deepEqual(report.gateway, {
    desiredState: 'enabled',
    actualState: 'error',
    channelType: 'feishu',
    target: {
      type: 'group',
      id: 'oc_…rget'
    },
    sessions: {
      selected: 2,
      ready: 1
    },
    lastConnectedAt: 1785398400000,
    error: {
      code: 'permission_denied',
      message: 'Gateway 权限不足，请检查通信端配置。'
    },
    storage: {
      sessionRouteRows: 2,
      messageRouteRows: 8,
      decisionAuditRows: 3
    }
  })

  const serialized = JSON.stringify(report)
  for (const forbidden of [
    'super_secret_target',
    'ou_private_operator',
    'app-secret-value',
    'encrypted-secret-value',
    'private task body',
    'private-action-token',
    'raw error'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden))
  }
})

test('Gateway diagnostics tolerate unavailable state without exposing arbitrary errors', async () => {
  const service = createDiagnosticsService({
    getRuntime: () => runtime,
    inspectCliTools: async () => [],
    getPersistence: () => ({ available: false }),
    getGateway: () => {
      throw new Error('secret-bearing collection failure')
    },
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: () => {}
  })

  const report = await service.getReport()

  assert.deepEqual(report.gateway, {
    desiredState: 'unknown',
    actualState: 'unavailable',
    channelType: null,
    target: null,
    sessions: { selected: 0, ready: 0 },
    lastConnectedAt: null,
    error: {
      code: 'diagnostics_unavailable',
      message: 'Gateway 诊断状态暂不可用。'
    },
    storage: {
      sessionRouteRows: 0,
      messageRouteRows: 0,
      decisionAuditRows: 0
    }
  })
  assert.doesNotMatch(JSON.stringify(report), /secret-bearing/)
})

test('Gateway diagnostics replace unknown phase and error codes instead of echoing them', () => {
  const value = sanitizeGatewayDiagnostics({
    desiredEnabled: true,
    phase: 'secret-bearing-phase',
    errorCode: 'secret-bearing-code'
  })

  assert.equal(value.actualState, 'unavailable')
  assert.deepEqual(value.error, {
    code: 'connection_error',
    message: 'Gateway 连接异常，请检查通信端配置。'
  })
  assert.doesNotMatch(JSON.stringify(value), /secret-bearing/)
})
