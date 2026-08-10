const PROFILE_ADAPTERS = new Set(['codex', 'claude'])

export function deriveSessionConfigState(session = {}) {
  const profileCapable = PROFILE_ADAPTERS.has(session.adapterId)
  const providerEditable = session.adapterId === 'codex' && !session.profileId
  let attentionCode = null
  let attentionText = ''

  if (session.restartRequired) {
    attentionCode = 'restart_required'
    attentionText = '配置已变更，重启后生效'
  } else if (session.profileWarning) {
    attentionCode = 'profile_warning'
    attentionText = '配置档案需要处理'
  } else if (session.providerWarning || session.pendingProviderWarning) {
    attentionCode = 'provider_warning'
    attentionText = 'Provider 配置需要处理'
  }

  return {
    profileCapable,
    providerEditable,
    explicitProviderVisible: providerEditable && session.providerPolicy === 'explicit',
    needsAttention: Boolean(attentionCode),
    attentionCode,
    attentionText
  }
}
