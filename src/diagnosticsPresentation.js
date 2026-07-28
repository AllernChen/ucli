const PERSISTENCE_LABELS = {
  ready: '正常',
  recovered: '已从备份恢复',
  unavailable: '当前不可用'
}

export function persistenceStatusLabel(status) {
  return PERSISTENCE_LABELS[status] || '未知'
}

export function formatCliDiagnosticSummary(cliTools = []) {
  return cliTools.map(({ id, installed, version }) => {
    const status = installed ? (version || '已安装') : '未检测到'
    return `${id}: ${status}`
  }).join(' · ')
}
