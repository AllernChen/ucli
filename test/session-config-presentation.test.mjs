import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveServiceProfileSessionState,
  deriveSessionConfigState
} from '../src/sessionConfigPresentation.js'

test('active unmanaged Codex sessions expose direct Provider controls', () => {
  assert.deepEqual(deriveSessionConfigState({
    adapterId: 'codex',
    status: 'running',
    profileId: null,
    providerPolicy: 'explicit',
    canStart: true
  }), {
    profileCapable: true,
    providerEditable: true,
    explicitProviderVisible: true,
    needsAttention: false,
    attentionCode: null,
    attentionText: ''
  })
})

test('managed Claude sessions hide direct Provider controls', () => {
  const state = deriveSessionConfigState({
    adapterId: 'claude',
    status: 'idle',
    profileId: 'mimo',
    canStart: true
  })

  assert.equal(state.profileCapable, true)
  assert.equal(state.providerEditable, false)
  assert.equal(state.explicitProviderVisible, false)
})

test('restart requirements take priority in the configuration attention state', () => {
  assert.deepEqual(deriveSessionConfigState({
    adapterId: 'codex',
    status: 'idle',
    restartRequired: true,
    profileWarning: 'model_substituted',
    providerWarning: 'source_provider_unavailable',
    canStart: true
  }), {
    profileCapable: true,
    providerEditable: true,
    explicitProviderVisible: false,
    needsAttention: true,
    attentionCode: 'restart_required',
    attentionText: '配置已变更，重启后生效'
  })
})

test('profile and Provider warnings produce stable attention messages', () => {
  assert.deepEqual(
    deriveSessionConfigState({ adapterId: 'claude', status: 'idle', profileWarning: 'model_substituted' }),
    {
      profileCapable: true,
      providerEditable: false,
      explicitProviderVisible: false,
      needsAttention: true,
      attentionCode: 'profile_warning',
      attentionText: '配置档案需要处理'
    }
  )
  assert.equal(
    deriveSessionConfigState({ adapterId: 'codex', status: 'idle', providerWarning: 'source_provider_unavailable' }).attentionText,
    'Provider 配置需要处理'
  )
})

test('service profile session state fails closed for missing and removed models', () => {
  const profile = {
    id: 'http://server.test::org-1',
    source: 'server',
    models: [{
      id: 'responses',
      displayName: 'Responses',
      protocols: ['openai_responses'],
      availabilityStatus: 'ready'
    }]
  }

  assert.deepEqual(deriveServiceProfileSessionState({
    profile, adapterId: 'codex', profileId: profile.id, model: null
  }), { profileId: profile.id, model: null, canStart: false, reason: 'model-required' })
  assert.deepEqual(deriveServiceProfileSessionState({
    profile, adapterId: 'codex', profileId: profile.id, model: 'removed'
  }), { profileId: profile.id, model: 'removed', canStart: false, reason: 'model-unavailable' })
  assert.deepEqual(deriveServiceProfileSessionState({
    profile, adapterId: 'codex', profileId: profile.id, model: 'responses'
  }), { profileId: profile.id, model: 'responses', canStart: true, reason: null })
})

test('service profile session state keeps an absent imported model visible as historical', () => {
  const state = deriveServiceProfileSessionState({
    profile: {
      id: 'http://server.test::org-1',
      source: 'server',
      models: []
    },
    adapterId: 'codex',
    profileId: 'http://server.test::org-1',
    model: 'removed',
    historical: true
  })

  assert.deepEqual(state.historicalModel, {
    id: 'removed',
    displayName: 'removed',
    historical: true,
    availabilityStatus: 'removed'
  })
})
