import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isSafeClaudeModel,
  normaliseClaudeProfileDraft
} from '../electron/aiCliProfiles/claudeProfileAdapter.js'

function validDraft(overrides = {}) {
  return {
    name: 'Company Claude',
    connectionMode: 'api_key',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'claude-sonnet-5',
    secret: 'sk-ant-secret',
    ...overrides
  }
}

test('Claude profile modes produce only their documented provider and config fields', () => {
  const subscription = normaliseClaudeProfileDraft(validDraft({
    name: 'Claude Login',
    connectionMode: 'subscription',
    baseUrl: '',
    secret: undefined,
    model: 'sonnet',
    env: { ANTHROPIC_API_KEY: 'must-not-survive' },
    settings: { apiKeyHelper: 'must-not-survive' }
  }))
  assert.deepEqual(subscription, {
    common: {
      adapterId: 'claude',
      name: 'Claude Login',
      kind: 'reference',
      nativeProfileName: null,
      providerId: 'claude-subscription',
      baseUrl: null,
      model: 'sonnet',
      reasoningEffort: null,
      contextWindow: null
    },
    config: { connectionMode: 'subscription', baseUrl: null },
    secretAction: { type: 'none' }
  })
  assert.equal(JSON.stringify(subscription).includes('must-not-survive'), false)

  const bearer = normaliseClaudeProfileDraft(validDraft({
    connectionMode: 'bearer',
    secret: 'bearer-secret'
  }))
  assert.equal(bearer.common.kind, 'managed')
  assert.equal(bearer.common.providerId, 'anthropic-bearer')
  assert.deepEqual(bearer.secretAction, { type: 'replace', value: 'bearer-secret' })
})

test('Claude connection modes enforce credential and endpoint rules', () => {
  const invalidCases = [
    validDraft({ connectionMode: 'subscription', baseUrl: 'https://gateway.example.com', secret: undefined }),
    validDraft({ connectionMode: 'subscription', baseUrl: '', secret: 'forbidden' }),
    validDraft({ connectionMode: 'api_key', secret: undefined, keepSecret: false }),
    validDraft({ connectionMode: 'bearer', baseUrl: '', secret: 'bearer-secret' }),
    validDraft({ connectionMode: 'bearer', secret: '   ' }),
    validDraft({ connectionMode: 'bedrock' })
  ]

  for (const draft of invalidCases) {
    assert.throws(
      () => normaliseClaudeProfileDraft(draft),
      (error) => error.code === 'INVALID_CLAUDE_PROFILE'
    )
  }

  const kept = normaliseClaudeProfileDraft(validDraft({ secret: undefined, keepSecret: true }))
  assert.deepEqual(kept.secretAction, { type: 'keep' })
})

test('Claude model values reject shell syntax and control characters', () => {
  for (const model of ['sonnet', 'claude-sonnet-5', 'anthropic/claude:latest', 'model@20260806']) {
    assert.equal(isSafeClaudeModel(model), true)
  }
  for (const model of ['', 'sonnet & calc.exe', 'sonnet|other', 'sonnet model', 'sonnet\nother']) {
    assert.equal(isSafeClaudeModel(model), false)
  }
  assert.throws(
    () => normaliseClaudeProfileDraft(validDraft({ model: 'sonnet & calc.exe' })),
    (error) => error.code === 'INVALID_CLAUDE_MODEL'
  )
})

test('Claude profile base URLs use the common HTTPS and loopback policy', () => {
  assert.equal(normaliseClaudeProfileDraft(validDraft({ baseUrl: 'http://localhost:8080' })).common.baseUrl, 'http://localhost:8080')
  for (const baseUrl of [
    'http://gateway.example.com',
    'https://user:password@gateway.example.com',
    'https://gateway.example.com/path#fragment'
  ]) {
    assert.throws(
      () => normaliseClaudeProfileDraft(validDraft({ baseUrl })),
      (error) => error.code === 'INVALID_PROFILE_BASE_URL'
    )
  }
})
