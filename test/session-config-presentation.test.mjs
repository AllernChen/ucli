import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSessionConfigState } from '../src/sessionConfigPresentation.js'

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
