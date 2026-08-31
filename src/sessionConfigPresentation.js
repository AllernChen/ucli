import { validateServiceProfileSelection } from './serviceProfileSelection.js'

const PROFILE_ADAPTERS = new Set(['codex', 'claude'])

export function isServiceProfile(profile) {
  return profile?.source === 'server' || profile?.sourceKind === 'server'
}

export function deriveServiceProfileSessionState({
  profile = null,
  adapterId,
  profileId = null,
  model = null,
  historical = false
} = {}) {
  const selection = validateServiceProfileSelection({ profile, adapterId, modelId: model })
  const profileAvailable = !profile?.availabilityStatus || profile.availabilityStatus === 'ready'
  const canStart = selection.valid && profileAvailable
  return {
    profileId,
    model,
    canStart,
    reason: canStart ? null : (selection.valid ? 'model-unavailable' : selection.reason),
    ...(historical ? {
      historicalModel: {
        id: model,
        displayName: model,
        historical: true,
        availabilityStatus: 'removed'
      }
    } : {})
  }
}

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
