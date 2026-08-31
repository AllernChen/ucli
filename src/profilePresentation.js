const STATUS = {
  ready: { label: '可用', color: 'green', action: null },
  drifted: { label: '文件已被外部修改', color: 'orange', action: 'review-drift' },
  missing_file: { label: '档案文件缺失', color: 'red', action: 'repair' },
  missing_provider: { label: '引用的 Provider 不存在', color: 'red', action: null },
  secret_unavailable: { label: '密钥不可用', color: 'red', action: null },
  missing_profile: { label: '档案不存在', color: 'red', action: null },
  unreachable: { label: '服务端暂时不可达', color: 'orange', action: null },
  disabled: { label: '服务端授权已停用', color: 'red', action: null },
  expired: { label: '服务端授权已到期', color: 'red', action: null },
  deleted: { label: '服务端授权已删除', color: 'red', action: null }
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

export function profileOriginLabel(profile = {}) {
  return profile.sourceKind === 'server'
    ? `组织提供${profile.organizationName ? ` · ${profile.organizationName}` : ''}`
    : null
}

const SERVICE_PROFILE_AVAILABILITY = {
  ready: { label: '可用', color: 'green' },
  unreachable: { label: '服务端暂时不可达', color: 'orange' },
  disabled: { label: '服务端授权已停用', color: 'red' },
  expired: { label: '服务端授权已到期', color: 'red' },
  deleted: { label: '服务端授权已删除', color: 'red' }
}

export function serviceProfileAvailabilityPresentation(status) {
  return SERVICE_PROFILE_AVAILABILITY[status] || SERVICE_PROFILE_AVAILABILITY.unreachable
}

export function serviceProfileLabel(profile = {}) {
  const endpoint = profileEndpointLabel(profile.serverOrigin)
  const organization = typeof profile.organization?.name === 'string' ? profile.organization.name.trim() : ''
  return endpoint === '未设置' ? '未设置服务' : (organization ? `${endpoint} · ${organization}` : endpoint)
}

export function serviceModelLabel(model = {}) {
  const id = typeof model.id === 'string' ? model.id : ''
  const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : ''
  return displayName && displayName !== id ? `${displayName} · ${id}` : (displayName || id)
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

const CLAUDE_CONNECTION_MODES = {
  subscription: { label: 'Claude 登录态', secretLabel: null, requiresBaseUrl: false },
  api_key: { label: 'Anthropic API Key', secretLabel: 'API Key', requiresBaseUrl: false },
  bearer: { label: 'Bearer Token 网关', secretLabel: 'Bearer Token', requiresBaseUrl: true }
}

export function claudeConnectionModePresentation(mode) {
  return CLAUDE_CONNECTION_MODES[mode] || CLAUDE_CONNECTION_MODES.subscription
}

export function claudeInheritedAuthPresentation(mode) {
  return {
    api_key: '检测到继承的 API Key',
    bearer: '检测到继承的 Bearer Token',
    cloud_provider: '检测到云服务商路由',
    login_or_unknown: '使用 Claude 登录态或系统默认'
  }[mode] || '使用 Claude 登录态或系统默认'
}

export function profileRuntimeNotice(session = {}) {
  if (session.sourceKind === 'server' && (session.status && session.status !== 'ready')) {
    return '组织提供的档案当前不可用'
  }
  if (session.profileStatus && session.profileStatus !== 'ready') {
    return '当前档案不可启动，请先处理配置问题'
  }
  if (session.profileWarning === 'model_substituted') {
    return '实际模型已被 Claude 组织策略替换'
  }
  if (session.restartRequired) return '档案将在重启会话后生效'
  return ''
}
