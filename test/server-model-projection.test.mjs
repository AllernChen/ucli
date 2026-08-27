import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createServerModelProjection } from '../electron/serverConnection/modelProjection.js'
import * as codexProfileFiles from '../electron/aiCliProfiles/codexProfileFile.js'
import { createProfileService } from '../electron/aiCliProfiles/profileService.js'
import { sanitiseProfileError } from '../electron/aiCliProfiles/contracts.js'

function harness() {
  let stored = []
  const calls = { create: [], revoke: [] }
  const projection = createServerModelProjection({
    db: {
      listServerModelProfiles: () => stored,
      replaceServerModelProfiles: ({ profiles }) => { stored = profiles.map(profile => ({ ...profile })) }
    },
    proxy: {
      getRuntimeConnectionIdentity: () => ({ connectionId: 'connection-1', connectionRevision: 7 }),
      createServerGatewaySession: connection => {
        calls.create.push(connection)
        return { baseUrl: 'http://127.0.0.1:43210', bearer: 'session-bearer' }
      },
      revokeServerGatewaySession: sessionId => calls.revoke.push(sessionId)
    },
    codexProfileFiles: {
      renderServerCodexProfileFile: profile => `# ucli-server-profile-id: ${profile.id}\n`
    }
  })
  return { projection, calls, get stored() { return stored } }
}

test('projects every Bootstrap model into stable Codex Responses and Claude Bearer profiles', () => {
  const context = harness()
  const input = {
    serverOrigin: 'HTTP://server.example.test:80/',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000 }],
    connectionRevision: 7
  }

  context.projection.reconcile(input)
  const first = context.projection.listProfiles()
  context.projection.reconcile({ ...input, serverOrigin: 'http://server.example.test' })
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

test('prepares runtime only for current ready profiles and revokes replaced session authority', () => {
  const context = harness()
  context.projection.reconcile({
    serverOrigin: 'http://server.example.test',
    organization: { id: 'org-1', name: 'Engineering' },
    models: [{ id: 'model-1', displayName: 'Gateway Model', contextSize: 128000 }],
    connectionRevision: 7
  })
  const codex = context.projection.listProfiles().find(profile => profile.adapterId === 'codex')
  const launch = context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-1' })
  assert.equal(launch.env.UCLI_SERVER_BEARER, 'session-bearer')
  assert.equal(context.calls.create.length, 1)

  context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-1' })
  assert.deepEqual(context.calls.revoke, ['session-1'])
  context.projection.clearOnlineState(8)
  assert.throws(
    () => context.projection.prepareRuntime({ profileId: codex.id, sessionId: 'session-2' }),
    { code: 'PROFILE_NOT_READY' }
  )
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
    serverModelProjection: { listProfiles: () => [server] },
    flush: () => true
  })

  assert.equal(service.listProfiles({ adapterId: 'codex' })[0].id, server.id)
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
})
