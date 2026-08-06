import {
  normaliseProfileDraft,
  validateProfileBaseUrl
} from './contracts.js'

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+~-]{0,255}$/
const CONNECTION_MODES = new Set(['subscription', 'api_key', 'bearer'])
const PROVIDER_BY_MODE = {
  subscription: 'claude-subscription',
  api_key: 'anthropic-api',
  bearer: 'anthropic-bearer'
}

function claudeProfileError(code, message = code) {
  return Object.assign(new TypeError(message), { code })
}

export function isSafeClaudeModel(value) {
  return typeof value === 'string' && MODEL_PATTERN.test(value)
}

export function normaliseClaudeProfileDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }

  const connectionMode = String(draft.connectionMode || '')
  if (!CONNECTION_MODES.has(connectionMode)) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }

  const model = draft.model === null || draft.model === undefined || draft.model === ''
    ? null
    : String(draft.model).trim()
  if (model && !isSafeClaudeModel(model)) {
    throw claudeProfileError('INVALID_CLAUDE_MODEL')
  }

  const baseUrlInput = String(draft.baseUrl || '').trim()
  const baseUrlResult = validateProfileBaseUrl(baseUrlInput)
  if (!baseUrlResult.ok) {
    throw claudeProfileError('INVALID_PROFILE_BASE_URL')
  }

  const secret = typeof draft.secret === 'string' ? draft.secret : ''
  const hasSecret = secret.trim().length > 0
  const keepSecret = draft.keepSecret === true
  if (connectionMode === 'subscription') {
    if (baseUrlResult.value || hasSecret || keepSecret) {
      throw claudeProfileError('INVALID_CLAUDE_PROFILE')
    }
  } else if (!hasSecret && !keepSecret) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }
  if (connectionMode === 'bearer' && !baseUrlResult.value) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }

  const common = normaliseProfileDraft({
    adapterId: 'claude',
    name: draft.name,
    kind: connectionMode === 'subscription' ? 'reference' : 'managed',
    nativeProfileName: null,
    providerId: PROVIDER_BY_MODE[connectionMode],
    baseUrl: baseUrlResult.value,
    model,
    reasoningEffort: null,
    contextWindow: null
  })

  return {
    common,
    config: {
      connectionMode,
      baseUrl: baseUrlResult.value
    },
    secretAction: hasSecret
      ? { type: 'replace', value: secret }
      : keepSecret
        ? { type: 'keep' }
        : { type: 'none' }
  }
}
