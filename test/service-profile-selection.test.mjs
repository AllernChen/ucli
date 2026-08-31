import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compatibleModelsForAdapter,
  describeModelProtocols,
  validateServiceProfileSelection
} from '../src/serviceProfileSelection.js'

const profile = {
  id: 'https://server.example.test::org-1',
  availabilityStatus: 'ready',
  models: [
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'], availabilityStatus: 'ready' },
    { id: 'chat', displayName: 'Chat only', contextSize: 64000, protocols: ['openai_chat'], availabilityStatus: 'ready' },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'], availabilityStatus: 'ready' },
    { id: 'unavailable', displayName: 'Unavailable', contextSize: 32000, protocols: ['openai_responses'], availabilityStatus: 'unreachable' }
  ]
}

test('filters compatible service models in catalog order without selecting a default', () => {
  assert.deepEqual(compatibleModelsForAdapter(profile, 'codex').map(model => model.id), ['responses', 'unavailable'])
  assert.deepEqual(compatibleModelsForAdapter(profile, 'claude').map(model => model.id), ['claude'])
  assert.deepEqual(compatibleModelsForAdapter(profile, 'opencode'), [])
  assert.equal(compatibleModelsForAdapter(profile, 'codex').defaultModel, undefined)
  assert.equal(compatibleModelsForAdapter(profile, 'codex').some(model => model.id === 'chat'), false)
})

test('validates an exact available model against the current adapter protocol', () => {
  assert.deepEqual(validateServiceProfileSelection({ profile, adapterId: 'codex', modelId: null }), {
    valid: false, reason: 'model-required'
  })
  assert.deepEqual(validateServiceProfileSelection({ profile, adapterId: 'codex', modelId: 'removed' }), {
    valid: false, reason: 'model-unavailable'
  })
  assert.deepEqual(validateServiceProfileSelection({ profile, adapterId: 'codex', modelId: 'unavailable' }), {
    valid: false, reason: 'model-unavailable'
  })
  assert.deepEqual(validateServiceProfileSelection({ profile, adapterId: 'codex', modelId: 'chat' }), {
    valid: false, reason: 'protocol-unavailable'
  })
  assert.deepEqual(validateServiceProfileSelection({ profile, adapterId: 'codex', modelId: 'responses' }), {
    valid: true,
    model: profile.models.find(model => model.id === 'responses')
  })
})

test('describes only approved public protocols in declared order', () => {
  assert.equal(describeModelProtocols(['openai_responses', 'openai_chat', 'anthropic_messages']), 'OpenAI Responses · OpenAI Chat · Anthropic Messages')
  assert.equal(describeModelProtocols(['unknown', 'anthropic_messages']), 'Anthropic Messages')
  assert.equal(describeModelProtocols([]), '未声明协议')
})
