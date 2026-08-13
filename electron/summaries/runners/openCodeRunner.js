import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveOpenCodeLaunch } from '../../adapters/openCodeAdapter.js'
import { resolveUCodeLaunch } from '../../adapters/ucodeAdapter.js'

import {
  buildSummaryProcessEnvironment,
  hasSummaryProviderAuthentication,
  normalizeRunnerResult,
  parseJsonLines,
  parseJsonOutput,
  runProcess,
  runnerError,
  stripSummaryProviderEndpoints,
  withIsolatedWorkingDirectory
} from './processRunner.js'
import { bridgeOpenCodeAuthentication } from './authBridge.js'

function strictPrompt(prompt, schema) {
  return `${prompt}\n\nReturn only JSON matching this schema: ${JSON.stringify(schema || {})}`
}
function eventText(event) {
  if (typeof event?.part?.text === 'string') return event.part.text
  if (typeof event?.text === 'string') return event.text
  if (typeof event?.content === 'string') return event.content
  if (typeof event?.result === 'string') return event.result
  return null
}

function eventUsage(events) {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = null
  for (const event of events) {
    const usage = event?.usage || event?.part?.tokens
    inputTokens += Number.isFinite(usage?.input_tokens ?? usage?.input)
      ? (usage.input_tokens ?? usage.input)
      : 0
    outputTokens += Number.isFinite(usage?.output_tokens ?? usage?.output)
      ? (usage.output_tokens ?? usage.output)
      : 0
    const cost = event?.cost ?? event?.part?.cost
    if (Number.isFinite(cost) && cost >= 0) costUsd = (costUsd || 0) + cost
  }
  return { inputTokens, outputTokens, costUsd }
}

export function createOpenCodeRunner({
  adapterId = 'opencode',
  resolveExecutable,
  processRunner = runProcess,
  baseEnv = process.env,
  platform = process.platform,
  validateWorkspaceDirectory = null
} = {}) {
  if (!['opencode', 'ucode'].includes(adapterId)) {
    throw runnerError('SUMMARY_RUNNER_UNSUPPORTED_EXECUTOR', `Unsupported executor: ${adapterId}`)
  }
  const resolver = resolveExecutable || (adapterId === 'ucode' ? resolveUCodeLaunch : resolveOpenCodeLaunch)
  return {
    async run(options) {
      if (adapterId === 'ucode') {
        throw runnerError(
          'SUMMARY_EXECUTOR_UNSAFE',
          'ucode summary execution is unavailable because no guaranteed no-tools mode is available'
        )
      }
      if (options.profileId) {
        throw runnerError('SUMMARY_RUNNER_PROFILE_UNSUPPORTED', `${adapterId} does not support AI CLI profiles`)
      }
      return withIsolatedWorkingDirectory(async (artifactDirectory, persistentWorkDirectory) => {
        const workingDirectory = persistentWorkDirectory || join(artifactDirectory, 'work')
        const isolatedHome = join(artifactDirectory, 'home')
        if (!persistentWorkDirectory) await mkdir(workingDirectory)
        const launch = resolver() || {}
        const args = [
          ...(launch.prefixArgs || []),
          '--pure', 'run', '--format', 'json'
        ]
        if (options.model) args.push('--model', options.model)
        args.push('-')
        const env = await buildSummaryProcessEnvironment({
          provider: 'opencode',
          isolatedHome,
          baseEnv,
          launchEnv: launch.env
        })
        stripSummaryProviderEndpoints('opencode', env)
        if (!hasSummaryProviderAuthentication('opencode', env)) {
          const authentication = await bridgeOpenCodeAuthentication({
            sourceEnv: { ...baseEnv, ...(launch.env || {}) },
            isolatedDataHome: env.XDG_DATA_HOME,
            platform
          })
          if (!authentication.available) {
            throw runnerError(
              'SUMMARY_EXECUTOR_AUTH_UNAVAILABLE',
              'OpenCode summary authentication is unavailable'
            )
          }
        }
        Object.assign(env, {
          OPENCODE_CLIENT: 'ucli-summary',
          OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: { '*': 'deny' },
            instructions: [],
            plugin: [],
            mcp: {},
            lsp: false
          }),
          OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
          OPENCODE_DISABLE_CLAUDE_CODE: '1',
          OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
          OPENCODE_DISABLE_LSP_DOWNLOAD: '1'
        })
        const textOutput = options.outputMode === 'text'
        const processResult = await processRunner({
          file: launch.file,
          args,
          prompt: textOutput ? options.prompt : strictPrompt(options.prompt, options.schema),
          cwd: workingDirectory,
          env,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal: options.signal,
          onProgress: options.onProgress
        })
        const events = parseJsonLines(processResult.stdout)
        const text = events.map(eventText).filter(Boolean).join('')
        const directValue = [...events].reverse().find((event) => event?.value !== undefined)?.value
        const value = textOutput
          ? text
          : directValue !== undefined ? directValue : parseJsonOutput(text)
        return normalizeRunnerResult({
          value,
          schema: textOutput ? undefined : options.schema,
          usage: eventUsage(events),
          rawMetadata: {
            adapterId,
            exitCode: processResult.exitCode,
            eventCount: events.length
          }
        })
      }, {
        workingDirectory: options.workspaceDirectory || null,
        validateWorkingDirectory: validateWorkspaceDirectory
      })
    }
  }
}
