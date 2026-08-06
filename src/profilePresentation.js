const STATUS = {
  ready: { label: '可用', color: 'green', action: null },
  drifted: { label: '文件已被外部修改', color: 'orange', action: 'review-drift' },
  missing_file: { label: '档案文件缺失', color: 'red', action: 'repair' },
  missing_provider: { label: '引用的 Provider 不存在', color: 'red', action: null },
  secret_unavailable: { label: '密钥不可用', color: 'red', action: null },
  missing_profile: { label: '档案不存在', color: 'red', action: null }
}

export function profileStatusPresentation(status) {
  return STATUS[status] || STATUS.missing_profile
}

export function profileEndpointLabel(baseUrl) {
  try {
    return new URL(baseUrl).hostname || '未设置'
  } catch {
    return '未设置'
  }
}

export function profileSecretLabel(profile = {}) {
  if (!profile.hasSecret) return '未保存密钥'
  return profile.secretSuffix
    ? `已安全保存 ···· ${profile.secretSuffix}`
    : '已安全保存'
}

export function profileBadges(profile = {}) {
  return [
    profile.isAppDefault ? '应用默认' : null,
    profile.isProjectDefault ? '项目默认' : null
  ].filter(Boolean)
}

export function profileRuntimeNotice(session = {}) {
  if (session.profileStatus && session.profileStatus !== 'ready') {
    return '当前档案不可启动，请先处理配置问题'
  }
  if (session.restartRequired) return '档案将在重启会话后生效'
  return ''
}
