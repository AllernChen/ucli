import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  readClaudeRuntimeSnapshot,
  resolveClaudeConfigDir
} from '../electron/claudeRuntimeConfig.js'

test('Claude config directory prefers CLAUDE_CONFIG_DIR without creating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-claude-dir-'))
  const configured = join(root, 'configured')
  const userHome = join(root, 'user')
  try {
    assert.equal(resolveClaudeConfigDir({
      env: { CLAUDE_CONFIG_DIR: configured },
      userHome
    }), configured)
    assert.equal(resolveClaudeConfigDir({ env: {}, userHome }), join(userHome, '.claude'))

    const snapshot = readClaudeRuntimeSnapshot({
      env: { CLAUDE_CONFIG_DIR: configured },
      userHome
    })
    assert.equal(snapshot.configDir, configured)
    assert.equal(snapshot.settingsPath, join(configured, 'settings.json'))
    assert.equal(snapshot.settingsMtimeMs, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude runtime snapshot reports auth kind without exposing values or settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-claude-runtime-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'settings-secret-must-not-leak' }
  }))

  try {
    const snapshot = readClaudeRuntimeSnapshot({
      env: {
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: 'environment-secret-must-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'lower-priority-secret'
      },
      userHome: root
    })
    assert.equal(snapshot.configDir, configDir)
    assert.equal(snapshot.inheritedAuthMode, 'api_key')
    assert.equal(snapshot.settingsMtimeMs > 0, true)
    const serialised = JSON.stringify(snapshot)
    for (const value of [
      'environment-secret-must-not-leak',
      'lower-priority-secret',
      'settings-secret-must-not-leak',
      'ANTHROPIC_API_KEY'
    ]) {
      assert.equal(serialised.includes(value), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude inherited auth detection uses stable presence-only precedence', () => {
  const cases = [
    [{ ANTHROPIC_AUTH_TOKEN: 'token' }, 'bearer'],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, 'cloud_provider'],
    [{ CLAUDE_CODE_USE_VERTEX: '1' }, 'cloud_provider'],
    [{ CLAUDE_CODE_USE_FOUNDRY: '1' }, 'cloud_provider'],
    [{ CLAUDE_CODE_USE_MANTLE: '1' }, 'cloud_provider'],
    [{}, 'login_or_unknown']
  ]

  for (const [env, inheritedAuthMode] of cases) {
    assert.equal(readClaudeRuntimeSnapshot({ env, userHome: 'C:\\Users\\Ada' }).inheritedAuthMode, inheritedAuthMode)
  }
})
