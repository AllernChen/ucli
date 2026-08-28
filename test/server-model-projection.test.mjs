import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createServerModelProjection } from '../electron/serverConnection/modelProjection.js'
import * as codexProfileFiles from '../electron/aiCliProfiles/codexProfileFile.js'
import { createProfileService } from '../electron/aiCliProfiles/profileService.js'
import { sanitiseProfileError } from '../electron/aiCliProfiles/contracts.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function harness({ flush = () => true, fileOps, resolveCodexHome } = {}) {
  let stored = []
  let identity = { connectionId: 'connection-1', connectionRevision: 7 }
  const calls = { create: [], revoke: [] }
  const projection = createServerModelProjection({
    db: {
      listServerModelProfiles: () => stored,
      replaceServerModelProfiles: ({ profiles }) => { stored = profiles.map(profile => ({ ...profile })) }
    },
    proxy: {
      getRuntimeConnectionIdentity: () => identity,
      createServerGatewaySession: connection => {
        calls.create.push(connection)
        return { baseUrl: 'http://127.0.0.1:43210', bearer: 'session-bearer' }
      },
      revokeServerGatewaySession: sessionId => calls.revoke.push(sessionId)
    },
    codexProfileFiles: fileOps || {
      renderServerCodexProfileFile: profile => `# ucli-server-profile-id: ${profile.id}\n`
    },
    resolveCodexHome,
    flush
  })
  return {
    projection,
    calls,
    setIdentity(value) { identity = value },
    get stored() { return stored }
  }
}

test('projects every Bootstrap model into stable Codex Responses and Claude Bearer profiles', async () => {
  const context = harness()
  const input = {
    serverOrigin: 'HTTP://server.example.test:80/',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }

  await context.projection.reconcile(input)
  const first = context.projection.listProfiles()
  await context.projection.reconcile({ ...input, serverOrigin: 'http://server.example.test' })
  const second = context.projection.listProfiles()

  assert.equal(first.length, 2)
  assert.deepEqual([...first.map(profile => profile.adapterId)].sort(), ['claude', 'codex'])
  assert.deepEqual(first.map(profile => profile.id), second.map(profile => profile.id))
  assert.deepEqual(first.map(profile => profile.sourceKind), ['server', 'server'])
  assert.deepEqual(first.map(profile => profile.readOnly), [true, true])
  assert.deepEqual(first.map(profile => profile.organizationName), ['Engineering', 'Engineering'])
  assert.deepEqual(first.map(profile => profile.contextWindow), [128000, 128000])
  assert.equal(first.find(profile => profile.adapterId === 'codex').config.wireApi, 'responses')
  assert.equal(first.find(profile => profile.adapterId === 'claude').config.connectionMode, 'bearer')
})

test('projects only adapters supported by each model protocol set', async () => {
  const context = harness()
  await context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [
      { id: 'responses', displayName: 'Responses', contextSize: 128000, protocols: ['openai_responses'] },
      { id: 'anthropic', displayName: 'Anthropic', contextSize: 128000, protocols: ['anthropic_messages'] },
      { id: 'chat', displayName: 'Chat', contextSize: 64000, protocols: ['openai_chat'] }
    ],
    connectionRevision: 7
  })
  assert.deepEqual(context.projection.listProfiles()
    .map(profile => [profile.model, profile.adapterId])
    .sort(([leftModel, leftAdapter], [rightModel, rightAdapter]) => (
      leftModel.localeCompare(rightModel) || leftAdapter.localeCompare(rightAdapter)
    )), [
    ['anthropic', 'claude'],
    ['responses', 'codex']
  ])
})

test('projects both adapters for models that support both managed protocols', async () => {
  const context = harness()
  await context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{
      id: 'multi-protocol',
      displayName: 'Multi-protocol',
      contextSize: 128000,
      protocols: ['openai_responses', 'anthropic_messages']
    }],
    connectionRevision: 7
  })
  assert.deepEqual(context.projection.listProfiles().map(profile => profile.adapterId).sort(), ['claude', 'codex'])
})

