import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildClaudeProfileArgs,
  buildClaudeProfileEnvironment,
  createClaudeProfileAdapter,
  describeClaudeModelSelection,
  prepareClaudeProfileSession
} from '../electron/aiCliProfiles/claudeProfileAdapter.js'
import {
  buildClaudeAdapterLaunch,
  buildClaudeSettings
} from '../electron/adapters/claudeAdapter.js'

test('explicit Claude profile model overrides the session model as a separate argv value', () => {
  assert.deepEqual(buildClaudeProfileArgs({
    session: { model: 'haiku', cliSessionId: 'session-id' },
    profile: { model: 'claude-sonnet-5' }
  }), [
    '--model', 'claude-sonnet-5',
    '--resume', 'session-id'
  ])

  assert.deepEqual(buildClaudeProfileArgs({
    session: { model: 'opus', cliSessionId: 'existing-session' },
    profile: null
  }), [
    '--model', 'opus',
    '--resume', 'existing-session'
  ])
})

test('Claude history without a safe model resumes without a model override', () => {
  assert.deepEqual(buildClaudeProfileArgs({
    session: { model: null, cliSessionId: 'native-history-session' },
    profile: null
  }), [
    '--resume', 'native-history-session'
  ])
})

test('Claude profile arguments reject shell syntax before reaching cmd.exe', () => {
  for (const model of ['sonnet & calc.exe', 'sonnet|other', 'sonnet > file', '"sonnet"']) {
    assert.throws(
      () => buildClaudeProfileArgs({ session: {}, profile: { model } }),
      (error) => error.code === 'INVALID_CLAUDE_MODEL'
    )
  }
})

test('subscription profile removes inherited Claude routing without mutating the base environment', () => {
  const baseEnv = {
    PATH: 'C:\\tools',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    ANTHROPIC_BASE_URL: 'https://old.example.com',
    CLAUDE_CODE_USE_BEDROCK: '1'
  }
  const env = buildClaudeProfileEnvironment({
    baseEnv,
    profile: { config: { connectionMode: 'subscription', baseUrl: null } },
    secret: null
  })

  assert.deepEqual(env, { PATH: 'C:\\tools' })
  assert.equal(baseEnv.ANTHROPIC_API_KEY, 'old-key')
  assert.equal(baseEnv.CLAUDE_CODE_USE_BEDROCK, '1')
})

test('Claude profiles scrub inherited routing case-insensitively for Windows environments', () => {
  const baseEnv = {
    PATH: 'C:\\tools',
    Anthropic_Api_Key: 'mixed-api-key',
    anthropic_auth_token: 'mixed-token',
    Claude_Code_Use_Bedrock: '1',
    claude_code_use_vertex: '1'
  }

  const subscription = buildClaudeProfileEnvironment({
    baseEnv,
    profile: { config: { connectionMode: 'subscription' } }
  })
  const managed = buildClaudeProfileEnvironment({
    baseEnv,
    profile: { config: { connectionMode: 'api_key', baseUrl: null } },
    secret: 'new-secret'
  })

  for (const env of [subscription, managed]) {
    const keys = Object.keys(env).map((key) => key.toUpperCase())
    assert.equal(keys.includes('ANTHROPIC_AUTH_TOKEN'), false)
    assert.equal(keys.includes('CLAUDE_CODE_USE_BEDROCK'), false)
    assert.equal(keys.includes('CLAUDE_CODE_USE_VERTEX'), false)
  }
  assert.equal(managed.ANTHROPIC_API_KEY, 'new-secret')
  assert.equal(Object.keys(managed).filter((key) => key.toUpperCase() === 'ANTHROPIC_API_KEY').length, 1)
})

test('managed Claude modes inject exactly one credential into the target environment', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'old-key',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    CLAUDE_CODE_USE_VERTEX: '1'
  }
  const apiKeyEnv = buildClaudeProfileEnvironment({
    baseEnv,
    profile: { config: { connectionMode: 'api_key', baseUrl: null } },
    secret: 'new-api-key'
  })
  assert.deepEqual(apiKeyEnv, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'new-api-key',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
  })

  const bearerEnv = buildClaudeProfileEnvironment({
    baseEnv,
    profile: {
      config: { connectionMode: 'bearer', baseUrl: 'https://gateway.example.com' }
    },
    secret: 'new-bearer-token'
  })
  assert.deepEqual(bearerEnv, {
    PATH: '/usr/bin',
    ANTHROPIC_AUTH_TOKEN: 'new-bearer-token',
    ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
  })
  assert.equal(JSON.stringify(baseEnv).includes('new-bearer-token'), false)
})

