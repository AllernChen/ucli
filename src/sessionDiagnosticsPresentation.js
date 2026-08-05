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