test('rejects missing, empty, unknown, and gemini model protocol sets', async () => {
  for (const protocols of [undefined, [], ['unknown'], ['gemini']]) {
    const context = harness()
    const model = { id: 'model-1', displayName: 'Gateway Model', contextSize: 128000 }
    if (protocols !== undefined) model.protocols = protocols
    await assert.rejects(() => context.projection.reconcile({
      serverOrigin: 'http://server.example.test',
      organization: { id: 'org-1', name: 'Engineering' },
      models: [model],
      connectionRevision: 7
    }), { code: 'INVALID_SERVER_MODEL' })
  }
})

test('revokes removed Codex authority while retaining compatible Claude profile', async () => {
  const context = harness()
  const input = {
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{
      id: 'model-1',
      displayName: 'Gateway Model',
      contextSize: 128000,
      protocols: ['openai_responses', 'anthropic_messages']
    }],
    connectionRevision: 7
  }
  await context.projection.reconcile(input)
  const codex = context.projection.listProfiles().find(profile => profile.adapterId === 'codex')
  const claude = context.projection.listProfiles().find(profile => profile.adapterId === 'claude')
  context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'codex-session' })

  await context.projection.reconcile({
    ...input,
    models: [{ ...input.models[0], protocols: ['anthropic_messages'] }]
  })

  assert.deepEqual(context.calls.revoke, ['codex-session'])
  assert.deepEqual(context.projection.listProfiles().map(profile => [profile.id, profile.adapterId]), [
    [claude.id, 'claude']
  ])
})

test('prepares runtime only for current ready profiles and revokes replaced session authority', async () => {
  const context = harness()
  await context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  })
  const codex = context.projection.listProfiles().find(profile => profile.adapterId === 'codex')
  const launch = context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-1' })
  assert.equal(launch.env.UCLI_SERVER_BEARER, 'session-bearer')
  assert.equal(context.calls.create.length, 1)

  context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-1' })
  assert.deepEqual(context.calls.revoke, ['session-1'])
  await context.projection.clearOnlineState(8)
  assert.throws(
    () => context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-2' }),
    { code: 'PROFILE_NOT_READY' }
  )
})

test('Claude server runtime targets the proxy Anthropic route', async () => {
  const context = harness()
  await context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  })
  const claude = context.projection.listProfiles().find(profile => profile.adapterId === 'claude')
  const launch = context.projection.prepareRuntime({ profileId: claude.id, sessionId: 'claude-session' })
  assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43210/anthropic')
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'session-bearer')
})

test('persisted ready profiles remain unavailable until the matching runtime identity is online', async () => {
  const context = harness()
  await context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  })
  context.setIdentity(null)
  assert.deepEqual(context.projection.listProfiles().map(profile => [profile.status, profile.canStart]), [
    ['unreachable', false], ['unreachable', false]
  ])
  context.setIdentity({ connectionId: 'connection-1', connectionRevision: 7 })
  assert.deepEqual(context.projection.listProfiles().map(profile => [profile.status, profile.canStart]), [
    ['ready', true], ['ready', true]
  ])
})

test('reconciliation revokes every tracked session before accepting a new connection revision', async () => {
  const context = harness()
  const input = {
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }
  await context.projection.reconcile(input)
  const profile = context.projection.listProfiles()[0]
  context.projection.prepareRuntime({ profileId: profile.id, sessionId: 'session-1' })
  context.setIdentity({ connectionId: 'connection-2', connectionRevision: 8 })
  await context.projection.reconcile({ ...input, connectionRevision: 8 })
  assert.deepEqual(context.calls.revoke, ['session-1'])
})

test('same-revision replacement identity revokes prior server sessions', async () => {
  const context = harness()
  const input = {
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }
  await context.projection.reconcile(input)
  context.projection.prepareRuntime({ profileId: context.projection.listProfiles()[0].id, sessionId: 'session-1' })
  context.setIdentity({ connectionId: 'connection-replaced', connectionRevision: 7 })
  await context.projection.reconcile(input)
  assert.deepEqual(context.calls.revoke, ['session-1'])
})

