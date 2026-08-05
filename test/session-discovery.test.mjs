import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import {
  annotateImportedSessions,
  claudeProjectHash,
  findClaudeTranscriptFile,
  findCodexTranscriptFile,
  findCodexTranscriptFileInHome,
  findClaudeProjectDirectory,
  isSafeNativeSessionId,
  listClaudeTranscriptFiles,
  parseCodexProviderConfig,
  resolveCodexResumeProvider,
  resolveCodexTranscriptSessionInHome
} from '../electron/sessionDiscovery.js'
import { buildCodexArgs, codexDescriptor } from '../electron/adapters/codexAdapter.js'
import { getDb, openDb } from '../electron/persistence/db.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./fixtures/electron-stub-loader.mjs', import.meta.url)

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

test('Codex transcript resolver supports an explicit CODEX_HOME directory', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-explicit-home-'))
  const sessionId = 'codex-configured-home'
  const transcript = join(codexHome, 'sessions', '2026', '08', '04', `rollout-${sessionId}.jsonl`)
  mkdirSync(join(codexHome, 'sessions', '2026', '08', '04'), { recursive: true })
  writeFileSync(transcript, '{}\n')
  try {
    assert.equal(findCodexTranscriptFileInHome(codexHome, sessionId), transcript)
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex transcript resolver follows resumed rollout forks to the latest context', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ucli-codex-lineage-'))
  const cwd = 'F:\\projects\\ucli'
  const originalId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const resumedId = '019fbd2e-0167-7b20-8b58-5b37606e7442'
  const currentId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  const originalDir = join(codexHome, 'sessions', '2026', '07', '31')
  const resumedDir = join(codexHome, 'sessions', '2026', '08', '01')
  const currentDir = join(codexHome, 'sessions', '2026', '08', '04')
  const subagentDir = join(codexHome, 'sessions', '2026', '08', '05')
  mkdirSync(originalDir, { recursive: true })
  mkdirSync(resumedDir, { recursive: true })
  mkdirSync(currentDir, { recursive: true })
  mkdirSync(subagentDir, { recursive: true })
  const original = join(originalDir, `rollout-${originalId}.jsonl`)
  const resumed = join(resumedDir, `rollout-${resumedId}.jsonl`)
  const current = join(currentDir, `rollout-${currentId}.jsonl`)
  const subagentId = '019fd0c3-a019-7ad0-a634-489043a4f49c'
  writeFileSync(original, JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-31T10:45:56.141Z',
    payload: { id: originalId, timestamp: '2026-07-31T10:45:56.141Z', cwd }
  }) + '\n')
  writeFileSync(resumed, JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-01T11:55:37.001Z',
    payload: {
      id: resumedId,
      forked_from_id: originalId,
      timestamp: '2026-08-01T11:55:36.780Z',
      cwd
    }
  }) + '\n')
  writeFileSync(current, JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-04T03:16:45.513Z',
    payload: {
      id: currentId,
      forked_from_id: resumedId,
      timestamp: '2026-08-04T03:16:44.963Z',
      cwd
    }
  }) + '\n')
  writeFileSync(join(subagentDir, `rollout-${subagentId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-05T07:11:49.672Z',
    payload: {
      session_id: currentId,
      id: subagentId,
      parent_thread_id: currentId,
      timestamp: '2026-08-05T07:11:49.365Z',
      cwd,
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: currentId } } }
    }
  }) + '\n')

  try {
    assert.equal(resolveCodexTranscriptSessionInHome(codexHome, originalId)?.path, current)
    assert.equal(resolveCodexTranscriptSessionInHome(codexHome, subagentId)?.path, current)
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Codex descriptor discovers the native session needed after a UCLI restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ucli-codex-restart-'))
  const codexDir = join(home, '.codex', 'sessions', '2026', '07', '31')
  const cwd = 'F:\\projects\\ucli'
  const sessionId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const startedAt = '2026-07-31T10:45:56.141Z'
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    join(codexDir, `rollout-2026-07-31-${sessionId}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      timestamp: startedAt,
      payload: { id: sessionId, timestamp: startedAt, cwd }
    }) + '\n'
  )

  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  const previousCodexHome = process.env.CODEX_HOME
  delete process.env.HOME
  delete process.env.CODEX_HOME
  process.env.USERPROFILE = home
  try {
    const sessions = await codexDescriptor.listNativeSessions(cwd)
    assert.deepEqual(sessions.map(({ sessionId: id, startedAt: timestamp }) => ({ id, timestamp })), [
      { id: sessionId, timestamp: Date.parse(startedAt) }
    ])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('UCLI restart recovers a Codex session from the earliest of multiple rollout files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-multi-rollout-'))
  const userData = join(root, 'user-data')
  const codexHome = join(root, 'codex-home')
  const codexDir = join(codexHome, 'sessions', '2026', '07', '31')
  const cwd = 'F:\\projects\\ucli'
  const ucliSessionId = '86c7ff49-9090-4e79-bf3f-b6428cae75ff'
  const nativeSessionId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const createdAt = Date.parse('2026-07-31T10:45:55.178Z')
  const earliestRollout = '2026-07-31T10:45:56.141Z'
  const resumedRollout = '2026-08-01T08:59:11.617Z'
  mkdirSync(userData, { recursive: true })
  mkdirSync(codexDir, { recursive: true })

  for (const [suffix, timestamp] of [['original', earliestRollout], ['resumed', resumedRollout]]) {
    writeFileSync(
      join(codexDir, `rollout-${suffix}-${nativeSessionId}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp,
        payload: { id: nativeSessionId, timestamp, cwd }
      }) + '\n'
    )
  }

  const dbPath = join(userData, 'ucli.db')
  const seed = await openDb(dbPath)
  seed.insertSession({
    id: ucliSessionId,
    project_path: cwd,
    adapter_id: 'codex',
    native_session_id: null,
    name: 'UCLI',
    task_note: '',
    tier: 'safety-rules',
    model: null,
    status: 'idle',
    created_at: createdAt
  })
  seed.flush()
  seed.close()

  const previousCodexHome = process.env.CODEX_HOME
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.CODEX_HOME = codexHome
  process.env.UCLI_TEST_USER_DATA = userData
  let orchestrator = null
  try {
    const { createOrchestrator } = await import('../electron/orchestrator.js?multi-rollout-recovery')
    orchestrator = createOrchestrator()
    await orchestrator.initPersistence()

    const restored = getDb().listSessions().find((session) => session.id === ucliSessionId)
    assert.equal(restored.nativeSessionId, nativeSessionId)
  } finally {
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

test('UCLI restart persists the latest Codex rollout descended from its stored binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-lineage-recovery-'))
  const userData = join(root, 'user-data')
  const codexHome = join(root, 'codex-home')
  const originalDir = join(codexHome, 'sessions', '2026', '07', '31')
  const currentDir = join(codexHome, 'sessions', '2026', '08', '04')
  const cwd = 'F:\\projects\\ucli'
  const ucliSessionId = '86c7ff49-9090-4e79-bf3f-b6428cae75ff'
  const originalId = '019fb7c7-daa8-7c31-af6e-a8372324ec6e'
  const currentId = '019fcac6-0c62-7da1-92ff-454e53dab197'
  mkdirSync(userData, { recursive: true })
  mkdirSync(originalDir, { recursive: true })
  mkdirSync(currentDir, { recursive: true })
  writeFileSync(join(originalDir, `rollout-${originalId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-31T10:45:56.141Z',
    payload: { id: originalId, timestamp: '2026-07-31T10:45:56.141Z', cwd }
  }) + '\n')
  writeFileSync(join(currentDir, `rollout-${currentId}.jsonl`), JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-04T03:16:45.513Z',
    payload: {
      id: currentId,
      forked_from_id: originalId,
      timestamp: '2026-08-04T03:16:44.963Z',
      cwd
    }
  }) + '\n')

  const dbPath = join(userData, 'ucli.db')
  const seed = await openDb(dbPath)
  seed.insertSession({
    id: ucliSessionId,
    project_path: cwd,
    adapter_id: 'codex',
    native_session_id: originalId,
    name: 'UCLI',
    task_note: '',
    tier: 'safety-rules',
    model: null,
    status: 'idle',
    created_at: Date.parse('2026-07-31T10:45:55.178Z')
  })
  seed.flush()
  seed.close()

  const previousCodexHome = process.env.CODEX_HOME
  const previousUserData = process.env.UCLI_TEST_USER_DATA
  process.env.CODEX_HOME = codexHome
  process.env.UCLI_TEST_USER_DATA = userData
  let orchestrator = null
  try {
    const { createOrchestrator } = await import('../electron/orchestrator.js?lineage-recovery')
    orchestrator = createOrchestrator()
    await orchestrator.initPersistence()

    const restored = getDb().listSessions().find((session) => session.id === ucliSessionId)
    assert.equal(restored.nativeSessionId, currentId)
  } finally {
    await orchestrator?.shutdown()
    getDb()?.close()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    if (previousUserData === undefined) delete process.env.UCLI_TEST_USER_DATA
    else process.env.UCLI_TEST_USER_DATA = previousUserData
    rmSync(root, { recursive: true, force: true })
  }
})

test('native session IDs reject command and path syntax before reaching a CLI', () => {
  assert.equal(isSafeNativeSessionId('ses_01HZX-safe'), true)
  assert.equal(isSafeNativeSessionId('019f217c-5274-7280-87b2-ffb4b8728f8b'), true)
  assert.equal(isSafeNativeSessionId('ses_safe & calc.exe'), false)
  assert.equal(isSafeNativeSessionId('ses_safe|whoami'), false)
  assert.equal(isSafeNativeSessionId('../escape'), false)
  assert.equal(isSafeNativeSessionId(''), false)
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
