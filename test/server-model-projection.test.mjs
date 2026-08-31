import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createServerModelProjection } from '../electron/serverConnection/modelProjection.js'
import * as codexProfileFiles from '../electron/aiCliProfiles/codexProfileFile.js'
import { buildServiceProfileCatalog } from '../electron/serverConnection/serviceProfileCatalog.js'
import { createProfileService } from '../electron/aiCliProfiles/profileService.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function harness({ flush = () => true, fileOps, resolveCodexHome } = {}) {
  let profiles = []
  let models = []
  let identity = { connectionId: 'connection-1', connectionRevision: 7 }
  const calls = { create: [], revoke: [], artifacts: [] }
  const defaultFileOps = {
    serverCodexNativeProfileName: (artifactId) => `ucli-server-${artifactId}`,
    serverCodexProfileSecretEnvName: () => 'UCLI_SERVER_BEARER',
    writeServerCodexProfileFileAtomic: ({ profile }) => ({
      path: `C:\\codex\\ucli-server-${profile.id}.config.toml`,
      sha256: 'a'.repeat(64)
    })
  }
  const db = {
      listServerServiceProfiles: () => profiles.map((profile) => ({ ...profile })),
      listServerServiceModels: (serviceProfileId = null) => models
        .filter((model) => serviceProfileId == null || model.serviceProfileId === serviceProfileId)
        .map((model) => ({ ...model, protocols: [...model.protocols] })),
      replaceServerServiceCatalog: ({ profile, models: nextModels }) => {
        profiles = [...profiles.filter((candidate) => candidate.profileId !== profile.id), {
          profileId: profile.id,
          serverOrigin: profile.serverOrigin,
          organizationId: profile.organization.id,
          organizationName: profile.organization.name,
          connectionRevision: profile.connectionRevision,
          availabilityStatus: profile.availabilityStatus
        }]
        models = [
          ...models.filter((candidate) => candidate.serviceProfileId !== profile.id),
          ...nextModels.map((model, catalogOrder) => ({
            serviceProfileId: profile.id,
            serverOrigin: profile.serverOrigin,
            organizationId: profile.organization.id,
            organizationName: profile.organization.name,
            connectionRevision: profile.connectionRevision,
            modelId: model.id,
            displayName: model.displayName,
            contextSize: model.contextSize,
            protocols: [...model.protocols],
            availabilityStatus: model.availabilityStatus,
            catalogOrder,
            codexFileSha256: model.codexFileSha256 ?? null
          }))
        ]
      },
      updateServerServiceModelArtifact: ({ serviceProfileId, modelId, codexFileSha256 }) => {
        calls.artifacts.push({ serviceProfileId, modelId, codexFileSha256 })
        models = models.map((model) => model.serviceProfileId === serviceProfileId && model.modelId === modelId
          ? { ...model, codexFileSha256 }
          : model)
        return true
      }
    }
  const projection = createServerModelProjection({
    db,
    proxy: {
      getRuntimeConnectionIdentity: () => identity,
      createServerGatewaySession: (connection) => {
        calls.create.push(connection)
        return { baseUrl: 'http://127.0.0.1:43210', bearer: 'session-bearer' }
      },
      revokeServerGatewaySession: (sessionId) => calls.revoke.push(sessionId)
    },
    codexProfileFiles: fileOps || defaultFileOps,
    resolveCodexHome: resolveCodexHome || (() => 'C:\\codex'),
    flush
  })
  return {
    projection,
    calls,
    async sync(input) {
      const catalog = buildServiceProfileCatalog(input)
      db.replaceServerServiceCatalog({
        profile: { ...catalog.profile, availabilityStatus: 'ready' },
        models: catalog.models.map((model) => ({ ...model, availabilityStatus: 'ready' }))
      })
      return projection.reconcileRuntimeAuthorities({
        serviceProfileId: catalog.profile.id,
        connectionRevision: input.connectionRevision,
        models: input.models
      })
    },
    setIdentity(value) { identity = value },
    get stored() { return { profiles, models } }
  }
}

