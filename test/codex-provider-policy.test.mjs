import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCodexArgs } from '../electron/adapters/codexAdapter.js'
import {
  requiresCodexProcessRestart,
  reconcileCodexRuntimeProvider,
  resolveCodexProviderPolicy
} from '../electron/codexProviderPolicy.js'

const runtime = {
  currentProvider: 'work_gateway',
  availableProviders: ['openai', 'work_gateway', 'legacy_gateway']
}

test('source policy keeps a compatible imported provider override', () => {
  assert.deepEqual(resolveCodexProviderPolicy({
    policy: 'source',
    sourceProvider: 'legacy_gateway',
    runtime
  }), {
    providerOverride: 'legacy_gateway',
    effectiveProvider: 'legacy_gateway',
    warning: null
  })
})

test('live policy follows the active Codex configuration without a CLI override', () => {
  const resolved = resolveCodexProviderPolicy({
    policy: 'live',
    sourceProvider: 'legacy_gateway',
    runtime
  })
  assert.deepEqual(resolved, {
    providerOverride: null,
    effectiveProvider: 'work_gateway',
    warning: null
  })
  assert.equal(buildCodexArgs({ cliSessionId: 'session-1', providerPolicy: 'live', providerOverride: resolved.providerOverride })
    .includes('model_provider=work_gateway'), false)
})

test('missing source provider falls back to the live provider with a warning', () => {
  assert.deepEqual(resolveCodexProviderPolicy({
    policy: 'source',
    sourceProvider: 'removed_gateway',
    runtime
  }), {
    providerOverride: 'work_gateway',
    effectiveProvider: 'work_gateway',
    warning: 'source_provider_unavailable'
  })
})

test('unavailable explicit provider blocks a Codex start instead of resuming through live config', () => {
  assert.deepEqual(resolveCodexProviderPolicy({
    policy: 'explicit',
    explicitProvider: 'work_gateway & calc.exe',
    runtime
  }), {
    providerOverride: null,
    effectiveProvider: null,
    warning: 'explicit_provider_unavailable',
    canStart: false
  })
})

test('runtime provider changes stay pending while an existing Codex process is active', () => {
  const result = reconcileCodexRuntimeProvider({
    session: {
      provider: 'old_gateway',
      providerOverride: null,
      providerWarning: null,
      runtimeRevision: 'C:/codex|1'
    },
    resolved: {
      providerOverride: null,
      effectiveProvider: 'new_gateway',
      warning: null,
      canStart: true,
      runtimeRevision: 'C:/codex|2'
    },
    isActive: true
  })
  assert.deepEqual(result, {
    provider: 'old_gateway',
    providerOverride: null,
    providerWarning: null,
    runtimeRevision: 'C:/codex|1',
    pendingProvider: 'new_gateway',
    pendingProviderOverride: null,
    pendingProviderWarning: null,
    pendingRuntimeRevision: 'C:/codex|2',
    restartRequired: true,
    canStart: true
  })
})

test('a same-provider Codex config revision stays pending for an active process', () => {
  const result = reconcileCodexRuntimeProvider({
    session: {
      provider: 'work_gateway',
      providerOverride: null,
      providerWarning: null,
      runtimeRevision: 'C:/codex|1'
    },
    resolved: {
      providerOverride: null,
      effectiveProvider: 'work_gateway',
      warning: null,
      canStart: true,
      runtimeRevision: 'C:/codex|2'
    },
    isActive: true
  })
  assert.equal(result.restartRequired, true)
  assert.equal(result.provider, 'work_gateway')
  assert.equal(result.pendingProvider, 'work_gateway')
  assert.equal(result.runtimeRevision, 'C:/codex|1')
  assert.equal(result.pendingRuntimeRevision, 'C:/codex|2')
  assert.equal(requiresCodexProcessRestart(result), true)
})

test('an unchanged Codex runtime can resume without rebuilding its adapter', () => {
  assert.equal(requiresCodexProcessRestart({ canStart: true, restartRequired: false }), false)
  assert.equal(requiresCodexProcessRestart({ canStart: false, restartRequired: false }), true)
})

test('legacy provider policy ignores profile selection fields and remains backward compatible', () => {
  assert.deepEqual(resolveCodexProviderPolicy({
    policy: 'source',
    sourceProvider: 'legacy_gateway',
    profileId: 'profile-explicit',
    runtime
  }), {
    providerOverride: 'legacy_gateway',
    effectiveProvider: 'legacy_gateway',
    warning: null
  })
})
