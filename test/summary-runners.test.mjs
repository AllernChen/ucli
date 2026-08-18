import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  NATIVE_CAPABILITY_MATRIX,
  getNativeCapabilityMetadata,
  getSummaryExecutorCapability
} from '../electron/summaries/nativeCapabilities.js'
import {
  parseJsonOutput,
  resolveSafeCliLaunch,
  runProcess
} from '../electron/summaries/runners/processRunner.js'
import { createClaudeRunner } from '../electron/summaries/runners/claudeRunner.js'
import {
  createCodexRunner,
  readBoundedCodexOutput
} from '../electron/summaries/runners/codexRunner.js'
import { createOpenCodeRunner } from '../electron/summaries/runners/openCodeRunner.js'
import {
  MAX_SUMMARY_AUTH_BYTES,
  readSafeOpenCodeAuth
} from '../electron/summaries/runners/authBridge.js'
import { createSummaryRunner } from '../electron/summaries/summaryRunner.js'

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' }
  }
}

function createFakeExecutable() {
  const directory = mkdtempSync(join(tmpdir(), 'ucli-summary-fake-cli-'))
  const script = join(directory, 'fake cli.mjs')
  writeFileSync(script, `
    import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { createHash } from 'node:crypto'
    import { join } from 'node:path'
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { input += chunk })
    process.stdin.on('end', () => {
      const args = process.argv.slice(2)
      const mode = args[0]
      const captureIndex = args.indexOf('--fake-capture')
      if (captureIndex >= 0) writeFileSync(args[captureIndex + 1], process.cwd())
      if (args.includes('--fake-sleep')) {
        setTimeout(() => process.stdout.write('{}'), 10000)
        return
      }
      if (mode === 'echo') {
        process.stdout.write(JSON.stringify({ prompt: input, cwd: process.cwd(), args: process.argv.slice(3) }))
      } else if (mode === 'exit') {
        process.stderr.write('fake failure')
        process.exitCode = 7
      } else if (mode === 'stdout-limit') {
        process.stdout.write('x'.repeat(4096))
      } else if (mode === 'stderr-limit') {
        process.stderr.write('x'.repeat(4096))
      } else if (mode === 'sleep') {
        setTimeout(() => process.stdout.write('{}'), 10000)
      } else if (mode === 'json') {
        process.stdout.write('{"ok":true}')
      } else if (args.includes('-p')) {
        const claudeCredentialPath = join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')
        const claudeCredentialBytes = existsSync(claudeCredentialPath) ? readFileSync(claudeCredentialPath) : null
        const value = {
          summary: input === 'bad' ? 42 : 'claude summary',
          prompt: input,
          cwd: process.cwd(),
          entries: readdirSync(process.cwd()),
          args,
          env: {
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            APPDATA: process.env.APPDATA,
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
            AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
            SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
            UNRELATED_SECRET: process.env.UNRELATED_SECRET
          },
          auth: claudeCredentialBytes
            ? { exists: true, sha256: createHash('sha256').update(claudeCredentialBytes).digest('hex'), bytes: claudeCredentialBytes.length }
            : { exists: false, sha256: null, bytes: 0 }
        }
        process.stdout.write(JSON.stringify({
          type: 'result',
          structured_output: value,
          usage: { input_tokens: 11, output_tokens: 4 },
          total_cost_usd: 0.12
        }))
      } else if (args.includes('exec')) {
        const outputIndex = args.indexOf('-o')
        const value = {
          summary: input === 'bad' ? 42 : 'codex summary',
          prompt: input,
          cwd: process.cwd(),
          entries: readdirSync(process.cwd()),
          args
        }
        writeFileSync(args[outputIndex + 1], JSON.stringify(value))
        process.stdout.write(JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 9, output_tokens: 3 }
        }))
      } else if (args.includes('run')) {
        const authPath = join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
        const authBytes = existsSync(authPath) ? readFileSync(authPath) : null
        const value = {
          summary: 'opencode summary',
          prompt: input,
          cwd: process.cwd(),
          entries: readdirSync(process.cwd()),
          args,
          env: {
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
            OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS,
            OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
            OPENCODE_DISABLE_LSP_DOWNLOAD: process.env.OPENCODE_DISABLE_LSP_DOWNLOAD,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
            AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
            SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK
          },
          auth: authBytes
            ? { exists: true, sha256: createHash('sha256').update(authBytes).digest('hex'), bytes: authBytes.length }
            : { exists: false, sha256: null, bytes: 0 },
          dataEntries: readdirSync(process.env.XDG_DATA_HOME).sort(),
          authDirectoryEntries: existsSync(join(process.env.XDG_DATA_HOME, 'opencode'))
            ? readdirSync(join(process.env.XDG_DATA_HOME, 'opencode')).sort()
            : []
        }
        process.stdout.write(JSON.stringify({ type: 'text', part: { text: JSON.stringify(value) } }) + '\\n')
        process.stdout.write(JSON.stringify({
          type: 'step_finish',
          part: { tokens: { input: 7, output: 2 }, cost: process.env.FAKE_ADAPTER === 'opencode' ? 0.05 : null }
        }) + '\\n')
      }
    })
  `)
  return {
    file: process.execPath,
    prefixArgs: [script],
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('AI CLI capabilities are explicit and Claude insights stays manual experimental metadata', () => {
  assert.deepEqual(NATIVE_CAPABILITY_MATRIX, {
    claude: {
      structuredOutput: true,
      nativeUsage: false,
      nativeRetrospective: true,
      existingSessionDigest: false,
      safeTranscriptExport: false
    },
    codex: {
      structuredOutput: true,
      nativeUsage: false,
      nativeRetrospective: false,
      existingSessionDigest: false,
      safeTranscriptExport: false
    },
    opencode: {
      structuredOutput: true,
      nativeUsage: true,
      nativeRetrospective: false,
      existingSessionDigest: true,
      safeTranscriptExport: true
    },
    ucode: {
      structuredOutput: true,
      nativeUsage: false,
      nativeRetrospective: false,
      existingSessionDigest: true,
      safeTranscriptExport: true
    }
  })
  assert.deepEqual(getNativeCapabilityMetadata('claude'), {
    nativeRetrospective: {
      command: '/insights',
      invocation: 'manual',
      stability: 'experimental'
    }
  })
  assert.equal(getNativeCapabilityMetadata('claude').invokeNativeRetrospective, undefined)
})

test('summary executor safety is distinct from general CLI capability', () => {
  assert.deepEqual(getSummaryExecutorCapability('claude'), {
    available: true,
    noToolsEnforcement: 'cli-flag',
    reason: null
  })
  assert.deepEqual(getSummaryExecutorCapability('opencode'), {
    available: true,
    noToolsEnforcement: 'permission-wildcard',
    reason: null
  })
  for (const adapterId of ['codex', 'ucode']) {
    assert.deepEqual(getSummaryExecutorCapability(adapterId), {
      available: false,
      noToolsEnforcement: null,
      reason: 'no-guaranteed-no-tools-mode'
    })
    assert.equal(NATIVE_CAPABILITY_MATRIX[adapterId].structuredOutput, true)
  }
})

function executableResolver(fake, adapterId, extraEnv = {}) {
  return () => ({
    file: fake.file,
    prefixArgs: fake.prefixArgs,
    // Deliberately do not spread process.env — the fake runs under
    // process.execPath and the test must not inherit the host's real provider
    // credentials (e.g. ANTHROPIC_AUTH_TOKEN), which would defeat endpoint
    // stripping assertions.
    env: { FAKE_ADAPTER: adapterId, ...extraEnv }
  })
}

test('Claude runner uses print JSON schema mode, a resolved profile, and an isolated cwd', async () => {
  const fake = createFakeExecutable()
  const profileCalls = []
  const profileService = {
    resolveLaunchProfile(options) {
      profileCalls.push(options)
      return {
        args: ['--profile-marker'],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'allowed-claude-auth',
          ANTHROPIC_BASE_URL: 'https://paired-claude.example',
          AWS_SECRET_ACCESS_KEY: 'must-not-leak',
          SSH_AUTH_SOCK: 'must-not-leak',
          UNRELATED_SECRET: 'must-not-leak'
        },
        artifact: { adapterId: 'claude' }
      }
    }
  }
  try {
    const result = await createClaudeRunner({
      profileService,
      resolveExecutable: executableResolver(fake, 'claude')
    }).run({
      prompt: 'review work',
      schema: SUMMARY_SCHEMA,
      profileId: 'profile-1',
      model: 'sonnet',
      cwd: 'F:\\must-not-run-here',
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      maxBudgetUsd: 0.25
    })

    assert.equal(profileCalls[0].profileId, 'profile-1')
    assert.deepEqual(result.value.args.slice(-15), [
      '--profile-marker', '--model', 'sonnet', '--disable-slash-commands',
      '--no-chrome', '-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--no-session-persistence',
      '--tools', '', '--max-budget-usd', '0.25'
    ])
    assert.equal(result.value.prompt, 'review work')
    assert.notEqual(result.value.cwd, 'F:\\must-not-run-here')
    assert.deepEqual(result.value.entries, [])
    assert.equal(result.value.env.ANTHROPIC_API_KEY, 'allowed-claude-auth')
    assert.equal(result.value.env.ANTHROPIC_BASE_URL, 'https://paired-claude.example')
    assert.equal(result.value.env.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(result.value.env.SSH_AUTH_SOCK, undefined)
    assert.equal(result.value.env.UNRELATED_SECRET, undefined)
    assert.ok(result.value.env.HOME)
    assert.equal(result.value.env.HOME, result.value.env.USERPROFILE)
    assert.notEqual(result.value.env.HOME, process.env.HOME)
    assert.ok(result.value.env.XDG_CONFIG_HOME.startsWith(result.value.env.HOME))
    assert.ok(result.value.env.APPDATA.startsWith(result.value.env.HOME))
    assert.equal(existsSync(result.value.cwd), false)
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 4, costUsd: 0.12 })
    assert.equal(result.rawMetadata.adapterId, 'claude')
  } finally {
    fake.cleanup()
  }
})