test('reconciliation revokes server sessions whose projected models were removed', async () => {
  const context = harness()
  const input = {
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }
  await context.projection.reconcile(input)
  context.projection.prepareRuntime({ profileId: context.projection.listProfiles()[0].id, sessionId: 'session-1' })
  await context.projection.reconcile({ ...input, models: [] })
  assert.deepEqual(context.calls.revoke, ['session-1'])
})

test('failed projection persistence leaves rows fail-closed and rejects reconciliation', async () => {
  const context = harness({ flush: () => false })
  await assert.rejects(() => context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }), { code: 'PROFILE_PERSISTENCE_PENDING' })
  assert.deepEqual(context.projection.listProfiles().map(profile => [profile.status, profile.canStart]), [
    ['unreachable', false], ['unreachable', false]
  ])
})

test('reconciliation remains fail-closed until held persistence succeeds or fails', async () => {
  const hold = deferred()
  const context = harness({ flush: () => hold.promise })
  const request = context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  })
  assert.deepEqual(context.projection.listProfiles().map(profile => profile.canStart), [false, false])
  hold.resolve(true)
  await request
  assert.deepEqual(context.projection.listProfiles().map(profile => profile.canStart), [true, true])

  const failed = deferred()
  const failedContext = harness({ flush: () => failed.promise })
  const failedRequest = failedContext.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  })
  assert.deepEqual(failedContext.projection.listProfiles().map(profile => profile.canStart), [false, false])
  failed.reject(new Error('flush failure'))
  await assert.rejects(() => failedRequest, { code: 'PROFILE_PERSISTENCE_PENDING' })
  assert.deepEqual(failedContext.projection.listProfiles().map(profile => profile.canStart), [false, false])
})

test('rejects control-character organization and model identifiers so stable IDs cannot collide', async () => {
  const context = harness()
  await assert.rejects(() => context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'a', name: 'Engineering' },
    models: [{ id: 'b\u0000c', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }), { code: 'INVALID_SERVER_MODEL' })
  await assert.rejects(() => context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'a\u0000b', name: 'Engineering' },
    models: [{ id: 'c', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
    connectionRevision: 7
  }), { code: 'INVALID_SERVER_MODEL' })
})

