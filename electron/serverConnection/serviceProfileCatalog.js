import { createHash } from 'node:crypto'

export const SERVICE_ADAPTER_PROTOCOL = Object.freeze({
  codex: 'openai_responses',
  claude: 'anthropic_messages',
})

const ERROR_CODES = Object.freeze({
  invalidModel: 'INVALID_SERVER_MODEL',
  modelRequired: 'PROFILE_MODEL_REQUIRED',
  modelUnavailable: 'PROFILE_MODEL_UNAVAILABLE',
  protocolUnavailable: 'PROFILE_MODEL_PROTOCOL_UNAVAILABLE',
})

const PUBLIC_PROTOCOLS = Object.freeze(['openai_responses', 'openai_chat', 'anthropic_messages'])
const PUBLIC_PROTOCOL_SET = new Set(PUBLIC_PROTOCOLS)

function error(code, message) {
  const value = new Error(message)
  value.code = code
  return value
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw error(ERROR_CODES.invalidModel, `${name} must be a non-empty string`)
  }
  return value.trim()
}

function normalizedOrigin(serverOrigin) {
  try {
    const url = new URL(requiredText(serverOrigin, 'serverOrigin'))
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') {
      throw new Error('serverOrigin must use HTTP(S)')
    }
    return url.origin
  } catch (cause) {
    throw error(ERROR_CODES.invalidModel, 'serverOrigin must be a valid URL')
  }
}

export function stableServiceProfileId({ serverOrigin, organizationId }) {
  const origin = normalizedOrigin(serverOrigin)
  const organization = requiredText(organizationId, 'organizationId')
  return `${origin}::${organization}`
}

export function serviceModelArtifactId({ serviceProfileId, modelId }) {
  const profile = Buffer.from(requiredText(serviceProfileId, 'serviceProfileId'), 'utf8')
  const model = Buffer.from(requiredText(modelId, 'modelId'), 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(profile.length, 0)
  const modelLength = Buffer.allocUnsafe(4)
  modelLength.writeUInt32BE(model.length, 0)
  return createHash('sha256')
    .update(Buffer.concat([length, profile, modelLength, model]))
    .digest('hex')
    .slice(0, 32)
}

export function serviceRuntimeRevision({ connectionRevision, serviceProfileId, modelId, adapterId }) {
  return [connectionRevision, serviceProfileId, modelId, adapterId]
    .map((value) => value == null ? '' : String(value))
    .join(':')
}

function normalizeModel(model, serviceProfileId) {
  if (!model || typeof model !== 'object') {
    throw error(ERROR_CODES.invalidModel, 'model must be an object')
  }
  const id = requiredText(model.id, 'model.id')
  const displayName = requiredText(model.displayName, 'model.displayName')
  if (!Number.isSafeInteger(model.contextSize) || model.contextSize <= 0) {
    throw error(ERROR_CODES.invalidModel, `model ${id} contextSize must be a positive safe integer`)
  }
  if (!Array.isArray(model.protocols) || model.protocols.length === 0) {
    throw error(ERROR_CODES.invalidModel, `model ${id} protocols must be a non-empty array`)
  }
  const declaredProtocols = new Set()
  for (const protocol of model.protocols) {
    if (!PUBLIC_PROTOCOL_SET.has(protocol)) {
      throw error(ERROR_CODES.invalidModel, `model ${id} declares an unsupported protocol`)
    }
    declaredProtocols.add(protocol)
  }
  const protocols = PUBLIC_PROTOCOLS.filter((protocol) => declaredProtocols.has(protocol))
  return Object.freeze({
    id,
    displayName,
    contextSize: model.contextSize,
    protocols: Object.freeze(protocols),
    artifactId: serviceModelArtifactId({ serviceProfileId, modelId: id }),
  })
}

export function buildServiceProfileCatalog({ serverOrigin, organization, models, connectionRevision }) {
  const origin = normalizedOrigin(serverOrigin)
  if (!organization || typeof organization !== 'object') {
    throw error(ERROR_CODES.invalidModel, 'organization must be an object')
  }
  const organizationId = requiredText(organization.id, 'organization.id')
  if (!Array.isArray(models)) throw error(ERROR_CODES.invalidModel, 'models must be an array')
  const serviceProfileId = stableServiceProfileId({ serverOrigin: origin, organizationId })
  const normalizedModels = models.map((model) => normalizeModel(model, serviceProfileId))
  if (new Set(normalizedModels.map((model) => model.id)).size !== normalizedModels.length) {
    throw error(ERROR_CODES.invalidModel, 'model IDs must be unique')
  }
  const supportedAdapterIds = Object.keys(SERVICE_ADAPTER_PROTOCOL).filter((adapterId) =>
    normalizedModels.some((model) => model.protocols.includes(SERVICE_ADAPTER_PROTOCOL[adapterId])),
  )
  return Object.freeze({
    profile: Object.freeze({
      id: serviceProfileId,
      serverOrigin: origin,
      organization: Object.freeze({ ...organization, id: organizationId }),
      connectionRevision,
      supportedAdapterIds: Object.freeze(supportedAdapterIds),
    }),
    models: Object.freeze(normalizedModels),
  })
}

function catalogModels(profile) {
  return Array.isArray(profile?.models) ? profile.models : []
}

export function compatibleServiceModels(profile, adapterId) {
  const protocol = SERVICE_ADAPTER_PROTOCOL[adapterId]
  if (!protocol) return []
  return catalogModels(profile).filter((model) => model.protocols.includes(protocol))
}

export function requireServiceModel(profile, { adapterId, modelId }) {
  if (modelId == null || modelId === '') throw error(ERROR_CODES.modelRequired, 'A model is required')
  const model = catalogModels(profile).find((candidate) => candidate.id === modelId)
  if (!model) throw error(ERROR_CODES.modelUnavailable, `Model ${modelId} is unavailable`)
  const protocol = SERVICE_ADAPTER_PROTOCOL[adapterId]
  if (!protocol || !model.protocols.includes(protocol)) {
    throw error(ERROR_CODES.protocolUnavailable, `Model ${modelId} is unavailable for adapter ${adapterId}`)
  }
  return model
}
