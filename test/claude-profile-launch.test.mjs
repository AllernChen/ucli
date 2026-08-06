import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildClaudeProfileArgs,
  buildClaudeProfileEnvironment,
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
      env: { PATH: 'C:\\tools', ANTHROPIC_API_KEY: secret }
    }
  })

  assert.deepEqual(launch.args, [
    '--permission-mode', 'default',
    '--settings', 'C:\\temp\\settings.json',
    '--model', 'sonnet',
    '--resume', 'native-session'
  ])
  assert.equal(launch.env.ANTHROPIC_API_KEY, secret)
  assert.equal(launch.env.UCLI_HOOK_PORT, '43123')
  assert.equal(launch.env.UCLI_SESSION_ID, 'ucli-session')
  assert.equal(JSON.stringify(launch.args).includes(secret), false)
  assert.equal(JSON.stringify(buildClaudeSettings('runner.js')).includes(secret), false)
})

test('Claude session preparation keeps launch credentials outside persisted session state', () => {
  const prepared = prepareClaudeProfileSession({
    session: { id: 'session-1', adapterId: 'claude', model: 'haiku' },
    selection: { profileId: 'profile-1', canStart: true },
    launch: {
      args: ['--model', 'sonnet'],
      env: { ANTHROPIC_API_KEY: 'session-secret' },
      artifact: { model: 'sonnet', connectionMode: 'api_key' },
      status: 'ready',
      runtimeRevision: 123
    }
  })

  assert.equal(prepared.session.profileId, 'profile-1')
  assert.equal(prepared.session.model, 'sonnet')
  assert.equal(prepared.session.profileRuntimeRevision, 123)
  assert.equal(prepared.profileLaunch.env.ANTHROPIC_API_KEY, 'session-secret')
  assert.equal(JSON.stringify(prepared.session).includes('session-secret'), false)

  const system = prepareClaudeProfileSession({
    session: prepared.session,
    selection: { profileId: null, canStart: true }
  })
  assert.equal(system.session.profileId, null)
  assert.equal(system.profileLaunch, null)
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