test('managed Claude profiles exclude user settings while subscription profiles keep defaults', () => {
  const adapter = createClaudeProfileAdapter()
  for (const connectionMode of ['api_key', 'bearer']) {
    const managed = adapter.resolveLaunch({
      profile: {
        model: 'mimo-v2.5-pro',
        config: {
          connectionMode,
          baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic'
        }
      },
      secret: 'managed-token',
      baseEnv: { PATH: 'C:\\tools' }
    })

    assert.deepEqual(managed.settingSources, ['project', 'local'])
  }
  const subscription = adapter.resolveLaunch({
    profile: {
      model: 'sonnet',
      config: { connectionMode: 'subscription', baseUrl: null }
    },
    baseEnv: { PATH: 'C:\\tools' }
  })

  assert.equal('settingSources' in subscription, false)
})

test('Claude temporary settings contain hooks and deny rules but no profile connection data', () => {
  const settings = buildClaudeSettings('F:\\ucli\\hook-runner.js')
  assert.equal(Array.isArray(settings.hooks.PreToolUse), true)
  assert.equal(settings.permissions.deny.length > 0, true)
  assert.equal('env' in settings, false)
  assert.equal(JSON.stringify(settings).includes('ANTHROPIC_'), false)
})

test('Claude adapter launch keeps secrets out of argv and temporary settings', () => {
  const secret = 'decoy-secret-must-only-enter-env'
  const launch = buildClaudeAdapterLaunch({
    session: { id: 'ucli-session', model: 'haiku', cliSessionId: 'native-session' },
    settingsFile: 'C:\\temp\\settings.json',
    hookPort: 43123,
    baseEnv: { PATH: 'C:\\tools' },
    profileLaunch: {
      args: ['--model', 'sonnet', '--resume', 'native-session'],
      env: { PATH: 'C:\\tools', ANTHROPIC_API_KEY: secret },
      settingSources: ['project', 'local']
    }
  })

  assert.deepEqual(launch.args, [
    '--permission-mode', 'default',
    '--settings', 'C:\\temp\\settings.json',
    '--setting-sources', 'project,local',
    '--model', 'sonnet',
    '--resume', 'native-session'
  ])
  assert.equal(launch.env.ANTHROPIC_API_KEY, secret)
  assert.equal(launch.env.UCLI_HOOK_PORT, '43123')
  assert.equal(launch.env.UCLI_SESSION_ID, 'ucli-session')
  assert.equal(JSON.stringify(launch.args).includes(secret), false)
  assert.equal(JSON.stringify(buildClaudeSettings('runner.js')).includes(secret), false)
})

test('Claude server profile launch preserves the executable search path', () => {
  const launch = buildClaudeAdapterLaunch({
    session: { id: 'server-session', model: 'server-model' },
    settingsFile: 'C:\\temp\\settings.json',
    hookPort: 43123,
    baseEnv: { PATH: 'F:\\soft\\nvm\\nodejs', SYSTEMROOT: 'C:\\Windows' },
    profileLaunch: {
      args: ['--model', 'server-model'],
      env: {
        ANTHROPIC_AUTH_TOKEN: 'server-bearer',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:43124/anthropic',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
      },
      settingSources: ['project', 'local']
    }
  })

  assert.equal(launch.env.PATH, 'F:\\soft\\nvm\\nodejs')
  assert.equal(launch.env.SYSTEMROOT, 'C:\\Windows')
})

