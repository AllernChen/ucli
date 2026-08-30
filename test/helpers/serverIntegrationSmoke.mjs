import {
  PUBLIC_MODEL_PROTOCOLS,
  localGatewayPathForProtocol
} from '../../electron/serverConnection/contracts.js'

export const SMOKE_STAGES = Object.freeze([
  'protocol-validation', 'link-validation', 'temporary-root', 'preview',
  'redeem-first', 'redeem-idempotent', 'refresh-forced', 'bootstrap',
  'local-proxy', 'gateway-models', 'model-directory', 'model-stream',
  'skills-catalog', 'skills-download', 'cleanup'
])

const SMOKE_STAGE_SET = new Set(SMOKE_STAGES)

function smokeDiagnostic(value) {
  const diagnostic = value && typeof value === 'object' ? value : {}
  const {
    httpStatus = 'not-received',
    contentType = 'not-received',
    cacheControl = 'not-received',
    stableCode = 'not-received',
    requestId = 'not-received',
    retryable = null
  } = diagnostic
  return { httpStatus, contentType, cacheControl, stableCode, requestId, retryable }
}

function smokeStage(value) {
  if (!SMOKE_STAGE_SET.has(value)) {
    throw Object.assign(new TypeError('Smoke stage is invalid'), { code: 'SMOKE_STAGE_INVALID' })
  }
  return value
}

export function modelStreamRequest(protocol, modelId) {
  if (!PUBLIC_MODEL_PROTOCOLS.includes(protocol)) {
    throw Object.assign(new TypeError('Smoke protocol is invalid'), { code: 'SMOKE_PROTOCOL_INVALID' })
  }
  const path = localGatewayPathForProtocol(protocol)
  if (protocol === 'openai_responses') {
    return { path, headers: {}, body: { model: modelId, input: 'ping', stream: true } }
  }
  if (protocol === 'openai_chat') {
    return {
      path,
      headers: {},
      body: { model: modelId, messages: [{ role: 'user', content: 'ping' }], stream: true }
    }
  }
  return {
    path,
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], stream: true }
  }
}

export function smokeFailure({ primaryError = null, cleanupErrors = [], diagnostic } = {}) {
  const failedStage = cleanupErrors.length > 0 ? 'cleanup' : smokeStage(primaryError?.failedStage)
  return Object.assign(new Error('Server smoke failed'), {
    failedStage,
    diagnostic: smokeDiagnostic(diagnostic)
  })
}

export function enterSmokeStage(stage, priorDiagnostic) {
  const failedStage = smokeStage(stage)
  return {
    failedStage,
    diagnostic: smokeDiagnostic(failedStage === 'skills-catalog' ? undefined : priorDiagnostic)
  }
}

export function smokeSuccessEvidence({ evidence, diagnostic, cleanupComplete = false } = {}) {
  if (!cleanupComplete) {
    throw Object.assign(new Error('Smoke cleanup is incomplete'), { code: 'SMOKE_CLEANUP_INCOMPLETE' })
  }
  return {
    selectedModelId: evidence?.selectedModelId,
    selectedProtocol: evidence?.selectedProtocol,
    bootstrapModelCount: evidence?.bootstrapModelCount,
    invalidContextSizeCount: evidence?.invalidContextSizeCount,
    authorizationExpiresAt: evidence?.authorizationExpiresAt,
    serverTimePresent: evidence?.serverTimePresent,
    streamReceivedNonEmptyData: evidence?.streamReceivedNonEmptyData,
    skillsCatalog: evidence?.skillsCatalog,
    skillDownloadHash: evidence?.skillDownloadHash,
    skillInstalledOrExecuted: false,
    tempDatabaseRemoved: evidence?.tempDatabaseRemoved,
    environmentVariablesRemoved: evidence?.environmentVariablesRemoved,
    smokeDirectoriesRemoved: evidence?.smokeDirectoriesRemoved,
    modelResponseDiagnostic: smokeDiagnostic(diagnostic)
  }
}
