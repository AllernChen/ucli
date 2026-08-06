import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isSafeNativeProfileName,
  normaliseProfileDraft,
  sanitiseProfile,
  sanitiseProfileError,
  validateProfileBaseUrl
} from '../electron/aiCliProfiles/contracts.js'
import { createProfileAdapterRegistry } from '../electron/aiCliProfiles/profileAdapterRegistry.js'

const PROFILE_ID = '550e8400-e29b-41d4-a716-446655440000'
const NATIVE_PROFILE = 'ucli-550e8400e29b41d4a716446655440000'

function validDraft(overrides = {}) {
  return {
    adapterId: 'codex',
    name: 'Company Gateway',
    kind: 'managed',
    nativeProfileName: NATIVE_PROFILE,
    providerId: 'ucli_550e8400e29b',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    contextWindow: 400000,
    ...overrides
  }
}

function validAdapter(id = 'codex') {
  return {
    id,
    validateDraft(draft) { return draft },
    sanitiseConfig(config) { return config },
    resolveLaunch() { return { args: [], env: {} } },
    reconcile() { return { status: 'ready' } }
  }
}

test('normaliseProfileDraft accepts only the documented common profile fields', () => {
  const result = normaliseProfileDraft({
    ...validDraft(),
    apiKey: 'must-not-survive',
    ciphertext: 'must-not-survive',
    configToml: 'must-not-survive'
  })

  assert.deepEqual(result, validDraft())
  assert.equal(JSON.stringify(result).includes('must-not-survive'), false)
})

test('normaliseProfileDraft rejects invalid names, kinds, providers, reasoning and context windows', () => {
  const invalidCases = [
    [{ name: '   ' }, 'INVALID_PROFILE_NAME'],
    [{ kind: 'oauth' }, 'INVALID_PROFILE'],
    [{ providerId: '../provider' }, 'INVALID_PROVIDER'],
    [{ reasoningEffort: 'ultra' }, 'INVALID_REASONING_EFFORT'],
    [{ contextWindow: 0 }, 'INVALID_CONTEXT_WINDOW'],
    [{ contextWindow: 1.5 }, 'INVALID_CONTEXT_WINDOW']
  ]

  for (const [patch, code] of invalidCases) {
    assert.throws(
      () => normaliseProfileDraft(validDraft(patch)),
      (error) => error.code === code
    )
  }

  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.equal(normaliseProfileDraft(validDraft({ reasoningEffort: effort })).reasoningEffort, effort)
  }
})

test('native profile names are limited to UCLI-owned UUID-derived names', () => {
  assert.equal(isSafeNativeProfileName(NATIVE_PROFILE), true)
  for (const value of [
    'default',
    'ucli-company',
    'ucli-550e8400e29b41d4a71644665544000',
    'ucli-550e8400e29b41d4a716446655440000.config.toml',
    '../ucli-550e8400e29b41d4a716446655440000'
  ]) {
    assert.equal(isSafeNativeProfileName(value), false)
  }
})

test('profile base URLs require HTTPS except for loopback HTTP', () => {
  const accepted = [
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1'
  ]
  for (const value of accepted) {
    assert.deepEqual(validateProfileBaseUrl(value), { ok: true, value })
  }

  for (const value of [
    'http://api.example.com/v1',
    'ftp://localhost/models',
    'https://user:password@example.com/v1',
    'https://example.com/v1#secret',
    'https://example.com/\nheader',
    'not-a-url'
  ]) {
    assert.equal(validateProfileBaseUrl(value).ok, false)
  }
})

test('sanitiseProfile exposes only the renderer contract and never sensitive values', () => {
  const rendered = sanitiseProfile({
    id: PROFILE_ID,
    ...validDraft(),
    apiKey: 'sk-secret-value',
    ciphertext: 'encrypted-secret-value',
    env: { UCLI_CODEX_PROFILE_KEY: 'env-secret-value' },
    configJson: '{"apiKey":"json-secret-value"}',
    configToml: 'experimental_bearer_token = "toml-secret-value"',
    stack: 'C:\\private\\profileService.js:42',
    hasSecretHint: 1,
    updatedAt: 1785970000000
  }, {
    status: 'drifted',
    canStart: false,
    secretSuffix: '1234',
    isAppDefault: true,
    isProjectDefault: false
  })

  assert.deepEqual(rendered, {
    id: PROFILE_ID,
    adapterId: 'codex',
    name: 'Company Gateway',
    kind: 'managed',
    providerId: 'ucli_550e8400e29b',
    baseUrl: 'https://gateway.example.com/v1',
    baseUrlDisplay: 'gateway.example.com/v1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    contextWindow: 400000,
    hasSecret: true,
    secretSuffix: '1234',
    status: 'drifted',
    canStart: false,
    isAppDefault: true,
    isProjectDefault: false,
    updatedAt: 1785970000000
  })

  const serialised = JSON.stringify(rendered)
  for (const secret of ['sk-secret-value', 'encrypted-secret-value', 'env-secret-value', 'json-secret-value', 'toml-secret-value', 'profileService.js']) {
    assert.equal(serialised.includes(secret), false)
  }
})

test('sanitiseProfileError returns stable public errors without local stacks', () => {
  const error = Object.assign(new Error('The profile is invalid'), {
    code: 'INVALID_PROFILE',
    stack: 'Error: The profile is invalid\n at C:\\private\\profileService.js:42',
    apiKey: 'sk-secret-value'
  })

  assert.deepEqual(sanitiseProfileError(error), {
    code: 'INVALID_PROFILE',
    message: 'The profile is invalid'
  })
  assert.deepEqual(sanitiseProfileError(new Error('raw internal failure')), {
    code: 'PROFILE_OPERATION_FAILED',
    message: 'AI CLI profile operation failed'
  })
})

test('profile adapter registry rejects incomplete and duplicate adapters', () => {
  const codex = validAdapter()
  const registry = createProfileAdapterRegistry([codex])
  assert.equal(registry.get('codex'), codex)

  assert.throws(
    () => createProfileAdapterRegistry([codex, validAdapter('codex')]),
    (error) => error.code === 'DUPLICATE_PROFILE_ADAPTER'
  )
  assert.throws(
    () => createProfileAdapterRegistry([{ ...codex, resolveLaunch: undefined }]),
    (error) => error.code === 'INVALID_PROFILE_ADAPTER'
  )
  assert.throws(
    () => createProfileAdapterRegistry([validAdapter('../codex')]),
    (error) => error.code === 'INVALID_PROFILE_ADAPTER'
  )
})
