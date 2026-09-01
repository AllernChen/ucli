import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAiCliProfileIpc } from '../electron/aiCliProfiles/ipc.js'

function register() {
  const handlers = new Map()
  const calls = []
  const profiles = {
    codex: [{
      id: 'codex-profile', adapterId: 'codex', name: 'Codex', kind: 'reference',
      providerId: 'openai', status: 'ready', canStart: true
    }],
    claude: [{
      id: 'claude-profile', adapterId: 'claude', name: 'Company Claude', kind: 'managed',
      providerId: 'anthropic-api', baseUrl: 'https://gateway.example.com',
      baseUrlDisplay: 'gateway.example.com', model: 'sonnet', hasSecret: true,
      secretSuffix: '1234', status: 'ready', canStart: true,
      config: {
        connectionMode: 'api_key',
        baseUrl: 'https://gateway.example.com',
        env: { ANTHROPIC_API_KEY: 'must-not-leak' }
      }
    }]
  }
  const service = {
    listCliConfigurationState: () => [
      { adapterId: 'codex', mode: 'profiles', profileCount: 1, projectBinding: null },
      { adapterId: 'claude', mode: 'profiles', profileCount: 1, projectBinding: 'claude-profile' },
      { adapterId: 'opencode', mode: 'system', profileCount: 0, projectBinding: null },
      { adapterId: 'ucode', mode: 'system', profileCount: 0, projectBinding: null }
    ],
    listProfiles: ({ adapterId }) => profiles[adapterId] || [],
    listServiceProfiles: () => [],
    createProfile: async (draft) => { calls.push(['create', draft]); return profiles.claude[0] },
    updateProfile: async (...args) => { calls.push(['update', ...args]); return profiles.claude[0] },
    replaceProfileSecret: async () => profiles.claude[0],
    deleteProfileSecret: async () => profiles.claude[0],
    deleteProfile: async () => true,
    setBinding: async (binding) => binding,
    listRevisions: () => [],
    rollbackProfile: async () => profiles.claude[0],
    repairProfile: async () => profiles.claude[0],
    reconcileCodexProfiles: async () => ({ recovered: [], warnings: [] })
  }

  registerAiCliProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service,
    inspectCliTools: async () => [],
    getCodexRuntime: () => ({ currentProvider: 'openai', providerCatalog: [] }),
    getClaudeRuntime: () => ({
      configDir: 'C:\\Users\\Ada\\.claude',
      settingsPath: 'C:\\Users\\Ada\\.claude\\settings.json',
      settingsMtimeMs: 123,
      inheritedAuthMode: 'api_key',
      ANTHROPIC_API_KEY: 'must-not-leak',
      credential: 'must-not-leak'
    })
  })
  return { handlers, calls }
}

test('Claude profile IPC accepts documented draft fields and drops forged runtime data', async () => {
  const { handlers, calls } = register()
  await handlers.get('ai-cli-profiles:create')({}, {
    adapterId: 'claude',
    name: 'Company Claude',
    connectionMode: 'api_key',
    baseUrl: 'https://gateway.example.com',
    model: 'sonnet',
    secret: 'plain-secret',
    env: { ANTHROPIC_API_KEY: 'forged' },
    settings: { apiKeyHelper: 'forged' },
    configDir: 'C:\\forged',
    nativeProfileName: 'forged',
    config: { connectionMode: 'bearer' }
  })

  assert.deepEqual(calls[0], ['create', {
    adapterId: 'claude',
    name: 'Company Claude',
    kind: undefined,
    providerId: undefined,
    baseUrl: 'https://gateway.example.com',
    model: 'sonnet',
    reasoningEffort: undefined,
    contextWindow: undefined,
    secret: 'plain-secret',
    connectionMode: 'api_key'
  }])

  await handlers.get('ai-cli-profiles:update')({}, 'claude-profile', {
    name: 'Renamed',
    connectionMode: 'bearer',
    secret: 'replacement-bearer',
    env: { ANTHROPIC_AUTH_TOKEN: 'forged' }
  })
  assert.deepEqual(calls[1], ['update', 'claude-profile', {
    name: 'Renamed',
    connectionMode: 'bearer',
    secret: 'replacement-bearer'
  }])
})

test('profile IPC state returns Claude configuration metadata without credentials', async () => {
  const { handlers } = register()
  const state = await handlers.get('ai-cli-profiles:get-state')({}, { cwd: 'F:\\projects\\demo' })

  assert.deepEqual(state.profiles.map((profile) => profile.adapterId), ['codex', 'claude'])
  const claude = state.profiles.find((profile) => profile.adapterId === 'claude')
  assert.deepEqual(claude.config, {
    connectionMode: 'api_key',
    baseUrl: 'https://gateway.example.com'
  })
  assert.equal(claude.connectionMode, 'api_key')
  assert.equal(claude.isProjectDefault, true)
  assert.deepEqual(state.claudeRuntime, {
    configDir: 'C:\\Users\\Ada\\.claude',
    settingsMtimeMs: 123,
    inheritedAuthMode: 'api_key'
  })
  const serialised = JSON.stringify(state)
  assert.equal(serialised.includes('must-not-leak'), false)
  assert.equal(serialised.includes('ANTHROPIC_API_KEY'), false)
  assert.equal(serialised.includes('settings.json'), false)
})
