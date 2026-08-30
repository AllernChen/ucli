import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SMOKE_STAGES,
  enterSmokeStage,
  modelStreamRequest,
  smokeFailure,
  smokeSuccessEvidence
} from './helpers/serverIntegrationSmoke.mjs'

test('builds minimal stream requests for every public model protocol', () => {
  assert.deepEqual(modelStreamRequest('openai_responses', 'model-1'), {
    path: '/v1/responses',
    headers: {},
    body: { model: 'model-1', input: 'ping', stream: true }
  })
  assert.deepEqual(modelStreamRequest('openai_chat', 'model-1'), {
    path: '/v1/chat/completions',
    headers: {},
    body: { model: 'model-1', messages: [{ role: 'user', content: 'ping' }], stream: true }
  })
  assert.deepEqual(modelStreamRequest('anthropic_messages', 'model-1'), {
    path: '/anthropic/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model: 'model-1', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], stream: true }
  })
  assert.throws(() => modelStreamRequest('gemini', 'model-1'), { code: 'SMOKE_PROTOCOL_INVALID' })
})

test('smoke evidence has one allowlisted stage vocabulary and publishes a normalized success diagnostic only after cleanup', () => {
  assert.deepEqual(SMOKE_STAGES, [
    'protocol-validation', 'link-validation', 'temporary-root', 'preview',
    'redeem-first', 'redeem-idempotent', 'refresh-forced', 'bootstrap',
    'local-proxy', 'gateway-models', 'model-directory', 'model-stream',
    'skills-catalog', 'skills-download', 'cleanup'
  ])
  const evidence = {
    selectedModelId: 'model-1',
    selectedProtocol: 'openai_responses',
    bootstrapModelCount: 1,
    invalidContextSizeCount: 0,
    authorizationExpiresAt: null,
    serverTimePresent: true,
    streamReceivedNonEmptyData: true,
    skillsCatalog: true,
    skillDownloadHash: true,
    tempDatabaseRemoved: true,
    environmentVariablesRemoved: true,
    smokeDirectoriesRemoved: true
  }
  const diagnostic = {
    httpStatus: 200,
    contentType: 'text/event-stream',
    cacheControl: 'no-store',
    stableCode: 'not-received',
    requestId: 'safe-request-id',
    retryable: null,
    secret: 'must-not-publish'
  }
  assert.throws(() => smokeSuccessEvidence({ evidence, diagnostic, cleanupComplete: false }), {
    code: 'SMOKE_CLEANUP_INCOMPLETE'
  })
  assert.deepEqual(smokeSuccessEvidence({ evidence, diagnostic, cleanupComplete: true }), {
    ...evidence,
    skillInstalledOrExecuted: false,
    modelResponseDiagnostic: {
      httpStatus: 200,
      contentType: 'text/event-stream',
      cacheControl: 'no-store',
      stableCode: 'not-received',
      requestId: 'safe-request-id',
      retryable: null
    }
  })
})

test('cleanup failures take precedence over an existing primary smoke failure without exposing either error', () => {
  const primaryError = Object.assign(new Error('primary smoke secret'), {
    failedStage: 'model-stream',
    stack: 'primary smoke stack secret',
    token: 'primary smoke token secret'
  })
  const cleanupError = Object.assign(new Error('cleanup smoke secret'), {
    stack: 'cleanup smoke stack secret',
    path: 'cleanup smoke path secret',
    token: 'cleanup smoke token secret'
  })
  const diagnostic = {
    httpStatus: 503,
    contentType: 'application/json',
    cacheControl: 'no-store',
    stableCode: 'upstream_unavailable',
    requestId: 'safe-request-id',
    retryable: true
  }

  const error = smokeFailure({
    primaryError,
    cleanupErrors: [cleanupError],
    diagnostic
  })

  assert.equal(error.failedStage, 'cleanup')
  assert.deepEqual(error.diagnostic, diagnostic)
  assert.deepEqual(Object.keys(error).sort(), ['diagnostic', 'failedStage'])
  const serialised = JSON.stringify({ message: error.message, stack: error.stack, ...error })
  for (const unsafe of [
    'primary smoke secret',
    'primary smoke stack secret',
    'primary smoke token secret',
    'cleanup smoke secret',
    'cleanup smoke stack secret',
    'cleanup smoke path secret',
    'cleanup smoke token secret'
  ]) assert.equal(serialised.includes(unsafe), false)
})

test('primary smoke failures expose only an allowlisted stage and diagnostic envelope', () => {
  const error = smokeFailure({
    primaryError: { failedStage: 'model-stream' },
    diagnostic: {
      httpStatus: 503,
      contentType: 'application/json',
      cacheControl: 'no-store',
      stableCode: 'upstream_unavailable',
      requestId: 'safe-request-id',
      retryable: true,
      responseBody: 'must-not-publish'
    }
  })
  assert.equal(error.failedStage, 'model-stream')
  assert.deepEqual(error.diagnostic, {
    httpStatus: 503,
    contentType: 'application/json',
    cacheControl: 'no-store',
    stableCode: 'upstream_unavailable',
    requestId: 'safe-request-id',
    retryable: true
  })
  assert.deepEqual(Object.keys(error).sort(), ['diagnostic', 'failedStage'])
})

test('entering the Skills catalog stage discards the prior model response diagnostic', () => {
  const modelResponseDiagnostic = {
    httpStatus: 200,
    contentType: 'text/event-stream; charset=utf-8',
    cacheControl: 'no-store',
    stableCode: 'not-received',
    requestId: 'model-stream-request-id',
    retryable: null
  }

  assert.deepEqual(enterSmokeStage('skills-catalog', modelResponseDiagnostic), {
    failedStage: 'skills-catalog',
    diagnostic: {
      httpStatus: 'not-received',
      contentType: 'not-received',
      cacheControl: 'not-received',
      stableCode: 'not-received',
      requestId: 'not-received',
      retryable: null
    }
  })
})
