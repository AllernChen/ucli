import assert from 'node:assert/strict'
import test from 'node:test'

import { modelStreamRequest } from './helpers/serverIntegrationSmoke.mjs'

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
