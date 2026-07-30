import {
  buildDiagnosticReport,
  diagnosticReportFileName,
  serializeDiagnosticReport
} from './diagnostics.js'

const GATEWAY_ERROR_MESSAGES = {
  permission_denied: 'Gateway 权限不足，请检查通信端配置。',
  not_connected: 'Gateway 当前未连接。',
  target_revoked: 'Gateway 目标会话已失效。',
  rate_limited: 'Gateway 请求频率受限，请稍后重试。',
  send_timeout: 'Gateway 请求超时，请检查网络后重试。',
  config_required: 'Gateway 配置不完整。',
  connection_error: 'Gateway 连接异常，请检查通信端配置。'
}
const GATEWAY_PHASES = new Set([
  'off',
  'connecting',
  'waiting_binding',
  'connected',
  'reconnecting',
  'error'
])

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function redactIdentifier(value) {
  if (typeof value !== 'string' || !value) return null
  if (value.length <= 7) return '***'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

function unavailableGatewayDiagnostics() {
  return {
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
  }
}

export function sanitizeGatewayDiagnostics(value) {
  if (!value || typeof value !== 'object') {
    return unavailableGatewayDiagnostics()
  }
  const rawCode = typeof value.errorCode === 'string' && value.errorCode
    ? value.errorCode
    : null
  const code = rawCode
    ? (GATEWAY_ERROR_MESSAGES[rawCode] ? rawCode : 'connection_error')
    : null
  const targetId = redactIdentifier(value.target?.id)
  const targetType = value.target?.type === 'group' || value.target?.type === 'user'
    ? value.target.type
    : null
  return {
    desiredState: value.desiredEnabled === true
      ? 'enabled'
      : value.desiredEnabled === false
        ? 'disabled'
        : 'unknown',
    actualState: GATEWAY_PHASES.has(value.phase) ? value.phase : 'unavailable',
    channelType: value.channelType === 'feishu' ? 'feishu' : null,
    target: targetId && targetType
      ? {
          type: targetType,
          id: targetId
        }
      : null,
    sessions: {
      selected: safeCount(value.selectedSessionCount),
      ready: safeCount(value.readySessionCount)
    },
    lastConnectedAt: Number.isFinite(value.lastConnectedAt)
      ? value.lastConnectedAt
      : null,
    error: {
      code,
      message: code
        ? (GATEWAY_ERROR_MESSAGES[code] || GATEWAY_ERROR_MESSAGES.connection_error)
        : ''
    },
    storage: {
      sessionRouteRows: safeCount(value.rowCounts?.sessionRoutes),
      messageRouteRows: safeCount(value.rowCounts?.messageRoutes),
      decisionAuditRows: safeCount(value.rowCounts?.decisionAudits)
    }
  }
}

export function createDiagnosticsService({
  getRuntime,
  inspectCliTools,
  getPersistence,
  getGateway = null,
  showSaveDialog,
  writeFile
}) {
  async function getReport() {
    let gateway = null
    if (getGateway) {
      try {
        gateway = sanitizeGatewayDiagnostics(await getGateway())
      } catch {
        gateway = unavailableGatewayDiagnostics()
      }
    }
    return buildDiagnosticReport({
      ...getRuntime(),
      cliTools: await inspectCliTools(),
      persistence: getPersistence(),
      gateway
    })
  }

  async function exportReport() {
    const report = await getReport()
    const result = await showSaveDialog({
      title: 'Export UCLI diagnostics',
      defaultPath: diagnosticReportFileName(report),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    writeFile(result.filePath, serializeDiagnosticReport(report), 'utf8')
    return { canceled: false, filePath: result.filePath }
  }

  return { getReport, exportReport }
}
