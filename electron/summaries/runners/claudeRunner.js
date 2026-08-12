import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  buildSummaryProcessEnvironment,
  normalizeRunnerResult,
  parseJsonOutput,
  resolveSafeCliLaunch,
  runProcess,
  runnerError,
  withIsolatedWorkingDirectory
} from './processRunner.js'

function defaultExecutableResolver() {
  return resolveSafeCliLaunch('claude')
}

function claudeValue(envelope) {
  if (envelope?.structured_output !== undefined) return envelope.structured_output
  if (envelope?.value !== undefined) return envelope.value
  if (typeof envelope?.result === 'string') return parseJsonOutput(envelope.result)
  if (typeof envelope?.output === 'string') return parseJsonOutput(envelope.output)
  return envelope
}

export function createClaudeRunner({
  profileService,
  resolveExecutable = defaultExecutableResolver,
  processRunner = runProcess,
  maxBudgetUsd = null
} = {}) {
  return {
    async run(options) {
      return withIsolatedWorkingDirectory(async (artifactDirectory) => {
        const workingDirectory = join(artifactDirectory, 'work')
        const isolatedHome = join(artifactDirectory, 'home')
        await mkdir(workingDirectory)
        const launch = resolveExecutable() || {}
        const baseEnv = await buildSummaryProcessEnvironment({
          provider: 'claude',
          isolatedHome,
          launchEnv: launch.env
        })
        let profileLaunch = { args: [], env: {} }
        if (options.profileId) {
          if (!profileService?.resolveLaunchProfile) {
            throw runnerError('SUMMARY_RUNNER_PROFILE_UNAVAILABLE', 'Claude profile resolution is unavailable')
          }
          profileLaunch = profileService.resolveLaunchProfile({
            profileId: options.profileId,
            session: { model: options.model },
            baseEnv
          })
        }
        const args = [
          ...(launch.prefixArgs || []),
          ...(profileLaunch.args || [])
        ]
        if (options.model && !args.includes('--model')) args.push('--model', options.model)
        args.push(
          '--disable-slash-commands',
          '--no-chrome',
          '-p',
          '--output-format', 'json',
          '--json-schema', JSON.stringify(options.schema || {}),
          '--no-session-persistence',
          '--tools', ''
        )
        const budget = options.maxBudgetUsd ?? maxBudgetUsd
        if (Number.isFinite(budget) && budget >= 0) {
          args.push('--max-budget-usd', String(budget))
        }

        const processResult = await processRunner({
          file: launch.file,
          args,
          prompt: options.prompt,
          cwd: workingDirectory,
          env: await buildSummaryProcessEnvironment({
            provider: 'claude',
            isolatedHome,
            baseEnv,
            launchEnv: launch.env,
            profileEnv: profileLaunch.env
          }),
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal: options.signal,
          onProgress: options.onProgress
        })
        const envelope = parseJsonOutput(processResult.stdout)
        return normalizeRunnerResult({
          value: claudeValue(envelope),
          schema: options.schema,
          usage: {
            inputTokens: envelope?.usage?.input_tokens,
            outputTokens: envelope?.usage?.output_tokens,
            costUsd: envelope?.total_cost_usd ?? envelope?.cost_usd
          },
          rawMetadata: {
            adapterId: 'claude',
            exitCode: processResult.exitCode,
            resultType: envelope?.type || null
          }
        })
      })
    }
  }
}
