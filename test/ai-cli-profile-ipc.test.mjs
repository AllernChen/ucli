import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { registerAiCliProfileIpc } from '../electron/aiCliProfiles/ipc.js'
import { stableServiceProfileId } from '../electron/serverConnection/serviceProfileCatalog.js'

function register(serviceOverrides = {}) {
  const handlers = new Map()
  const calls = []
  const profile = {
    id: 'profile-1', adapterId: 'codex', name: 'Work', kind: 'managed',
    providerId: 'ucli_profile_1', baseUrl: 'https://api.example.com/v1',
    model: 'gpt-5', hasSecret: true, secretSuffix: '1234', status: 'ready'
  }
  const service = {
    listCliConfigurationState: () => [{ adapterId: 'codex', mode: 'profiles', profileCount: 1 }],
    listProfiles: () => [profile],
    listServiceProfiles: () => [],
    createProfile: async (draft) => { calls.push(['create', draft]); return profile },
    updateProfile: async (...args) => { calls.push(['update', ...args]); return profile },
    replaceProfileSecret: async (...args) => { calls.push(['secret', ...args]); return profile },
    deleteProfileSecret: async (...args) => { calls.push(['deleteSecret', ...args]); return profile },
    deleteProfile: async (...args) => { calls.push(['delete', ...args]); return true },
    setBinding: async (binding) => { calls.push(['binding', binding]); return binding },
    listRevisions: () => [{
      id: 'revision-1', profileId: 'profile-1', reason: 'update', createdAt: 1,
      fileSha256: 'abc', config: { name: 'Old', baseUrl: 'https://old.example.com', secret: 'leak' },
      ciphertext: 'leak'
    }],
    rollbackProfile: async (...args) => { calls.push(['rollback', ...args]); return profile },
    repairProfile: async (...args) => { calls.push(['repair', ...args]); return profile },
    reconcileCodexProfiles: async () => ({ recovered: [], warnings: [] }),
    ...serviceOverrides
  }
  registerAiCliProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service,
    inspectCliTools: async () => [
      { id: 'codex', displayName: 'Codex', installed: true, version: '1.2.3', path: 'C:\\bin\\codex.exe', error: 'secret details' }
    ],
    getCodexRuntime: () => ({
      currentProvider: 'work',
      providerCatalog: [{ id: 'work', displayName: 'Work' }],
      configPath: 'C:\\Users\\me\\.codex\\config.toml',
      headers: { Authorization: 'Bearer leak' }
    })
  })
  return { handlers, calls }
}

test('profile IPC validates identifiers and whitelists renderer input', async () => {
  const { handlers, calls } = register()
  await assert.rejects(
    handlers.get('ai-cli-profiles:update')({}, '../profile', { name: 'Bad' }),
    { code: 'INVALID_PROFILE_IPC' }
  )
  await assert.rejects(
    handlers.get('ai-cli-profiles:set-secret')({}, 'profile-1', ''),
    { code: 'INVALID_PROFILE_IPC' }
  )

  await handlers.get('ai-cli-profiles:create')({}, {
    adapterId: 'codex', name: 'Work', kind: 'managed', providerId: 'work',
    baseUrl: 'https://api.example.com', model: 'gpt-5', secret: 'plain-key',
    path: 'C:\\forged\\config.toml', config: { env: 'leak' }, nativeProfileName: 'forged'
  })
  assert.deepEqual(calls[0], ['create', {
    adapterId: 'codex', name: 'Work', kind: 'managed', providerId: 'work',
    baseUrl: 'https://api.example.com', model: 'gpt-5',
    reasoningEffort: undefined, contextWindow: undefined, secret: 'plain-key'
  }])
  await handlers.get('ai-cli-profiles:update')({}, 'profile-1', {
    name: 'Renamed', path: 'C:\\forged\\profile.toml'
  })
  assert.deepEqual(calls[1], ['update', 'profile-1', { name: 'Renamed' }])

  await handlers.get('ai-cli-profiles:set-binding')({}, {
    scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: 'service-profile', model: 'responses'
  })
  assert.deepEqual(calls[2], ['binding', {
    scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: 'service-profile', model: 'responses'
  }])
  await handlers.get('ai-cli-profiles:set-binding')({}, {
    scopeType: 'project', scopeKey: 'F:\\projects\\demo', adapterId: 'codex', profileId: 'profile-1'
  })
  assert.deepEqual(calls[3], ['binding', {
    scopeType: 'project', scopeKey: 'F:\\projects\\demo', adapterId: 'codex', profileId: 'profile-1', model: null
  }])
  await assert.rejects(
    handlers.get('ai-cli-profiles:set-binding')({}, {
      scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: 'service-profile', model: '', revision: 'forged'
    }),
    { code: 'INVALID_PROFILE_IPC' }
  )
})

