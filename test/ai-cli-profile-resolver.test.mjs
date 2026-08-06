import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reconcileActiveProfile,
  resolveCodexProfileRuntime,
  resolveSessionProfile
} from '../electron/aiCliProfiles/profileResolver.js'

const profiles = [
  { id: 'profile-app', adapterId: 'codex', kind: 'reference', providerId: 'app_provider' },
  { id: 'profile-project', adapterId: 'codex', kind: 'reference', providerId: 'project_provider' },
  { id: 'profile-explicit', adapterId: 'codex', kind: 'managed', providerId: 'ucli_explicit' }
]

const bindings = [
  { scopeType: 'app', scopeKey: '*', adapterId: 'codex', profileId: 'profile-app' },
  { scopeType: 'project', scopeKey: 'F:\\projects\\demo', adapterId: 'codex', profileId: 'profile-project' }
]

test('new session profile priority is explicit then project then app then system', () => {
  const cases = [
    {
      input: { explicitProfileId: 'profile-explicit', cwd: 'F:\\projects\\demo' },
      expected: ['profile-explicit', 'explicit']
    },
    {
      input: { cwd: 'F:\\projects\\demo' },
      expected: ['profile-project', 'project']
    },
    {
      input: { cwd: 'F:\\projects\\other' },
      expected: ['profile-app', 'app']
    },
    {
      input: { cwd: 'F:\\projects\\other', bindings: [] },
      expected: [null, 'system']
    }
  ]

  for (const entry of cases) {
    const result = resolveSessionProfile({
      adapterId: 'codex',
      profiles,
      bindings,
      imported: false,
      ...entry.input
    })
    assert.equal(result.profileId, entry.expected[0])
    assert.equal(result.selectionSource, entry.expected[1])
    assert.equal(result.canStart, true)
  }
})

test('imported sessions keep their source provider unless a profile is explicit', () => {
  assert.deepEqual(resolveSessionProfile({
    adapterId: 'codex',
    cwd: 'F:\\projects\\demo',
    imported: true,
    profiles,
    bindings
  }), {
    profileId: null,
    profile: null,
    selectionSource: 'history',
    status: null,
    canStart: true
  })

  const explicit = resolveSessionProfile({
    adapterId: 'codex',
    cwd: 'F:\\projects\\demo',
    imported: true,
    explicitProfileId: 'profile-explicit',
    profiles,
    bindings
  })
  assert.equal(explicit.profileId, 'profile-explicit')
  assert.equal(explicit.selectionSource, 'explicit')
})

test('missing selected profile blocks launch with a stable status', () => {
  assert.deepEqual(resolveSessionProfile({
    adapterId: 'codex',
    cwd: 'F:\\projects\\demo',
    imported: false,
    profiles: [],
    bindings
  }), {
    profileId: 'profile-project',
    profile: null,
    selectionSource: 'project',
    status: 'missing_profile',
    canStart: false
  })
})

test('reference profile runtime requires its provider and an owned current file', () => {
  const profile = {
    id: 'profile-ref',
    kind: 'reference',
    providerId: 'work_gateway',
    nativeProfileName: 'ucli-550e8400e29b41d4a716446655440000',
    fileSha256: 'hash-1'
  }
  const ready = resolveCodexProfileRuntime({
    profile,
    runtime: { availableProviders: ['openai', 'work_gateway'] },
    fileState: { exists: true, owned: true, sha256: 'hash-1' },
    secretState: { hasSecret: false, encryptionAvailable: true }
  })
  assert.deepEqual(ready, {
    profileId: 'profile-ref',
    nativeProfileName: profile.nativeProfileName,
    providerId: 'work_gateway',
    status: 'ready',
    canStart: true,
    runtimeRevision: 'hash-1'
  })

  assert.equal(resolveCodexProfileRuntime({
    profile,
    runtime: { availableProviders: ['openai'] },
    fileState: { exists: true, owned: true, sha256: 'hash-1' }
  }).status, 'missing_provider')
})

test('managed profile runtime reports missing, drifted and secret failures without throwing', () => {
  const profile = {
    id: 'profile-managed',
    kind: 'managed',
    providerId: 'ucli_managed',
    nativeProfileName: 'ucli-550e8400e29b41d4a716446655440000',
    fileSha256: 'hash-1'
  }
  const base = {
    profile,
    runtime: { availableProviders: ['openai'] },
    fileState: { exists: true, owned: true, sha256: 'hash-1' },
    secretState: { hasSecret: true, encryptionAvailable: true }
  }

  assert.equal(resolveCodexProfileRuntime({
    ...base,
    fileState: { exists: false }
  }).status, 'missing_file')
  assert.equal(resolveCodexProfileRuntime({
    ...base,
    fileState: { exists: true, owned: true, sha256: 'external-hash' }
  }).status, 'drifted')
  assert.equal(resolveCodexProfileRuntime({
    ...base,
    fileState: { exists: true, owned: false, sha256: 'hash-1' }
  }).status, 'drifted')
  assert.equal(resolveCodexProfileRuntime({
    ...base,
    secretState: { hasSecret: true, encryptionAvailable: false }
  }).status, 'secret_unavailable')
  assert.equal(resolveCodexProfileRuntime({
    ...base,
    secretState: { hasSecret: true, encryptionAvailable: true, decryptionFailed: true }
  }).status, 'secret_unavailable')
  assert.equal(resolveCodexProfileRuntime({
    ...base,
    secretState: { hasSecret: false, encryptionAvailable: true }
  }).status, 'secret_unavailable')
})

test('active profile changes remain pending while offline changes apply on next start', () => {
  assert.deepEqual(reconcileActiveProfile({
    session: {
      profileId: 'profile-b',
      activeProfileId: 'profile-a',
      profileRuntimeRevision: 'hash-a'
    },
    resolved: {
      profileId: 'profile-b',
      status: 'ready',
      canStart: true,
      runtimeRevision: 'hash-b'
    },
    isActive: true
  }), {
    profileId: 'profile-b',
    activeProfileId: 'profile-a',
    pendingProfileId: 'profile-b',
    profileStatus: 'ready',
    profileRuntimeRevision: 'hash-a',
    pendingProfileRuntimeRevision: 'hash-b',
    restartRequired: true,
    canStart: true
  })

  assert.deepEqual(reconcileActiveProfile({
    session: { profileId: 'profile-a', activeProfileId: null },
    resolved: {
      profileId: 'profile-b',
      status: 'ready',
      canStart: true,
      runtimeRevision: 'hash-b'
    },
    isActive: false
  }), {
    profileId: 'profile-b',
    activeProfileId: null,
    pendingProfileId: null,
    profileStatus: 'ready',
    profileRuntimeRevision: 'hash-b',
    pendingProfileRuntimeRevision: null,
    restartRequired: false,
    canStart: true
  })
})