function catalog(models, connectionRevision = 7) {
  return {
    serverOrigin: 'HTTP://server.example.test:80/',
    organization: { id: 'org-1', name: 'Engineering' },
    models,
    connectionRevision
  }
}

test('synchronizes models into one cross-adapter service profile DTO', async () => {
  const context = harness()
  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
    { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'] },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] }
  ]))

  const profiles = context.projection.listProfiles()
  assert.equal(profiles.length, 1)
  assert.deepEqual(profiles[0].supportedAdapterIds, ['codex', 'claude'])
  assert.deepEqual(profiles[0].models.map(({ id, protocols }) => ({ id, protocols })), [
    { id: 'responses', protocols: ['openai_responses'] },
    { id: 'chat', protocols: ['openai_chat'] },
    { id: 'claude', protocols: ['anthropic_messages'] }
  ])
  assert.equal(profiles[0].id, 'http://server.example.test::org-1')
  assert.equal(profiles[0].canStart, true)
})

test('prepareRuntime rejects a missing model and an adapter-incompatible model', async () => {
  const context = harness()
  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
    { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'] }
  ]))
  const serviceProfileId = context.projection.listProfiles()[0].id

  assert.throws(() => context.projection.prepareRuntime({
    serviceProfileId, modelId: 'missing', adapterId: 'codex', sessionId: 'missing-model'
  }), { code: 'PROFILE_MODEL_UNAVAILABLE' })
  assert.throws(() => context.projection.prepareRuntime({
    serviceProfileId, modelId: 'chat', adapterId: 'codex', sessionId: 'chat-model'
  }), { code: 'PROFILE_MODEL_PROTOCOL_UNAVAILABLE' })
})

test('launches explicitly selected Codex and Claude models using their adapter protocols', async () => {
  const context = harness()
  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] }
  ]))
  const serviceProfileId = context.projection.listProfiles()[0].id
  const codex = context.projection.prepareRuntime({
    serviceProfileId, modelId: 'responses', adapterId: 'codex', sessionId: 'codex-session'
  })
  const claude = context.projection.prepareRuntime({
    serviceProfileId, modelId: 'claude', adapterId: 'claude', sessionId: 'claude-session'
  })

  assert.deepEqual(codex.args.slice(-2), ['--model', 'responses'])
  assert.equal(codex.modelId, 'responses')
  assert.equal(codex.artifact.model, 'responses')
  assert.equal(codex.env.UCLI_SERVER_BEARER, 'session-bearer')
  assert.deepEqual(claude.args, ['--model', 'claude'])
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43210/anthropic')
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'session-bearer')
})

test('reconciliation keeps only authorities whose profile, model, protocol, and revision remain valid', async () => {
  const context = harness()
  const initial = catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] }
  ])
  await context.sync(initial)
  const serviceProfileId = context.projection.listProfiles()[0].id
  context.projection.prepareRuntime({ serviceProfileId, modelId: 'responses', adapterId: 'codex', sessionId: 'codex-session' })
  context.projection.prepareRuntime({ serviceProfileId, modelId: 'claude', adapterId: 'claude', sessionId: 'claude-session' })

  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['anthropic_messages'] },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] }
  ]))
  assert.deepEqual(context.calls.revoke, ['codex-session'])

  context.setIdentity({ connectionId: 'connection-2', connectionRevision: 8 })
  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['anthropic_messages'] },
    { id: 'claude', displayName: 'Claude', contextSize: 200000, protocols: ['anthropic_messages'] }
  ], 8))
  assert.deepEqual(context.calls.revoke, ['codex-session', 'claude-session'])
})

test('reconciliation revokes authorities from a replaced service profile identity', async () => {
  const context = harness()
  await context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] }
  ]))
  const previousProfileId = context.projection.listProfiles()[0].id
  context.projection.prepareRuntime({
    serviceProfileId: previousProfileId, modelId: 'responses', adapterId: 'codex', sessionId: 'previous-profile'
  })

  await context.sync({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-2', name: 'Product' },
    models: [{ id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] }],
    connectionRevision: 7
  })
  assert.deepEqual(context.calls.revoke, ['previous-profile'])
})

