const STATE_LABELS = {
  current: '绑定正常',
  stale: '发现更新的续接会话，可以修复',
  unbound: '尚未绑定 Codex 会话',
  missing: '本机找不到已绑定的 Codex 会话',
  cwd_mismatch: '绑定会话与当前项目目录不一致',
  unsupported: '当前 CLI 暂不支持会话绑定诊断'
}

export function sessionBindingStateLabel(state) {
  return STATE_LABELS[state] || '未知'
}

export function sessionBindingAlertType(state) {
  if (state === 'current') return 'success'
  if (state === 'stale') return 'warning'
  if (state === 'missing' || state === 'cwd_mismatch') return 'error'
  return 'info'
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null
}

function timestampOrNull(value) {
  if (typeof value === 'string' && value) return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatSessionDiagnosticsForClipboard(diagnostic = {}) {
  const lineage = Array.isArray(diagnostic.lineage)
    ? diagnostic.lineage.map((item) => ({
        sessionId: stringOrNull(item?.sessionId),
        forkedFromId: stringOrNull(item?.forkedFromId),
        startedAt: timestampOrNull(item?.startedAt),
        updatedAt: timestampOrNull(item?.updatedAt)
      }))
    : []

  return JSON.stringify({
    schemaVersion: Number.isInteger(diagnostic.schemaVersion) ? diagnostic.schemaVersion : 1,
    sessionId: stringOrNull(diagnostic.sessionId),
    adapterId: stringOrNull(diagnostic.adapterId),
    status: stringOrNull(diagnostic.status),
    bindingState: stringOrNull(diagnostic.bindingState),
    storedNativeSessionId: stringOrNull(diagnostic.storedNativeSessionId),
    resolvedNativeSessionId: stringOrNull(diagnostic.resolvedNativeSessionId),
    repairAvailable: diagnostic.repairAvailable === true,
    lineage
  }, null, 2)
}
