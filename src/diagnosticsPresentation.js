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

export function profileDiagnosticSummary(summary = {}) {
  const base = `${summary.total || 0} 个档案 · ${summary.ready || 0} 可用 · ${summary.drifted || 0} 漂移 · ${summary.missing || 0} 缺失 · ${summary.codexHomeWritable ? '配置目录可写' : '配置目录不可写'}`
  if (!summary.claude || typeof summary.claude !== 'object') return base
  const modes = summary.claude.connectionModes || {}
  return `${base} · Claude：${modes.subscription || 0} 登录态 / ${modes.apiKey || 0} API Key / ${modes.bearer || 0} Bearer，${summary.claude.missingSecret || 0} 缺少凭据，${summary.claude.modelSubstitutions || 0} 模型替换`
}
