import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexArgs,
  buildCodexEnvironment
} from '../electron/adapters/codexAdapter.js'

const NATIVE_PROFILE = 'ucli-550e8400e29b41d4a716446655440000'
const SECRET_ENV = 'UCLI_CODEX_PROFILE_550E8400_E29B_41D4_A716_446655440000'

test('Codex profile is a global option before resume and replaces legacy overrides', () => {
  assert.deepEqual(buildCodexArgs({
    cliSessionId: '019fb7c7-daa8-7c31-af6e-a8372324ec6e',
    nativeProfileName: NATIVE_PROFILE,
    profileId: '550e8400-e29b-41d4-a716-446655440000',
    providerPolicy: 'source',
    providerOverride: 'legacy_gateway',
    provider: 'legacy_gateway',
    model: 'gpt-source'
  }), [
    '--no-alt-screen',
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"',
    '--profile', NATIVE_PROFILE,
    'resume', '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  ])
})

test('Codex launch arguments remain byte-for-byte compatible without a profile', () => {
  assert.deepEqual(buildCodexArgs({
    cliSessionId: '019fb7c7-daa8-7c31-af6e-a8372324ec6e',
    providerPolicy: 'source',
    providerOverride: 'legacy_gateway',
    provider: 'legacy_gateway',
    model: 'gpt-source'
  }), [
    '--no-alt-screen',
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"',
    'resume', '019fb7c7-daa8-7c31-af6e-a8372324ec6e',
    '-c', 'model_provider=legacy_gateway',
    '--model', 'gpt-source'
  ])
})

test('Codex profile environment is isolated to one session and does not mutate its base', () => {
  const baseEnv = { PATH: 'F:\\tools', SHARED: 'value' }
  const sessionA = { id: 'session-a' }
  const profileEnvironment = {
    [SECRET_ENV]: 'top-secret-a',
    PATH: 'must-not-override',
    MALICIOUS: 'must-not-pass'
  }
  const sessionB = { id: 'session-b' }

  const envA = buildCodexEnvironment(sessionA, {
    codexHome: 'F:\\profiles\\codex',
    baseEnv,
    profileEnvironment
  })
  const envB = buildCodexEnvironment(sessionB, {
    codexHome: 'F:\\profiles\\codex',
    baseEnv
  })

  assert.deepEqual(baseEnv, { PATH: 'F:\\tools', SHARED: 'value' })
  assert.equal(envA[SECRET_ENV], 'top-secret-a')
  assert.equal(envA.PATH, 'F:\\tools')
  assert.equal(envA.MALICIOUS, undefined)
  assert.equal(envB[SECRET_ENV], undefined)
  assert.equal(envA.CODEX_HOME, 'F:\\profiles\\codex')
  assert.equal(envA.UCLI_SESSION_ID, 'session-a')
  assert.equal(envB.UCLI_SESSION_ID, 'session-b')
})

test('Codex environment rejects malformed profile secret variable names', () => {
  const env = buildCodexEnvironment({
    id: 'session-a',
    profileEnvironment: {
      UCLI_CODEX_PROFILE_BAD: 'secret',
      'UCLI_CODEX_PROFILE_550E8400-E29B': 'secret'
    }
  }, { codexHome: 'F:\\profiles\\codex', baseEnv: {} })

  assert.equal(Object.keys(env).some((key) => key.startsWith('UCLI_CODEX_PROFILE_')), false)
})