test('server Codex files use an isolated namespace and never persist a session bearer', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-profile-'))
  try {
    const profile = {
      id: '0123456789abcdef0123456789abcdef',
      name: 'Organization Model',
      model: 'model-1',
      contextWindow: 128000
    }
    const written = codexProfileFiles.writeServerCodexProfileFileAtomic({
      codexHome: root,
      profile,
      baseUrl: 'http://127.0.0.1:43123',
      envKey: codexProfileFiles.serverCodexProfileSecretEnvName(profile.id)
    })
    const content = readFileSync(written.path, 'utf8')
    assert.equal(existsSync(written.path), true)
    assert.match(written.path, /ucli-server-0123456789abcdef0123456789abcdef\.config\.toml$/)
    assert.match(content, /^# ucli-server-profile-id: 0123456789abcdef0123456789abcdef$/m)
    assert.equal(content.includes('session-bearer'), false)
    assert.throws(() => codexProfileFiles.inspectCodexProfileFile(written.path), { code: 'PROFILE_FILE_NOT_OWNED' })
    assert.equal(codexProfileFiles.inspectServerCodexProfileFile(written.path).profileId, profile.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex runtime records only the generated server file digest in the projection row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-server-digest-'))
  try {
    const context = harness({ fileOps: codexProfileFiles, resolveCodexHome: () => root })
    await context.projection.reconcile({
      serverOrigin: 'http://server.example.test',
      organization: { id: 'org-1', name: 'Engineering' },
      models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
      connectionRevision: 7
    })
    const codex = context.projection.listProfiles().find(profile => profile.adapterId === 'codex')
    context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-digest' })
    const row = context.stored.find(profile => profile.profileId === codex.id)
    assert.match(row.codexFileSha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(row).includes('session-bearer'), false)
    assert.equal(JSON.stringify(row).includes('127.0.0.1'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime digest persistence rejects false, thrown, and asynchronous flushes before launch issuance', async () => {
  for (const flush of [
    () => false,
    () => { throw new Error('flush failure') },
    () => deferred().promise
  ]) {
    const fileOps = {
      serverCodexProfileSecretEnvName: () => 'UCLI_SERVER_PROFILE_0123456789ABCDEF0123456789ABCDEF',
      writeServerCodexProfileFileAtomic: () => ({ sha256: 'a'.repeat(64) })
    }
    let flushCalls = 0
    const context = harness({
      fileOps,
      resolveCodexHome: () => 'C:\\codex',
      flush: () => ++flushCalls === 1 ? true : flush()
    })
    await context.projection.reconcile({
      serverOrigin: 'http://server.example.test',
      organization: { id: 'org-1', name: 'Engineering' },
      models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000, protocols: ['openai_responses', 'anthropic_messages'] }],
      connectionRevision: 7
    })
    const codex = context.projection.listProfiles().find(profile => profile.adapterId === 'codex')
    assert.throws(() => context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'digest-session' }), {
      code: 'PROFILE_PERSISTENCE_PENDING'
    })
    assert.deepEqual(context.calls.revoke, ['digest-session'])
  }
})

test('profile service aggregates server profiles, allows binding, and rejects every server write', async () => {
  const server = {
    id: '0123456789abcdef0123456789abcdef',
    adapterId: 'codex',
    sourceKind: 'server',
    readOnly: true,
    status: 'ready',
    canStart: true,
    connectionRevision: 7
  }
  const bindings = []
  const releasedRuntimeIds = []
  const db = {
    listAiCliProfiles: () => [],
    listAiCliProfileBindings: ({ profileId } = {}) => profileId
      ? bindings.filter(binding => binding.profileId === profileId)
      : bindings,
    getAiCliProfile: () => null,
    upsertAiCliProfileBinding: binding => bindings.push(binding),
    getAiCliProfileBinding: (scopeType, scopeKey, adapterId) => bindings.find(binding => (
      binding.scopeType === scopeType && binding.scopeKey === scopeKey && binding.adapterId === adapterId
    )) || null,
    listAiCliProfileRevisions: () => []
  }
  const service = createProfileService({
    db,
    secretStore: {},
    resolveCodexHome: () => 'C:\\codex',
    readCodexRuntime: () => ({}),
    fileOps: {},
    serverModelProjection: {
      listProfiles: () => [server],
      releaseRuntime(sessionId) {
        releasedRuntimeIds.push(sessionId)
        return true
      }
    },
    flush: () => true
  })

  assert.equal(service.listProfiles({ adapterId: 'codex' })[0].id, server.id)
  assert.equal(service.releaseRuntime('summary-runtime-id'), true)
  assert.deepEqual(releasedRuntimeIds, ['summary-runtime-id'])
  await service.setBinding({ scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: server.id })
  const selection = service.resolveSessionProfile({ adapterId: 'codex', cwd: 'C:\\project' })
  assert.equal(selection.profileId, server.id)
  for (const action of [
    () => service.updateProfile(server.id, {}),
    () => service.replaceProfileSecret(server.id, 'must-not-store'),
    () => service.deleteProfileSecret(server.id),
    () => service.deleteProfile(server.id),
    () => service.repairProfile(server.id),
    () => service.rollbackProfile(server.id, 'revision-1')
  ]) {
    await assert.rejects(action, { code: 'PROFILE_READ_ONLY' })
  }
  assert.deepEqual(sanitiseProfileError({ code: 'PROFILE_READ_ONLY', message: 'secret' }), {
    code: 'PROFILE_READ_ONLY',
    message: 'Organization-provided AI CLI profiles are read-only'
  })

  const userOnlyService = createProfileService({
    db,
    secretStore: {},
    resolveCodexHome: () => 'C:\\codex',
    readCodexRuntime: () => ({}),
    fileOps: {},
    flush: () => true
  })
  assert.equal(userOnlyService.releaseRuntime('summary-runtime-id'), false)
})
