import assert from 'node:assert/strict'
import test from 'node:test'

import { modelStreamRequest, smokeFailure } from './helpers/serverIntegrationSmoke.mjs'

test('builds minimal stream requests for every public model protocol', () => {
  assert.deepEqual(modelStreamRequest('openai_responses', 'model-1'), {
    path: '/v1/responses',
    headers: {},
    body: { model: 'model-1', input: 'ping', stream: true }
  })
  assert.equal(modelStreamRequest('openai_chat', 'model-1').path, '/v1/chat/completions')
  assert.equal(modelStreamRequest('anthropic_messages', 'model-1').headers['anthropic-version'], '2023-06-01')
  assert.throws(() => modelStreamRequest('gemini', 'model-1'), { code: 'SMOKE_PROTOCOL_INVALID' })
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
