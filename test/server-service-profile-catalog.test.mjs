import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildServiceProfileCatalog,
  compatibleServiceModels,
  requireServiceModel,
  serviceModelArtifactId,
  stableServiceProfileId,
} from '../electron/serverConnection/serviceProfileCatalog.js'

test('model artifact identity is a deterministic 32-character lowercase hex value', () => {
  const input = { serviceProfileId: 'http://server::org', modelId: 'model-a' }
  const first = serviceModelArtifactId(input)
  assert.match(first, /^[0-9a-f]{32}$/)
  assert.equal(first, serviceModelArtifactId(input))
  assert.notEqual(first, serviceModelArtifactId({ ...input, modelId: 'model-b' }))
  assert.notEqual(
    serviceModelArtifactId({ serviceProfileId: 'http://server::org::model', modelId: 'x' }),
    serviceModelArtifactId({ serviceProfileId: 'http://server::org', modelId: 'model::x' }),
  )
})

test('service profile identity rejects non-HTTP(S) origins', () => {
  for (const serverOrigin of ['file:///a', 'data:text/plain,hello', 'mailto:ops@example.com']) {
    assert.throws(() => stableServiceProfileId({ serverOrigin, organizationId: 'org-1' }))
  }
})

test('service profile identity excludes model and adapter', () => {
  const left = stableServiceProfileId({
    serverOrigin: 'HTTP://10.44.100.100/',
    organizationId: 'org-1',
  })
  const right = stableServiceProfileId({
    serverOrigin: 'http://10.44.100.100',
    organizationId: 'org-1',
  })
  assert.equal(left, right)
})

test('catalog retains all declared public protocols without inventing compatibility', () => {
  const catalog = buildServiceProfileCatalog({
    serverOrigin: 'http://10.44.100.100',
    organization: { id: 'org-1', name: 'Product R&D' },
    connectionRevision: 'revision-1',
    models: [
      { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'] },
      { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] },
    ],
  })
  assert.deepEqual(catalog.profile.supportedAdapterIds, ['codex', 'claude'])
  assert.deepEqual(catalog.models.map((model) => model.protocols), [
    ['openai_responses'],
    ['openai_chat'],
    ['anthropic_messages'],
  ])
})

test('service model selection requires an available model compatible with the adapter', () => {
  const profile = buildServiceProfileCatalog({
    serverOrigin: 'http://10.44.100.100',
    organization: { id: 'org-1', name: 'Product R&D' },
    connectionRevision: 'revision-1',
    models: [
      { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] },
    ],
  })
  assert.deepEqual(compatibleServiceModels(profile, 'codex').map((model) => model.id), ['responses'])
  assert.throws(
    () => requireServiceModel(profile, { adapterId: 'codex', modelId: null }),
    (error) => error.code === 'PROFILE_MODEL_REQUIRED',
  )
  assert.throws(
    () => requireServiceModel(profile, { adapterId: 'codex', modelId: 'removed' }),
    (error) => error.code === 'PROFILE_MODEL_UNAVAILABLE',
  )
  assert.throws(
    () => requireServiceModel(profile, { adapterId: 'claude', modelId: 'responses' }),
    (error) => error.code === 'PROFILE_MODEL_PROTOCOL_UNAVAILABLE',
  )
})

test('catalog validates model capabilities and preserves declared protocol order', () => {
  const catalog = buildServiceProfileCatalog({
    serverOrigin: 'http://10.44.100.100',
    organization: { id: 'org-1' },
    models: [{ id: 'mixed', displayName: 'Mixed', contextSize: 1, protocols: ['openai_chat', 'openai_chat', 'openai_responses'] }],
  })
  assert.deepEqual(catalog.models[0].protocols, ['openai_chat', 'openai_responses'])
  assert.throws(
    () => buildServiceProfileCatalog({ serverOrigin: 'http://example.com', organization: { id: 'org' }, models: [{ id: 'bad', displayName: 'Bad', contextSize: 0, protocols: ['openai_chat'] }] }),
    (error) => error.code === 'INVALID_SERVER_MODEL',
  )
  assert.throws(
    () => buildServiceProfileCatalog({ serverOrigin: 'http://example.com', organization: { id: 'org' }, models: [{ id: 'bad', displayName: 'Bad', contextSize: 1, protocols: ['unknown'] }] }),
    (error) => error.code === 'INVALID_SERVER_MODEL',
  )
})
