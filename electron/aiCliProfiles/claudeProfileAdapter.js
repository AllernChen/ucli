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
const MANAGED_SETTING_SOURCES = Object.freeze(['project', 'local'])
const ROUTING_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE'
]
const ROUTING_KEY_SET = new Set(ROUTING_KEYS)

function claudeProfileError(code, message = code) {
  return Object.assign(new TypeError(message), { code })
}

export function isSafeClaudeModel(value) {
  return typeof value === 'string' && MODEL_PATTERN.test(value)
}

export function normalizeClaudeHistoryModel(value) {
  return isSafeClaudeModel(value) ? value : null
}

export function normaliseClaudeProfileDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }

  const connectionMode = String(draft.connectionMode || draft.config?.connectionMode || '')
  if (!CONNECTION_MODES.has(connectionMode)) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }

  const model = draft.model === null || draft.model === undefined || draft.model === ''
    ? null
    : String(draft.model).trim()
  if (model && !isSafeClaudeModel(model)) {
    throw claudeProfileError('INVALID_CLAUDE_MODEL')
  }

  const baseUrlInput = String(
    Object.hasOwn(draft, 'baseUrl')
      ? (draft.baseUrl ?? '')
      : (draft.config?.baseUrl ?? '')
  ).trim()
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

export function buildClaudeProfileArgs({ session = {}, profile = null } = {}) {
  const requestedModel = profile?.model || session.model || null
  if (requestedModel && !isSafeClaudeModel(requestedModel)) {
    throw claudeProfileError('INVALID_CLAUDE_MODEL')
  }

  const args = []
  if (requestedModel) args.push('--model', requestedModel)
  if (session.cliSessionId) args.push('--resume', String(session.cliSessionId))
  return args
}

export function buildClaudeProfileEnvironment({
  baseEnv = process.env,
  profile = null,
  secret = null
} = {}) {
  const env = { ...baseEnv }
  if (!profile) return env

  for (const key of Object.keys(env)) {
    if (ROUTING_KEY_SET.has(key.toUpperCase())) delete env[key]
  }
  const connectionMode = profile.config?.connectionMode
  if (connectionMode === 'subscription') return env
  if (!['api_key', 'bearer'].includes(connectionMode)) {
    throw claudeProfileError('INVALID_CLAUDE_PROFILE')
  }
  if (typeof secret !== 'string' || !secret.trim()) {
    throw claudeProfileError('PROFILE_SECRET_REQUIRED')
  }

  const baseUrlResult = validateProfileBaseUrl(profile.config?.baseUrl)
  if (!baseUrlResult.ok || (connectionMode === 'bearer' && !baseUrlResult.value)) {
    throw claudeProfileError('INVALID_PROFILE_BASE_URL')
  }
  if (connectionMode === 'api_key') env.ANTHROPIC_API_KEY = secret
  if (connectionMode === 'bearer') env.ANTHROPIC_AUTH_TOKEN = secret
  if (baseUrlResult.value) env.ANTHROPIC_BASE_URL = baseUrlResult.value
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
  return env
}

export function prepareClaudeProfileSession({ session = {}, selection = {}, launch = null } = {}) {
  if (selection.canStart === false) {
    throw claudeProfileError('PROFILE_NOT_READY')
  }
  if (!selection.profileId) {
    return {
      session: {
        ...session,
        model: session.systemModel ?? session.model ?? null,
        profileId: null,
        activeProfileId: null,
        pendingProfileId: null,
        profileStatus: null,
        profileRuntimeRevision: null,
        pendingProfileRuntimeRevision: null,
        restartRequired: false,
        canStart: true,
        actualModel: null,
        profileWarning: null
      },
      profileLaunch: null
    }
  }
  if (!launch || launch.status !== 'ready') {
    throw claudeProfileError('PROFILE_NOT_READY')
  }
  return {
    session: {
      ...session,
      profileId: selection.profileId,
      model: launch.artifact?.model ?? session.systemModel ?? session.model ?? null,
      activeProfileId: null,
      pendingProfileId: null,
      profileStatus: launch.status,
      profileRuntimeRevision: launch.runtimeRevision || null,
      pendingProfileRuntimeRevision: null,
      restartRequired: false,
      canStart: true,
      actualModel: null,
      profileWarning: null
    },
    profileLaunch: {
      args: [...launch.args],
      env: { ...launch.env },
      ...(Array.isArray(launch.settingSources)
        ? { settingSources: [...launch.settingSources] }
        : {})
    }
  }
}

export function describeClaudeModelSelection({ requestedModel, actualModel } = {}) {
  const safeActualModel = isSafeClaudeModel(actualModel) ? actualModel : null
  const safeRequestedModel = isSafeClaudeModel(requestedModel) ? requestedModel : null
  return {
    actualModel: safeActualModel,
    profileWarning: safeActualModel && safeRequestedModel && safeActualModel !== safeRequestedModel
      ? 'model_substituted'
      : null
  }
}

export function createClaudeProfileAdapter() {
  return {
    id: 'claude',

    validateDraft(draft = {}) {
      return normaliseClaudeProfileDraft(draft)
    },

    sanitiseConfig(config = {}) {
      const connectionMode = CONNECTION_MODES.has(config.connectionMode)
        ? config.connectionMode
        : 'subscription'
      const baseUrlResult = validateProfileBaseUrl(config.baseUrl)
      return {
        connectionMode,
        baseUrl: baseUrlResult.ok ? baseUrlResult.value : null
      }
    },

    resolveLaunch({ profile, secret, session = {}, baseEnv = process.env }) {
      const connectionMode = profile.config?.connectionMode || null
      return {
        args: buildClaudeProfileArgs({ session, profile }),
        env: buildClaudeProfileEnvironment({ baseEnv, profile, secret }),
        ...(['api_key', 'bearer'].includes(connectionMode)
          ? { settingSources: [...MANAGED_SETTING_SOURCES] }
          : {}),
        artifact: {
          model: profile.model || null,
          connectionMode
        }
      }
    },

    reconcile({ profile, secretState = {} }) {
      if (!profile) {
        return { profileId: null, status: 'missing_profile', canStart: false, runtimeRevision: null }
      }
      if (profile.kind === 'managed' && (
        secretState.hasSecret !== true ||
        secretState.encryptionAvailable !== true ||
        secretState.decryptionFailed
      )) {
        return {
          profileId: profile.id,
          status: 'secret_unavailable',
          canStart: false,
          runtimeRevision: null
        }
      }
      return {
        profileId: profile.id,
        status: 'ready',
        canStart: true,
        runtimeRevision: profile.updatedAt || null
      }
    }
  }
}
