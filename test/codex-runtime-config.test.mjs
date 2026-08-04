import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseCodexProviderIdentity,
  readCodexRuntimeSnapshot,
  resolveCodexHome
} from '../electron/codexRuntimeConfig.js'

test('configured Codex directory takes precedence over CODEX_HOME and user home', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-home-'))
  const configuredDir = join(root, 'configured')
  const envDir = join(root, 'environment')
  const userHome = join(root, 'user')
  try {
    assert.equal(
      resolveCodexHome({ configuredDir, env: { CODEX_HOME: envDir }, userHome }),
      configuredDir
    )
    assert.equal(
      resolveCodexHome({ env: { CODEX_HOME: envDir }, userHome }),
      envDir
    )
    assert.equal(
      resolveCodexHome({ env: {}, userHome }),
      join(userHome, '.codex')
    )
    assert.equal(
      resolveCodexHome({ env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'profile') } }),
      join(root, 'home', '.codex')
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex runtime snapshot exposes only provider identity and ignores unsafe provider keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-config-'))
  const codexHome = join(root, '.codex')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'config.toml'), `
model_provider = "work_gateway"
experimental_bearer_token = "test-secret-must-not-leak"
[model_providers.work_gateway]
name = "Work Gateway"
[model_providers.legacy_gateway]
name = "Legacy Gateway"
[model_providers."unsafe;provider"]
name = "Ignored"
`)

  try {
    assert.deepEqual(parseCodexProviderIdentity(`
model_provider = "work_gateway"
[model_providers.work_gateway]
name = "Work Gateway"
[model_providers."unsafe;provider"]
name = "Ignored"
`), {
      currentProvider: 'work_gateway',
      availableProviders: ['openai', 'work_gateway']
    })

    const snapshot = readCodexRuntimeSnapshot(codexHome)
    assert.equal(snapshot.codexHome, codexHome)
    assert.equal(snapshot.configPath, join(codexHome, 'config.toml'))
    assert.equal(snapshot.currentProvider, 'work_gateway')
    assert.deepEqual(snapshot.availableProviders, ['openai', 'work_gateway', 'legacy_gateway'])
    assert.equal('content' in snapshot, false)
    assert.equal(JSON.stringify(snapshot).includes('test-secret-must-not-leak'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalid or missing Codex config safely falls back to openai', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-invalid-config-'))
  try {
    assert.deepEqual(readCodexRuntimeSnapshot(root), {
      codexHome: root,
      configPath: join(root, 'config.toml'),
      currentProvider: 'openai',
      availableProviders: ['openai'],
      mtimeMs: 0
    })
    writeFileSync(join(root, 'config.toml'), 'model_provider = [')
    assert.deepEqual(parseCodexProviderIdentity('model_provider = ['), {
      currentProvider: 'openai',
      availableProviders: ['openai']
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
