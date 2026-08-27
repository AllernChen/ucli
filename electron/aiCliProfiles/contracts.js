const PROFILE_KINDS = new Set(['reference', 'managed'])
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
const PROFILE_STATUSES = new Set([
  'ready',
  'missing_file',
  'drifted',
  'missing_provider',
  'secret_unavailable',
  'unreachable',
  'disabled',
  'expired',
  'deleted'
])

const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const NATIVE_PROFILE_PATTERN = /^ucli-[a-f0-9]{32}$/
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+~-]{0,255}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

function profileError(message, code) {
  return Object.assign(new TypeError(message), { code })
}

function optionalString(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value).trim()
}

function normaliseName(value) {
  const name = optionalString(value)
  if (!name || name.length > 120 || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw profileError('Profile name is invalid', 'INVALID_PROFILE_NAME')
  }
  return name
}

function normaliseAdapterId(value) {
  const adapterId = optionalString(value)
  if (!adapterId || !ADAPTER_ID_PATTERN.test(adapterId)) {
    throw profileError('Profile adapter is invalid', 'INVALID_PROFILE')
  }
  return adapterId
}

function normaliseProviderId(value) {
  const providerId = optionalString(value)
  if (providerId && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw profileError('Profile provider is invalid', 'INVALID_PROVIDER')
  }
  return providerId
}

function normaliseModel(value) {
  const model = optionalString(value)
  if (model && !MODEL_PATTERN.test(model)) {
    throw profileError('Profile model is invalid', 'INVALID_PROFILE')
  }
  return model
}

export function isSafeNativeProfileName(value) {
  return typeof value === 'string' && NATIVE_PROFILE_PATTERN.test(value)
}

export function validateProfileBaseUrl(value) {
  const baseUrl = optionalString(value)
  if (!baseUrl) return { ok: true, value: null }
  if (CONTROL_CHARACTER_PATTERN.test(String(value))) {
    return { ok: false, reason: 'control_characters' }
  }

  try {
    const parsed = new URL(baseUrl)
    if (parsed.username || parsed.password) return { ok: false, reason: 'credentials' }
    if (parsed.hash) return { ok: false, reason: 'fragment' }
    if (parsed.protocol === 'https:') return { ok: true, value: baseUrl }
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    if (parsed.protocol === 'http:' && isLoopback) return { ok: true, value: baseUrl }
    return { ok: false, reason: 'protocol' }
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
}

export function normaliseProfileDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw profileError('Profile is invalid', 'INVALID_PROFILE')
  }

  const kind = optionalString(draft.kind)
  if (!PROFILE_KINDS.has(kind)) {
    throw profileError('Profile kind is invalid', 'INVALID_PROFILE')
  }

  const nativeProfileName = optionalString(draft.nativeProfileName)
  if (nativeProfileName && !isSafeNativeProfileName(nativeProfileName)) {
    throw profileError('Native profile name is invalid', 'INVALID_PROFILE')
  }

  const reasoningEffort = optionalString(draft.reasoningEffort)
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw profileError('Reasoning effort is invalid', 'INVALID_REASONING_EFFORT')
  }

  const contextWindow = draft.contextWindow === null || draft.contextWindow === undefined || draft.contextWindow === ''
    ? null
    : Number(draft.contextWindow)
  if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    throw profileError('Context window is invalid', 'INVALID_CONTEXT_WINDOW')
  }

  const baseUrlResult = validateProfileBaseUrl(draft.baseUrl)
  if (!baseUrlResult.ok) {
    throw profileError('Profile base URL is invalid', 'INVALID_BASE_URL')
  }

  return {
    adapterId: normaliseAdapterId(draft.adapterId),
    name: normaliseName(draft.name),
    kind,
    nativeProfileName,
    providerId: normaliseProviderId(draft.providerId),
    baseUrl: baseUrlResult.value,
    model: normaliseModel(draft.model),
    reasoningEffort,
    contextWindow
  }
}