test('Claude server profile launch excludes inherited Claude routing', () => {
  const launch = buildClaudeAdapterLaunch({
    session: { id: 'server-session', model: 'server-model' },
    settingsFile: 'C:\\temp\\settings.json',
    hookPort: 43123,
    baseEnv: {
      PATH: 'F:\\soft\\nvm\\nodejs',
      ANTHROPIC_API_KEY: 'inherited-api-key',
      anthropic_auth_token: 'inherited-bearer',
      Anthropic_Base_Url: 'https://inherited.example.com',
      Claude_Code_Use_Bedrock: '1'
    },
    profileLaunch: {
      args: ['--model', 'server-model'],
      env: {
        ANTHROPIC_AUTH_TOKEN: 'server-bearer',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:43124/anthropic',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
      },
      settingSources: ['project', 'local']
    }
  })

  assert.deepEqual(
    Object.keys(launch.env).filter((key) => key.toUpperCase() === 'ANTHROPIC_AUTH_TOKEN'),
    ['ANTHROPIC_AUTH_TOKEN']
  )
  assert.equal('ANTHROPIC_API_KEY' in launch.env, false)
  assert.equal('Anthropic_Base_Url' in launch.env, false)
  assert.equal('Claude_Code_Use_Bedrock' in launch.env, false)
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'server-bearer')
  assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43124/anthropic')
})

test('Claude session preparation keeps launch credentials outside persisted session state', () => {
  const prepared = prepareClaudeProfileSession({
    session: { id: 'session-1', adapterId: 'claude', model: 'haiku' },
    selection: { profileId: 'profile-1', canStart: true },
    launch: {
      args: ['--model', 'sonnet'],
      env: { ANTHROPIC_API_KEY: 'session-secret' },
      settingSources: ['project', 'local'],
      artifact: { model: 'sonnet', connectionMode: 'api_key' },
      status: 'ready',
      runtimeRevision: 123
    }
  })

  assert.equal(prepared.session.profileId, 'profile-1')
  assert.equal(prepared.session.model, 'sonnet')
  assert.equal(prepared.session.profileRuntimeRevision, 123)
  assert.equal(prepared.profileLaunch.env.ANTHROPIC_API_KEY, 'session-secret')
  assert.deepEqual(prepared.profileLaunch.settingSources, ['project', 'local'])
  assert.equal(JSON.stringify(prepared.session).includes('session-secret'), false)

  const system = prepareClaudeProfileSession({
    session: prepared.session,
    selection: { profileId: null, canStart: true }
  })
  assert.equal(system.session.profileId, null)
  assert.equal(system.profileLaunch, null)
})

test('Claude system launch does not suppress user settings', () => {
  const launch = buildClaudeAdapterLaunch({
    session: { id: 'system-session', model: 'sonnet' },
    settingsFile: 'C:\\temp\\settings.json',
    hookPort: 43123,
    baseEnv: { PATH: 'C:\\tools' }
  })

  assert.equal(launch.args.includes('--setting-sources'), false)
})

test('Claude profile removal and model-less profiles restore the persisted system model', () => {
  const session = {
    id: 'session-1', adapterId: 'claude',
    model: 'profile-sonnet', systemModel: 'history-haiku', profileId: 'profile-old'
  }
  const system = prepareClaudeProfileSession({
    session,
    selection: { profileId: null, canStart: true, selectionSource: 'system' }
  })
  assert.equal(system.session.model, 'history-haiku')
  assert.equal(system.session.profileId, null)
  assert.equal(system.profileLaunch, null)

  const modelLess = prepareClaudeProfileSession({
    session,
    selection: { profileId: 'profile-no-model', canStart: true },
    launch: {
      args: ['--resume', 'native-session'],
      env: { PATH: 'C:\\tools' },
      artifact: { model: null, connectionMode: 'subscription' },
      status: 'ready',
      runtimeRevision: 456
    }
  })
  assert.equal(modelLess.session.model, 'history-haiku')
})

test('Claude actual model reports substitution without replacing the requested model', () => {
  assert.deepEqual(describeClaudeModelSelection({
    requestedModel: 'sonnet',
    actualModel: 'claude-sonnet-5-20260801'
  }), {
    actualModel: 'claude-sonnet-5-20260801',
    profileWarning: 'model_substituted'
  })
  assert.deepEqual(describeClaudeModelSelection({
    requestedModel: 'sonnet',
    actualModel: 'sonnet'
  }), {
    actualModel: 'sonnet',
    profileWarning: null
  })
})