test('same-revision connection replacement retains a valid selected-model authority', async () => {
  const context = harness()
  const input = catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] }
  ])
  await context.sync(input)
  const serviceProfileId = context.projection.listProfiles()[0].id
  context.projection.prepareRuntime({
    serviceProfileId, modelId: 'responses', adapterId: 'codex', sessionId: 'same-revision'
  })

  context.setIdentity({ connectionId: 'connection-replaced', connectionRevision: 7 })
  await context.sync(input)
  assert.deepEqual(context.calls.revoke, [])
})

test('Codex creates independent per-model artifacts and cleans only stale owned files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-model-'))
  try {
    const context = harness({ fileOps: codexProfileFiles, resolveCodexHome: () => root })
    await context.sync(catalog([
      { id: 'responses-a', displayName: 'Responses A', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'responses-b', displayName: 'Responses B', contextSize: 128000, protocols: ['openai_responses'] }
    ]))
    const serviceProfileId = context.projection.listProfiles()[0].id
    const first = context.projection.prepareRuntime({
      serviceProfileId, modelId: 'responses-a', adapterId: 'codex', sessionId: 'first'
    })
    const second = context.projection.prepareRuntime({
      serviceProfileId, modelId: 'responses-b', adapterId: 'codex', sessionId: 'second'
    })

    assert.notEqual(first.configPath, second.configPath)
    assert.notEqual(first.artifactId, second.artifactId)
    assert.equal(first.modelId, 'responses-a')
    assert.equal(second.modelId, 'responses-b')
    assert.equal(readFileSync(first.configPath, 'utf8').includes('session-bearer'), false)
    assert.deepEqual(context.calls.artifacts.map(({ modelId }) => modelId), ['responses-a', 'responses-b'])
    await context.sync(catalog([
      { id: 'responses-a', displayName: 'Responses A', contextSize: 128000, protocols: ['openai_responses'] }
    ]))
    assert.equal(existsSync(first.configPath), true)
    assert.equal(existsSync(second.configPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed persistence leaves the catalog fail-closed', async () => {
  const context = harness({ flush: () => false })
  await assert.rejects(() => context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] }
  ])), { code: 'PROFILE_PERSISTENCE_PENDING' })
  assert.deepEqual(context.projection.listProfiles().map(({ status, canStart }) => ({ status, canStart })), [
    { status: 'unreachable', canStart: false }
  ])
})

test('reconciliation remains fail-closed while catalog persistence is pending', async () => {
  const hold = deferred()
  const context = harness({ flush: () => hold.promise })
  const pending = context.sync(catalog([
    { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] }
  ]))
  assert.deepEqual(context.projection.listProfiles().map((profile) => profile.canStart), [false])
  hold.resolve(true)
  await pending
  assert.deepEqual(context.projection.listProfiles().map((profile) => profile.canStart), [true])
})

test('profile service forwards the persisted session model and explicit adapter to server runtime preparation', () => {
  const calls = []
  const serviceProfile = {
    id: 'http://server.example.test::org-1',
    sourceKind: 'server',
    readOnly: true,
    supportedAdapterIds: ['codex', 'claude'],
    models: [],
    status: 'ready',
    canStart: true
  }
  const service = createProfileService({
    db: { listAiCliProfiles: () => [] },
    secretStore: {},
    resolveCodexHome: () => 'C:\\codex',
    readCodexRuntime: () => ({}),
    fileOps: {},
    serverModelProjection: {
      listProfiles: () => [serviceProfile],
      prepareRuntime(options) {
        calls.push(options)
        return { status: 'ready' }
      }
    },
    flush: () => true
  })

  service.resolveCodexLaunchProfile(serviceProfile.id, { id: 'codex-session', model: 'responses' })
  service.resolveLaunchProfile({
    profileId: serviceProfile.id,
    adapterId: 'claude',
    session: { id: 'claude-session', model: 'claude' }
  })
  assert.deepEqual(calls, [
    { serviceProfileId: serviceProfile.id, modelId: 'responses', adapterId: 'codex', sessionId: 'codex-session' },
    { serviceProfileId: serviceProfile.id, modelId: 'claude', adapterId: 'claude', sessionId: 'claude-session' }
  ])
})
