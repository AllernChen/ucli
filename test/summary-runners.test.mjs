import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  NATIVE_CAPABILITY_MATRIX,
  getNativeCapabilityMetadata
} from '../electron/summaries/nativeCapabilities.js'
import {
  parseJsonOutput,
  resolveSafeCliLaunch,
  runProcess
} from '../electron/summaries/runners/processRunner.js'
import { createClaudeRunner } from '../electron/summaries/runners/claudeRunner.js'
import { createCodexRunner } from '../electron/summaries/runners/codexRunner.js'
import { createOpenCodeRunner } from '../electron/summaries/runners/openCodeRunner.js'
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
    import { readdirSync, writeFileSync } from 'node:fs'
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { input += chunk })
    process.stdin.on('end', () => {
      const args = process.argv.slice(2)
      const mode = args[0]
      if (process.env.FAKE_CWD_CAPTURE) writeFileSync(process.env.FAKE_CWD_CAPTURE, process.cwd())
      if (process.env.FAKE_SLEEP) {
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
        const value = {
          summary: process.env.FAKE_INVALID_SCHEMA ? 42 : 'claude summary',
          prompt: input,
          cwd: process.cwd(),
          entries: readdirSync(process.cwd()),
          args
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
          summary: process.env.FAKE_INVALID_SCHEMA ? 42 : 'codex summary',
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
        const value = {
          summary: process.env.FAKE_INVALID_SCHEMA ? 42 : process.env.FAKE_ADAPTER + ' summary',
          prompt: input,
          cwd: process.cwd(),
          entries: readdirSync(process.cwd()),
          args
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

function executableResolver(fake, adapterId, extraEnv = {}) {
  return () => ({
    file: fake.file,
    prefixArgs: fake.prefixArgs,
    env: { ...process.env, FAKE_ADAPTER: adapterId, ...extraEnv }
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
        env: { ...process.env, FAKE_ADAPTER: 'claude' },
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
    assert.deepEqual(result.value.args.slice(-13), [
      '--profile-marker', '--model', 'sonnet', '-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--no-session-persistence',
      '--tools', '', '--max-budget-usd', '0.25'
    ])
    assert.equal(result.value.prompt, 'review work')
    assert.notEqual(result.value.cwd, 'F:\\must-not-run-here')
    assert.deepEqual(result.value.entries, [])
    assert.equal(existsSync(result.value.cwd), false)
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 4, costUsd: 0.12 })
    assert.equal(result.rawMetadata.adapterId, 'claude')
  } finally {
    fake.cleanup()
  }
})

test('Codex runner uses ephemeral read-only exec, temp schema/output, and stdin', async () => {
  const fake = createFakeExecutable()
  const profileService = {
    resolveLaunchProfile() {
      return {
        args: ['--profile', 'team'],
        env: { CODEX_API_KEY: 'fake' },
        artifact: { adapterId: 'codex' }
      }
    }
  }
  try {
    const result = await createCodexRunner({
      profileService,
      resolveExecutable: executableResolver(fake, 'codex')
    }).run({
      prompt: 'summarize codex',
      schema: SUMMARY_SCHEMA,
      profileId: 'codex-profile',
      model: 'gpt-test',
      cwd: 'F:\\project',
      timeoutMs: 5000,
      maxOutputBytes: 8192
    })
    const args = result.value.args
    assert.deepEqual(args.slice(0, 6), [
      '--profile', 'team', 'exec', '--ephemeral', '--sandbox', 'read-only'
    ])
    assert.ok(args.includes('--output-schema'))
    assert.ok(args.includes('-o'))
    assert.equal(args.at(-1), '-')
    assert.equal(result.value.prompt, 'summarize codex')
    assert.notEqual(result.value.cwd, 'F:\\project')
    assert.deepEqual(result.value.entries, [])
    assert.equal(existsSync(result.value.cwd), false)
    assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 3, costUsd: null })
  } finally {
    fake.cleanup()
  }
})

test('OpenCode and U-Code run JSONL mode in isolated directories and normalize usage', async () => {
  const fake = createFakeExecutable()
  try {
    for (const adapterId of ['opencode', 'ucode']) {
      const runner = createOpenCodeRunner({
        adapterId,
        resolveExecutable: executableResolver(fake, adapterId)
      })
      const result = await runner.run({
        prompt: `summarize ${adapterId}`,
        schema: SUMMARY_SCHEMA,
        model: 'test-model',
        cwd: 'F:\\project',
        timeoutMs: 5000,
        maxOutputBytes: 8192
      })
      assert.deepEqual(result.value.args.slice(-6), [
        'run', '--format', 'json', '--model', 'test-model', '-'
      ])
      assert.match(result.value.prompt, new RegExp(`^summarize ${adapterId}`))
      assert.match(result.value.prompt, /Return only JSON/)
      assert.deepEqual(result.value.entries, [])
      assert.equal(existsSync(result.value.cwd), false)
      assert.deepEqual(result.usage, {
        inputTokens: 7,
        outputTokens: 2,
        costUsd: adapterId === 'opencode' ? 0.05 : null
      })
    }
  } finally {
    fake.cleanup()
  }
})

test('summary runner routes providers and rejects unsupported executors and invalid schema results', async () => {
  const fake = createFakeExecutable()
  try {
    const runner = createSummaryRunner({
      executableResolvers: {
        claude: executableResolver(fake, 'claude'),
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
      resolveExecutable: executableResolver(fake, 'claude', { FAKE_INVALID_SCHEMA: '1' })
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
      cwd: fake.directory,
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

test('safe CLI resolution bypasses a Windows npm cmd shim without a shell', () => {
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
      resolveExecutable: executableResolver(fake, 'claude', {
        FAKE_SLEEP: '1',
        FAKE_CWD_CAPTURE: capturePath
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