test('Claude uses only an explicitly validated persistent work directory and deletes only isolated HOME', async () => {
  const fake = createFakeExecutable()
  const root = mkdtempSync(join(tmpdir(), 'ucli-persistent-workspace-'))
  const work = join(root, 'work')
  mkdirSync(work)
  try {
    const runner = createClaudeRunner({
      resolveExecutable: executableResolver(fake, 'claude', { ANTHROPIC_API_KEY: 'workspace-key' }),
      validateWorkspaceDirectory: candidate => candidate === work
    })
    const result = await runner.run({
      prompt: 'persistent workspace', schema: SUMMARY_SCHEMA,
      workspaceDirectory: work, timeoutMs: 5000, maxOutputBytes: 8192
    })
    // The child reports process.cwd(), which macOS resolves through the /var
    // -> /private/var alias; compare against the canonical directory.
    assert.equal(result.value.cwd, realpathSync(work))
    assert.deepEqual(result.value.entries, [])
    assert.ok(result.value.env.HOME)
    assert.equal(result.value.env.HOME.startsWith(root), false)
    assert.equal(existsSync(result.value.env.HOME), false)
    assert.equal(existsSync(work), true)

    await assert.rejects(
      runner.run({
        prompt: 'forged', schema: SUMMARY_SCHEMA,
        workspaceDirectory: join(root, 'forged'), timeoutMs: 5000, maxOutputBytes: 8192
      }),
      error => error?.code === 'SUMMARY_WORKSPACE_DIRECTORY_INVALID'
    )
    const rejectingRunner = createClaudeRunner({
      validateWorkspaceDirectory() { throw new Error('validator detail') }
    })
    await assert.rejects(
      rejectingRunner.run({ prompt: 'forged', schema: SUMMARY_SCHEMA, workspaceDirectory: work }),
      error => error?.code === 'SUMMARY_WORKSPACE_DIRECTORY_INVALID' &&
        !error.message.includes('validator detail')
    )
  } finally {
    fake.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude text mode returns stdout directly without JSON schema arguments', async () => {
  let invocation
  const runner = createClaudeRunner({
    baseEnv: { ANTHROPIC_API_KEY: 'text-mode-key' },
    resolveExecutable: () => ({ file: 'claude-test', prefixArgs: [] }),
    processRunner: async options => {
      invocation = options
      return { stdout: '<!doctype html><html><body>report</body></html>', stderr: '', exitCode: 0 }
    }
  })

  const result = await runner.run({
    prompt: 'render HTML only',
    outputMode: 'text',
    timeoutMs: 5000,
    maxOutputBytes: 8192
  })

  assert.equal(result.value, '<!doctype html><html><body>report</body></html>')
  assert.ok(invocation.args.includes('--output-format'))
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'text')
  assert.equal(invocation.args.includes('--json-schema'), false)
})