test('profile IPC serializes server profiles through an explicit redaction DTO', async () => {
  const serviceProfile = {
    id: 'service-profile', sourceKind: 'server', readOnly: true,
    serverOrigin: 'https://server.example.com',
    organization: { id: 'org-1', name: 'Engineering' },
    availabilityStatus: 'ready', supportedAdapterIds: ['codex', 'claude'],
    connectionRevision: 'connection-secret', artifactDigest: 'digest-secret',
    config: { token: 'config-secret' }, headers: { Authorization: 'Bearer header-secret' },
    models: [{
      id: 'responses', displayName: 'Responses', contextSize: 128000,
      protocols: ['openai_responses'], availabilityStatus: 'ready',
      artifactId: 'artifact-secret', codexFileSha256: 'hash-secret', token: 'model-secret'
    }]
  }
  const { handlers } = register({ listProfiles: () => [serviceProfile] })

  const state = await handlers.get('ai-cli-profiles:get-state')({}, {})
  assert.deepEqual(state.profiles, [{
    id: 'service-profile', source: 'server', readOnly: true,
    serverOrigin: 'https://server.example.com',
    organization: { id: 'org-1', name: 'Engineering' },
    availabilityStatus: 'ready', supportedAdapterIds: ['codex', 'claude'],
    models: [{
      id: 'responses', displayName: 'Responses', contextSize: 128000,
      protocols: ['openai_responses'], availabilityStatus: 'ready'
    }]
  }])
  assert.equal(/connection-secret|digest-secret|config-secret|header-secret|artifact-secret|hash-secret|model-secret/.test(JSON.stringify(state)), false)
})

test('profile state includes a chat-only service profile exactly once without making it selectable', async () => {
  const chatOnlyProfile = {
    id: 'chat-only-service', sourceKind: 'server', readOnly: true,
    serverOrigin: 'https://server.example.com',
    organization: { id: 'org-1', name: 'Engineering' },
    availabilityStatus: 'ready', supportedAdapterIds: [],
    models: [{
      id: 'chat', displayName: 'Chat only', contextSize: 64000,
      protocols: ['openai_chat'], availabilityStatus: 'ready'
    }]
  }
  const { handlers } = register({
    listCliConfigurationState: () => [
      { adapterId: 'codex', mode: 'profiles', profileCount: 0 },
      { adapterId: 'claude', mode: 'profiles', profileCount: 0 }
    ],
    listProfiles: () => [],
    listServiceProfiles: () => [chatOnlyProfile]
  })

  const state = await handlers.get('ai-cli-profiles:get-state')({}, {})
  assert.deepEqual(state.profiles, [{
    id: 'chat-only-service', source: 'server', readOnly: true,
    serverOrigin: 'https://server.example.com',
    organization: { id: 'org-1', name: 'Engineering' },
    availabilityStatus: 'ready', supportedAdapterIds: [],
    models: [{
      id: 'chat', displayName: 'Chat only', contextSize: 64000,
      protocols: ['openai_chat'], availabilityStatus: 'ready'
    }]
  }])
})

test('profile binding accepts canonical service IDs and rejects unsafe opaque IDs before delegation', async () => {
  const { handlers, calls } = register()
  const profileId = stableServiceProfileId({
    serverOrigin: 'http://server.example.test:80/', organizationId: 'org-1'
  })

  await handlers.get('ai-cli-profiles:set-binding')({}, {
    scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId, model: 'responses'
  })
  assert.deepEqual(calls, [['binding', {
    scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId, model: 'responses'
  }]])

  for (const invalidProfileId of ['', 'server\0profile', 'server\u0001profile', 'a'.repeat(1025)]) {
    const callsBefore = calls.length
    await assert.rejects(
      handlers.get('ai-cli-profiles:set-binding')({}, {
        scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: invalidProfileId, model: 'responses'
      }),
      { code: 'INVALID_PROFILE_IPC' }
    )
    assert.equal(calls.length, callsBefore)
  }
})

test('profile IPC returns only sanitized state, profiles, and revisions', async () => {
  const { handlers } = register()
  const state = await handlers.get('ai-cli-profiles:get-state')({}, { cwd: 'F:\\projects\\demo', path: 'forged' })
  assert.equal(state.profiles[0].hasSecret, true)
  assert.equal('secret' in state.profiles[0], false)
  assert.equal('headers' in state.codexRuntime, false)
  assert.equal('error' in state.cliInventory[0], false)

  const revisions = await handlers.get('ai-cli-profiles:list-revisions')({}, 'profile-1')
  assert.equal(revisions[0].config.name, 'Old')
  assert.equal(revisions[0].config.baseUrl, 'https://old.example.com')
  assert.equal('secret' in revisions[0].config, false)
  assert.equal('ciphertext' in revisions[0], false)
  assert.equal(JSON.stringify({ state, revisions }).includes('leak'), false)
})

test('profile IPC maps service failures to stable public errors', async () => {
  const { handlers } = register({
    updateProfile: async () => {
      throw Object.assign(new Error('C:\\Users\\me\\secret path'), { code: 'PROFILE_NOT_FOUND' })
    }
  })
  await assert.rejects(
    handlers.get('ai-cli-profiles:update')({}, 'profile-1', { name: 'Missing' }),
    (error) => error.code === 'PROFILE_NOT_FOUND' && !error.message.includes('secret path')
  )
})

test('preload and renderer expose the complete named profile surface', () => {
  const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../src/ipc.js', import.meta.url), 'utf8')
  const names = [
    'getAiCliProfileState', 'createAiCliProfile', 'updateAiCliProfile',
    'setAiCliProfileSecret', 'deleteAiCliProfileSecret', 'deleteAiCliProfile',
    'setAiCliProfileBinding', 'listAiCliProfileRevisions', 'rollbackAiCliProfile',
    'reconcileAiCliProfiles'
  ]
  for (const name of names) {
    assert.match(preload, new RegExp(`${name}:`))
    assert.match(renderer, new RegExp(`${name}:`))
  }
})
