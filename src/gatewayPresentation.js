const PHASES = {
  off: { label: '已关闭', color: 'default' },
  connecting: { label: '连接中', color: 'blue' },
  waiting_binding: { label: '等待绑定', color: 'orange' },
  connected: { label: '已连接', color: 'green' },
  reconnecting: { label: '重连中', color: 'orange' },
  error: { label: '连接异常', color: 'red' }
}

export function gatewayPhaseLabel(phase) {
  return PHASES[phase]?.label || '状态未知'
}

export function gatewayPhaseColor(phase) {
  return PHASES[phase]?.color || 'default'
}

export function gatewayTargetLabel(config) {
  const target = config?.target
  if (!target?.id) return '等待飞书绑定'
  if (target.name) {
    return `${target.type === 'group' ? '群聊' : '用户'} · ${target.name}`
  }
  const points = Array.from(target.id)
  const masked = points.length > 8
    ? `${points.slice(0, 4).join('')}…${points.slice(-4).join('')}`
    : target.id
  return `${target.type === 'group' ? '群聊' : '用户'} · ${masked}`
}

export function gatewayTooltip(state = {}) {
  const lines = [
    `已选择 ${state.selectedSessionCount || 0} 个会话`,
    `可转发 ${state.readySessionCount || 0} 个会话`
  ]
  if (state.errorMessage) lines.push(state.errorMessage)
  return lines.join('；')
}

export function gatewayTimeLabel(value) {
  if (!Number.isFinite(value)) return '—'
  return new Date(value).toLocaleString()
}