test('Claude bridges only a validated credentials file into its isolated config and removes it afterward', {
  skip: process.platform === 'win32'
}, async () => {
  const fake = createFakeExecutable()
  const sourceHome = mkdtempSync(join(tmpdir(), 'ucli-claude-auth-source-'))
  const sourceConfig = join(sourceHome, '.claude')
  const credentialsPath = join(sourceConfig, '.credentials.json')
  const credentialBytes = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'never-output-secret' } }))
  mkdirSync(sourceConfig)
  writeFileSync(credentialsPath, credentialBytes, { mode: 0o600 })
  writeFileSync(join(sourceConfig, 'settings.json'), '{"hooks":{"must":"not-copy"}}')
  try {
    const result = await createClaudeRunner({
      baseEnv: {
        PATH: process.env.PATH,
        USERPROFILE: sourceHome,
        HOME: sourceHome,
        ANTHROPIC_BASE_URL: 'https://attacker.invalid'
      },
      resolveExecutable: () => ({ file: fake.file, prefixArgs: fake.prefixArgs })
    }).run({
      prompt: 'summarize with subscription auth',
      schema: SUMMARY_SCHEMA,
      timeoutMs: 5000,
      maxOutputBytes: 8192
    })
    assert.deepEqual(result.value.auth, {
      exists: true,
      sha256: createHash('sha256').update(credentialBytes).digest('hex'),
      bytes: credentialBytes.length
    })
    assert.equal(JSON.stringify(result.value).includes('never-output-secret'), false)
    assert.equal(result.value.env.ANTHROPIC_BASE_URL, undefined)
    assert.equal(existsSync(result.value.env.CLAUDE_CONFIG_DIR), false)
    const sourceAfter = readFileSync(credentialsPath)
    assert.equal(sourceAfter.length, credentialBytes.length)
    assert.equal(
      createHash('sha256').update(sourceAfter).digest('hex'),
      createHash('sha256').update(credentialBytes).digest('hex')
    )
  } finally {
    fake.cleanup()
    rmSync(sourceHome, { recursive: true, force: true })
  }
})

