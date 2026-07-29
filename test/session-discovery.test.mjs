import test from 'node:test'
import assert from 'node:assert/strict'

import {
  annotateImportedSessions,
  claudeProjectHash,
  findClaudeTranscriptFile,
  findCodexTranscriptFile,
  findClaudeProjectDirectory,
  listClaudeTranscriptFiles,
  parseCodexProviderConfig,
  resolveCodexResumeProvider
} from '../electron/sessionDiscovery.js'
import { buildCodexArgs } from '../electron/adapters/codexAdapter.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('already imported native sessions remain visible and are marked as added', () => {
  const result = annotateImportedSessions(
    [{ sessionId: 'native-1', name: 'existing' }, { sessionId: 'native-2', name: 'new' }],
    new Set(['native-1'])
  )
  assert.deepEqual(result, [
    { sessionId: 'native-1', name: 'existing', imported: true },
    { sessionId: 'native-2', name: 'new', imported: false }
  ])
})

test('Claude project hash replaces each non-ASCII Windows path character', () => {
  assert.equal(claudeProjectHash('F:\\项目\\GZXS'), 'F-----GZXS')
  assert.equal(claudeProjectHash('F:\\项目\\99前期项目\\openMAINT'), 'F-----99-----openMAINT')
  assert.equal(claudeProjectHash('F:\\cxj\\projects\\card_check'), 'F--cxj-projects-card-check')
})

test('Claude project directory resolver finds transcripts for Chinese cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'ucli-claude-discovery-'))
  const projectDir = join(home, '.claude', 'projects', 'F-----GZXS')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'session-1.jsonl'), JSON.stringify({
    type: 'user', sessionId: 'session-1', cwd: 'F:\\项目\\GZXS'
  }) + '\n')
  try {
    assert.equal(findClaudeProjectDirectory(home, 'F:\\项目\\GZXS'), projectDir)
    assert.deepEqual(listClaudeTranscriptFiles(home, 'F:\\项目\\GZXS').map((item) => item.sessionId), ['session-1'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider transcript resolvers return only the requested native session file', () => {
  const home = mkdtempSync(join(tmpdir(), 'ucli-history-source-'))
  const claudeDir = join(home, '.claude', 'projects', 'F--projects-ucli')
  const codexDir = join(home, '.codex', 'sessions', '2026', '07', '29')
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(codexDir, { recursive: true })
  const claudePath = join(claudeDir, 'claude-native.jsonl')
  const codexPath = join(codexDir, 'rollout-2026-07-29-codex-native.jsonl')
  writeFileSync(claudePath, '{}\n')
  writeFileSync(codexPath, '{}\n')

  try {
    assert.equal(
      findClaudeTranscriptFile(home, 'F:\\projects\\ucli', 'claude-native'),
      claudePath
    )
    assert.equal(findCodexTranscriptFile(home, 'codex-native'), codexPath)
    assert.equal(findClaudeTranscriptFile(home, 'F:\\projects\\ucli', '../escape'), null)
    assert.equal(findCodexTranscriptFile(home, '../escape'), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('missing historical Codex provider falls back to current built-in provider', () => {
  const config = parseCodexProviderConfig('')
  assert.equal(config.currentProvider, 'openai')
  assert.deepEqual(config.availableProviders, ['openai'])
  assert.deepEqual(resolveCodexResumeProvider('cubence_codex', config), {
    sourceProvider: 'cubence_codex',
    resumeProvider: 'openai',
    providerChanged: true
  })
})

test('available historical Codex provider is preserved', () => {
  const config = parseCodexProviderConfig(`
model_provider = "current_gateway"
[model_providers.cubence_codex]
name = "Legacy"
[model_providers.current_gateway]
name = "Current"
`)
  assert.deepEqual(resolveCodexResumeProvider('cubence_codex', config), {
    sourceProvider: 'cubence_codex',
    resumeProvider: 'cubence_codex',
    providerChanged: false
  })
})

test('Codex resume args override the provider selected for this UCLI session', () => {
  assert.deepEqual(buildCodexArgs({
    cliSessionId: '019f217c-5274-7280-87b2-ffb4b8728f8b',
    model: null,
    provider: 'openai'
  }), [
    '--no-alt-screen',
    '-c',
    'tui.notifications=true',
    '-c',
    'tui.notification_method="osc9"',
    '-c',
    'tui.notification_condition="always"',
    'resume',
    '019f217c-5274-7280-87b2-ffb4b8728f8b',
    '-c',
    'model_provider=openai'
  ])
})