function baseUrlDisplay(value) {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
  } catch {
    return null
  }
}

export function sanitiseProfile(profile = {}, runtimeState = {}) {
  const kind = PROFILE_KINDS.has(profile.kind) ? profile.kind : 'reference'
  const baseUrl = kind === 'managed' && validateProfileBaseUrl(profile.baseUrl).ok
    ? optionalString(profile.baseUrl)
    : null
  const status = PROFILE_STATUSES.has(runtimeState.status) ? runtimeState.status : 'ready'
  const suffixValue = optionalString(runtimeState.secretSuffix)

  return {
    id: optionalString(profile.id),
    adapterId: optionalString(profile.adapterId),
    name: optionalString(profile.name),
    kind,
    providerId: optionalString(profile.providerId),
    baseUrl,
    baseUrlDisplay: baseUrlDisplay(baseUrl),
    model: optionalString(profile.model),
    reasoningEffort: optionalString(profile.reasoningEffort),
    contextWindow: Number.isSafeInteger(profile.contextWindow) && profile.contextWindow > 0
      ? profile.contextWindow
      : null,
    hasSecret: Boolean(profile.hasSecret ?? profile.hasSecretHint),
    secretSuffix: suffixValue ? suffixValue.slice(-4) : null,
    status,
    canStart: runtimeState.canStart !== false,
    isAppDefault: Boolean(runtimeState.isAppDefault),
    isProjectDefault: Boolean(runtimeState.isProjectDefault),
    updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : null,
    sourceKind: 'user',
    readOnly: false,
    organizationName: null,
    serverStatus: null,
    connectionRevision: null
  }
}

export function sanitiseProfileError(error) {
  const publicCodes = new Set([
    'PROFILE_NOT_FOUND', 'PROFILE_IN_USE', 'PROFILE_NOT_READY',
    'PROFILE_SECRET_REQUIRED', 'PROFILE_SECRET_UNAVAILABLE',
    'PROFILE_REVISION_NOT_FOUND', 'PROFILE_FILE_MISSING',
    'PROFILE_FILE_DRIFTED', 'PROFILE_FILE_NOT_OWNED',
    'PROFILE_PERSISTENCE_PENDING', 'PROFILE_ADAPTER_UNAVAILABLE',
    'PROFILE_READ_ONLY'
  ])
  const candidate = typeof error?.code === 'string' ? error.code : ''
  const code = candidate.startsWith('INVALID_') || publicCodes.has(candidate)
    ? candidate
    : null
  if (!code) {
    return {
      code: 'PROFILE_OPERATION_FAILED',
      message: 'AI CLI profile operation failed'
    }
  }
  const messages = {
    PROFILE_NOT_FOUND: 'AI CLI profile was not found',
    PROFILE_IN_USE: 'AI CLI profile is still in use',
    PROFILE_NOT_READY: 'AI CLI profile is not ready',
    PROFILE_SECRET_REQUIRED: 'AI CLI profile secret is required',
    PROFILE_SECRET_UNAVAILABLE: 'AI CLI profile secret is unavailable',
    PROFILE_REVISION_NOT_FOUND: 'AI CLI profile revision was not found',
    PROFILE_FILE_MISSING: 'AI CLI profile file is missing',
    PROFILE_FILE_DRIFTED: 'AI CLI profile file was changed outside UCLI',
    PROFILE_FILE_NOT_OWNED: 'AI CLI profile file is not managed by UCLI',
    PROFILE_PERSISTENCE_PENDING: 'AI CLI profile changes are pending persistence',
    PROFILE_ADAPTER_UNAVAILABLE: 'AI CLI profile adapter is unavailable',
    PROFILE_READ_ONLY: 'Organization-provided AI CLI profiles are read-only'
  }
  return {
    code,
    message: messages[code] || (typeof error?.message === 'string' ? error.message : 'AI CLI profile operation failed')
  }
}
