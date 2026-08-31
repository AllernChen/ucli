const SERVICE_ADAPTER_PROTOCOL = Object.freeze({
  codex: 'openai_responses',
  claude: 'anthropic_messages'
})

const PROTOCOL_LABELS = Object.freeze({
  openai_responses: 'OpenAI Responses',
  openai_chat: 'OpenAI Chat',
  anthropic_messages: 'Anthropic Messages'
})

function modelsFor(profile) {
  return Array.isArray(profile?.models) ? profile.models : []
}

function isAvailable(model) {
  return model?.availabilityStatus === 'ready'
}

export function compatibleModelsForAdapter(profile, adapterId) {
  const protocol = SERVICE_ADAPTER_PROTOCOL[adapterId]
  if (!protocol) return []
  return modelsFor(profile).filter(model => Array.isArray(model?.protocols) && model.protocols.includes(protocol))
}

export function validateServiceProfileSelection({ profile, adapterId, modelId } = {}) {
  if (typeof modelId !== 'string' || !modelId) return { valid: false, reason: 'model-required' }
  const model = modelsFor(profile).find(candidate => candidate?.id === modelId)
  if (!isAvailable(model)) return { valid: false, reason: 'model-unavailable' }
  const protocol = SERVICE_ADAPTER_PROTOCOL[adapterId]
  if (!protocol || !Array.isArray(model.protocols) || !model.protocols.includes(protocol)) {
    return { valid: false, reason: 'protocol-unavailable' }
  }
  return { valid: true, model }
}

export function describeModelProtocols(protocols) {
  const labels = Array.isArray(protocols)
    ? protocols.map(protocol => PROTOCOL_LABELS[protocol]).filter(Boolean)
    : []
  return labels.length ? labels.join(' · ') : '未声明协议'
}