test('Codex summary execution fails closed because exec has no no-tools mode', async () => {
  let processCalled = false
  const runner = createCodexRunner({
    resolveExecutable: () => { throw new Error('must not resolve') },
    processRunner: async () => { processCalled = true }
  })
  await assert.rejects(
    runner.run({ prompt: 'untrusted evidence', schema: SUMMARY_SCHEMA }),
    error => error.code === 'SUMMARY_EXECUTOR_UNSAFE'
  )
  assert.equal(processCalled, false)
})

test('Codex output files are byte-bounded before JSON or schema parsing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ucli-codex-output-limit-'))
  const outputPath = join(directory, 'output.json')
  try {
    writeFileSync(outputPath, Buffer.alloc(1025, 0x78))
    await assert.rejects(
      readBoundedCodexOutput(outputPath, 1024),
      error => error.code === 'SUMMARY_RUNNER_OUTPUT_LIMIT' &&
        error.stream === 'output-file' && error.maxOutputBytes === 1024
    )
    writeFileSync(outputPath, '{"summary":"ok"}')
    assert.equal(await readBoundedCodexOutput(outputPath, 1024), '{"summary":"ok"}')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('OpenCode denies every tool and runs pure with isolated config and allowlisted auth', async () => {
  const fake = createFakeExecutable()
  try {
    const runner = createOpenCodeRunner({
      adapterId: 'opencode',
      baseEnv: { PATH: process.env.PATH || '' },
      resolveExecutable: executableResolver(fake, 'opencode', {
        OPENAI_API_KEY: 'allowed-openai-auth',
        OPENAI_BASE_URL: 'https://paired-openai.example',
        ANTHROPIC_BASE_URL: 'https://unpaired-anthropic.invalid',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        SSH_AUTH_SOCK: 'must-not-leak'
      })
    })
    const result = await runner.run({
      prompt: 'summarize opencode',
      schema: SUMMARY_SCHEMA,
      model: 'openai/test-model',
      cwd: 'F:\\project',
      timeoutMs: 5000,
      maxOutputBytes: 8192
    })
    assert.deepEqual(result.value.args.slice(-7), [
      '--pure', 'run', '--format', 'json', '--model', 'openai/test-model', '-'
    ])
    assert.equal(result.value.env.OPENCODE_PERMISSION, JSON.stringify({ '*': 'deny' }))
    assert.deepEqual(JSON.parse(result.value.env.OPENCODE_CONFIG_CONTENT), {
      permission: { '*': 'deny' },
      instructions: [],
      plugin: [],
      mcp: {},
      lsp: false
    })
    assert.equal(result.value.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '1')
    assert.equal(result.value.env.OPENCODE_DISABLE_CLAUDE_CODE, '1')
    assert.equal(result.value.env.OPENCODE_DISABLE_LSP_DOWNLOAD, '1')
    assert.equal(result.value.env.OPENAI_API_KEY, 'allowed-openai-auth')
    assert.equal(result.value.env.OPENAI_BASE_URL, 'https://paired-openai.example')
    assert.equal(result.value.env.ANTHROPIC_BASE_URL, undefined)
    assert.equal(result.value.env.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(result.value.env.SSH_AUTH_SOCK, undefined)
    assert.ok(result.value.env.HOME)
    assert.equal(result.value.env.HOME, result.value.env.USERPROFILE)
    assert.notEqual(result.value.cwd, 'F:\\project')
    assert.deepEqual(result.value.entries, [])
    assert.equal(existsSync(result.value.cwd), false)
  } finally {
    fake.cleanup()
  }
})

test('OpenCode runs in a validated persistent work directory without exposing its isolated HOME', async () => {
  const fake = createFakeExecutable()
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-workspace-'))
  const work = join(root, 'work')
  mkdirSync(work)
  try {
    const result = await createOpenCodeRunner({
      adapterId: 'opencode',
      resolveExecutable: executableResolver(fake, 'opencode', { OPENAI_API_KEY: 'workspace-key' }),
      validateWorkspaceDirectory: candidate => candidate === work
    }).run({
      prompt: 'persistent workspace', schema: SUMMARY_SCHEMA,
      workspaceDirectory: work, timeoutMs: 5000, maxOutputBytes: 8192
    })
    // The child reports process.cwd(), which macOS resolves through the /var
    // -> /private/var alias; compare against the canonical directory.
    assert.equal(result.value.cwd, realpathSync(work))
    assert.equal(result.value.env.HOME.startsWith(root), false)
    assert.equal(existsSync(result.value.env.HOME), false)
    assert.equal(existsSync(work), true)
  } finally {
    fake.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode text mode concatenates text events without asking the model for JSON', async () => {
  let invocation
  const runner = createOpenCodeRunner({
    adapterId: 'opencode',
    baseEnv: { OPENAI_API_KEY: 'text-mode-key' },
    resolveExecutable: () => ({ file: 'opencode-test', prefixArgs: [] }),
    processRunner: async options => {
      invocation = options
      return {
        stdout: [
          JSON.stringify({ type: 'text', part: { text: '<!doctype html><html>' } }),
          JSON.stringify({ type: 'text', part: { text: '<body>report</body></html>' } }),
          JSON.stringify({ type: 'step_finish', part: { tokens: { input: 3, output: 4 } } })
        ].join('\n'),
        stderr: '',
        exitCode: 0
      }
    }
  })

  const result = await runner.run({
    prompt: 'render HTML only',
    outputMode: 'text',
    timeoutMs: 5000,
    maxOutputBytes: 8192
  })

  assert.equal(result.value, '<!doctype html><html><body>report</body></html>')
  assert.equal(invocation.prompt, 'render HTML only')
})

test('OpenCode bridges only a validated auth.json into isolated data and removes it afterward', {
  skip: process.platform === 'win32'
}, async () => {
  const fake = createFakeExecutable()
  const sourceDataHome = mkdtempSync(join(tmpdir(), 'ucli-opencode-auth-source-'))
  const authDirectory = join(sourceDataHome, 'opencode')
  const authPath = join(authDirectory, 'auth.json')
  const authBytes = Buffer.from(JSON.stringify({ openai: { type: 'api', key: 'test-secret-never-output' } }))
  mkdirSync(authDirectory)
  writeFileSync(authPath, authBytes, { mode: 0o600 })
  mkdirSync(join(sourceDataHome, 'opencode', 'storage'))
  writeFileSync(join(sourceDataHome, 'opencode', 'storage', 'session.json'), '{"private":true}')
  try {
    const runner = createOpenCodeRunner({
      adapterId: 'opencode',
      baseEnv: {
        PATH: process.env.PATH,
        XDG_DATA_HOME: sourceDataHome,
        OPENAI_BASE_URL: 'https://attacker.invalid',
        ANTHROPIC_BASE_URL: 'https://attacker.invalid'
      },
      resolveExecutable: () => ({ file: fake.file, prefixArgs: fake.prefixArgs })
    })
    const result = await runner.run({
      prompt: 'summarize with stored auth',
      schema: SUMMARY_SCHEMA,
      model: 'openai/test-model',
      timeoutMs: 5000,
      maxOutputBytes: 8192
    })
    assert.deepEqual(result.value.auth, {
      exists: true,
      sha256: createHash('sha256').update(authBytes).digest('hex'),
      bytes: authBytes.length
    })
    assert.equal(JSON.stringify(result.value).includes('test-secret-never-output'), false)
    assert.equal(result.value.env.OPENAI_BASE_URL, undefined)
    assert.equal(result.value.env.ANTHROPIC_BASE_URL, undefined)
    assert.deepEqual(result.value.dataEntries, ['opencode'])
    assert.deepEqual(result.value.authDirectoryEntries, ['auth.json'])
    assert.equal(existsSync(result.value.env.XDG_DATA_HOME), false)
    const sourceAfter = readFileSync(authPath)
    assert.equal(sourceAfter.length, authBytes.length)
    assert.equal(
      createHash('sha256').update(sourceAfter).digest('hex'),
      createHash('sha256').update(authBytes).digest('hex')
    )
  } finally {
    fake.cleanup()
    rmSync(sourceDataHome, { recursive: true, force: true })
  }
})

test('OpenCode rejects unsafe auth files before starting the summary process', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-unsafe-auth-'))
  const authDirectory = join(root, 'opencode')
  mkdirSync(authDirectory)
  const cases = []
  const directoryPath = join(authDirectory, 'directory-auth.json')
  mkdirSync(directoryPath)
  cases.push(['non-regular', directoryPath, 'unsafe-auth-file'])
  const oversizedPath = join(authDirectory, 'oversized-auth.json')
  writeFileSync(oversizedPath, Buffer.alloc(MAX_SUMMARY_AUTH_BYTES + 1, 0x20), { mode: 0o600 })
  cases.push(['oversized', oversizedPath, 'auth-file-too-large'])
  const malformedPath = join(authDirectory, 'malformed-auth.json')
  writeFileSync(malformedPath, '{{', { mode: 0o600 })
  cases.push(['malformed', malformedPath, 'invalid-auth-file'])

  const targetPath = join(authDirectory, 'target-auth.json')
  const linkedPath = join(authDirectory, 'linked-auth.json')
  writeFileSync(targetPath, '{"provider":{"type":"api"}}', { mode: 0o600 })
  try {
    symlinkSync(targetPath, linkedPath, 'file')
    cases.push(['symlink', linkedPath, 'unsafe-auth-file'])
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
    t.diagnostic('symlink creation is unavailable on this host')
  }

  try {
    for (const [name, path, reason] of cases) {
      await t.test(name, async () => {
        const result = await readSafeOpenCodeAuth(path)
        assert.equal(result.available, false)
        assert.equal(result.reason, reason)
        assert.equal(result.bytes, null)
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode rejects group-writable auth on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-auth-mode-'))
  const authPath = join(root, 'auth.json')
  writeFileSync(authPath, '{"provider":{"type":"api"}}', { mode: 0o600 })
  chmodSync(authPath, 0o620)
  try {
    const result = await readSafeOpenCodeAuth(authPath)
    assert.equal(result.available, false)
    assert.equal(result.reason, 'unsafe-auth-file-permissions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('credential files must be owner-only readable on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-auth-readable-'))
  const authPath = join(root, 'auth.json')
  writeFileSync(authPath, '{"provider":{"type":"api","key":"secret"}}', { mode: 0o600 })
  chmodSync(authPath, 0o640)
  try {
    const result = await readSafeOpenCodeAuth(authPath)
    assert.equal(result.available, false)
    assert.equal(result.reason, 'unsafe-auth-file-permissions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode rejects syntactically valid JSON that is not a credential record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-auth-shape-'))
  const authPath = join(root, 'auth.json')
  try {
    for (const value of [
      { x: 1 },
      { provider: { type: 'invented', secret: 'value' } },
      { provider: { type: 'api' } },
      { provider: { type: 'oauth', refresh: 'refresh', access: 'access' } }
    ]) {
      writeFileSync(authPath, JSON.stringify(value), { mode: 0o600 })
      const result = await readSafeOpenCodeAuth(authPath)
      assert.equal(result.available, false)
      assert.equal(result.reason, 'invalid-auth-file')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode rejects a credential reached through a Windows directory junction', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-opencode-auth-junction-'))
  const target = join(root, 'target')
  const junction = join(root, 'junction')
  mkdirSync(target)
  writeFileSync(join(target, 'auth.json'), '{"provider":{"type":"api","key":"secret"}}')
  symlinkSync(target, junction, 'junction')
  try {
    const result = await readSafeOpenCodeAuth(join(junction, 'auth.json'))
    assert.equal(result.available, false)
    assert.equal(result.reason, 'unsafe-auth-file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode fails with a typed authentication error before spawning when no safe credential exists', async () => {
  const sourceDataHome = mkdtempSync(join(tmpdir(), 'ucli-opencode-no-auth-'))
  let processCalled = false
  try {
    const runner = createOpenCodeRunner({
      adapterId: 'opencode',
      baseEnv: { PATH: process.env.PATH, XDG_DATA_HOME: sourceDataHome },
      resolveExecutable: () => ({ file: 'unused-opencode', prefixArgs: [] }),
      processRunner: async () => { processCalled = true }
    })
    await assert.rejects(
      runner.run({ prompt: 'summarize', schema: SUMMARY_SCHEMA }),
      error => error.code === 'SUMMARY_EXECUTOR_AUTH_UNAVAILABLE'
    )
    assert.equal(processCalled, false)
  } finally {
    rmSync(sourceDataHome, { recursive: true, force: true })
  }
})

test('Windows disk credentials fail closed before either summary process starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ucli-windows-disk-auth-'))
  const claudeConfig = join(root, '.claude')
  const openCodeData = join(root, 'data')
  mkdirSync(claudeConfig)
  mkdirSync(join(openCodeData, 'opencode'), { recursive: true })
  writeFileSync(
    join(claudeConfig, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"must-not-bridge"}}'
  )
  writeFileSync(
    join(openCodeData, 'opencode', 'auth.json'),
    '{"openai":{"type":"api","key":"must-not-bridge"}}'
  )
  let processCalls = 0
  try {
    const common = {
      platform: 'win32',
      resolveExecutable: () => ({ file: 'unused', prefixArgs: [] }),
      processRunner: async () => { processCalls += 1 }
    }
    await assert.rejects(
      createClaudeRunner({
        ...common,
        baseEnv: { PATH: process.env.PATH, USERPROFILE: root, HOME: root }
      }).run({ prompt: 'summary', schema: SUMMARY_SCHEMA }),
      error => error.code === 'SUMMARY_EXECUTOR_AUTH_UNAVAILABLE'
    )
    await assert.rejects(
      createOpenCodeRunner({
        ...common,
        adapterId: 'opencode',
        baseEnv: { PATH: process.env.PATH, XDG_DATA_HOME: openCodeData }
      }).run({ prompt: 'summary', schema: SUMMARY_SCHEMA }),
      error => error.code === 'SUMMARY_EXECUTOR_AUTH_UNAVAILABLE'
    )
    assert.equal(processCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('U-Code summary execution fails closed without a guaranteed no-tools mode', async () => {
  let processCalled = false
  const runner = createOpenCodeRunner({
    adapterId: 'ucode',
    resolveExecutable: () => { throw new Error('must not resolve') },
    processRunner: async () => { processCalled = true }
  })
  await assert.rejects(
    runner.run({ prompt: 'untrusted evidence', schema: SUMMARY_SCHEMA }),
    error => error.code === 'SUMMARY_EXECUTOR_UNSAFE'
  )
  assert.equal(processCalled, false)
})

test('summary runner routes providers and rejects unsupported executors and invalid schema results', async () => {
  const fake = createFakeExecutable()
  try {
    const runner = createSummaryRunner({
      executableResolvers: {
        claude: executableResolver(fake, 'claude', { ANTHROPIC_API_KEY: 'route-test-key' }),
        codex: executableResolver(fake, 'codex'),
        opencode: executableResolver(fake, 'opencode'),
        ucode: executableResolver(fake, 'ucode')
      }
    })
    const result = await runner.run({
      executorId: 'claude',
      prompt: 'route this',
      schema: SUMMARY_SCHEMA,
      timeoutMs: 5000,
      maxOutputBytes: 8192
    })
    assert.equal(result.value.summary, 'claude summary')
    await assert.rejects(
      runner.run({ executorId: 'unknown', prompt: '', schema: SUMMARY_SCHEMA }),
      (error) => error.code === 'SUMMARY_RUNNER_UNSUPPORTED_EXECUTOR'
    )

    const invalidRunner = createClaudeRunner({
      resolveExecutable: executableResolver(fake, 'claude', { ANTHROPIC_API_KEY: 'schema-test-key' })
    })
    await assert.rejects(
      invalidRunner.run({ prompt: 'bad', schema: SUMMARY_SCHEMA }),
      (error) => error.code === 'SUMMARY_RUNNER_SCHEMA_INVALID'
    )
  } finally {
    fake.cleanup()
  }
})

test('process runner sends the prompt through stdin with shell disabled', async () => {
  const fake = createFakeExecutable()
  let spawnOptions = null
  try {
    const result = await runProcess({
      file: fake.file,
      args: [...fake.prefixArgs, 'echo', '--flag'],
      prompt: 'summarize this',
      cwd: fake.directory,
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      spawnImpl: (file, args, options) => {
        spawnOptions = options
        return spawn(file, args, options)
      }
    })
    assert.equal(spawnOptions.shell, false)
    assert.equal(spawnOptions.cwd, fake.directory)
    assert.deepEqual(parseJsonOutput(result.stdout), {
      prompt: 'summarize this',
      // The child echoes process.cwd(), which macOS resolves through the
      // /var -> /private/var alias; compare against the canonical directory.
      cwd: realpathSync(fake.directory),
      args: ['--flag']
    })
  } finally {
    fake.cleanup()
  }
})

test('process runner maps exit codes, timeouts, aborts, and output limits to typed errors', async () => {
  const fake = createFakeExecutable()
  const invoke = (mode, overrides = {}) => runProcess({
    file: fake.file,
    args: [...fake.prefixArgs, mode],
    prompt: 'prompt',
    cwd: fake.directory,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    ...overrides
  })
  try {
    await assert.rejects(invoke('exit'), (error) => error.code === 'SUMMARY_RUNNER_EXIT' && error.exitCode === 7)
    await assert.rejects(invoke('sleep', { timeoutMs: 20 }), (error) => error.code === 'SUMMARY_RUNNER_TIMEOUT')
    for (const mode of ['stdout-limit', 'stderr-limit']) {
      await assert.rejects(invoke(mode), (error) => error.code === 'SUMMARY_RUNNER_OUTPUT_LIMIT')
    }
    const controller = new AbortController()
    const pending = invoke('sleep', { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, (error) => error.code === 'SUMMARY_RUNNER_ABORTED')
  } finally {
    fake.cleanup()
  }
})

test('safe CLI resolution bypasses a Windows npm cmd shim without a shell', {
  skip: process.platform !== 'win32' && 'the fixture builds Windows-path .cmd shims'
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ucli-safe-cli-'))
  const shim = join(directory, 'claude.cmd')
  const entry = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  const nativeEntry = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  try {
    mkdirSync(join(directory, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true })
    mkdirSync(join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true })
    writeFileSync(entry, '')
    writeFileSync(nativeEntry, '')
    writeFileSync(shim, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*')
    assert.deepEqual(resolveSafeCliLaunch('claude', {
      platform: 'win32',
      candidates: [shim]
    }), {
      file: nativeEntry,
      prefixArgs: []
    })
    writeFileSync(shim, '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*')
    assert.deepEqual(resolveSafeCliLaunch('claude', {
      platform: 'win32',
      candidates: [shim],
      nodeCandidates: [process.execPath]
    }), {
      file: process.execPath,
      prefixArgs: [entry]
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('provider abort waits for process exit before deleting the isolated cwd', async () => {
  const fake = createFakeExecutable()
  const captureDirectory = mkdtempSync(join(tmpdir(), 'ucli-summary-capture-'))
  const capturePath = join(captureDirectory, 'cwd.txt')
  const controller = new AbortController()
  try {
    const pending = createClaudeRunner({
      resolveExecutable: () => ({
        file: fake.file,
        prefixArgs: [...fake.prefixArgs, '--fake-sleep', '--fake-capture', capturePath],
        env: { ...process.env, ANTHROPIC_API_KEY: 'abort-test-key' }
      })
    }).run({
      prompt: 'abort this',
      schema: SUMMARY_SCHEMA,
      signal: controller.signal,
      timeoutMs: 5000
    })
    while (!existsSync(capturePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()
    await assert.rejects(pending, (error) => error.code === 'SUMMARY_RUNNER_ABORTED')
    const isolatedCwd = String(await import('node:fs/promises').then(({ readFile }) => readFile(capturePath, 'utf8')))
    assert.equal(existsSync(isolatedCwd), false)
  } finally {
    fake.cleanup()
    rmSync(captureDirectory, { recursive: true, force: true })
  }
})

test('JSON output parsing rejects invalid output with a typed error', () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true })
  assert.throws(
    () => parseJsonOutput('not json'),
    (error) => error.code === 'SUMMARY_RUNNER_INVALID_JSON'
  )
})
