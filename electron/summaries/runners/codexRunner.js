import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  normalizeRunnerResult,
  parseJsonLines,
  resolveSafeCliLaunch,
  runProcess,
  runnerError,
  withIsolatedWorkingDirectory
} from './processRunner.js'

function defaultExecutableResolver() {
  return resolveSafeCliLaunch('codex')
}

function usageFromEvents(events) {
  const usage = [...events].reverse().find((event) => event?.usage)?.usage || {}
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    costUsd: usage.cost_usd ?? usage.costUsd
  }
}

function optionalJsonEvents(output) {
  if (!String(output || '').trim()) return []
  try {
    return parseJsonLines(output)
  } catch {
    return []
  }
}

export function createCodexRunner({
  profileService,
  resolveExecutable = defaultExecutableResolver,
  processRunner = runProcess
} = {}) {
  return {
    async run(options) {
      return withIsolatedWorkingDirectory(async (artifactDirectory) => {
        const workingDirectory = join(artifactDirectory, 'work')
        await mkdir(workingDirectory)
        const schemaPath = join(artifactDirectory, 'output-schema.json')
        const outputPath = join(artifactDirectory, 'output.json')
        await writeFile(schemaPath, JSON.stringify(options.schema || {}), 'utf8')

        const launch = resolveExecutable() || {}
        let profileLaunch = { args: [], env: {} }
        if (options.profileId) {
          if (!profileService?.resolveLaunchProfile) {
            throw runnerError('SUMMARY_RUNNER_PROFILE_UNAVAILABLE', 'Codex profile resolution is unavailable')
          }
          profileLaunch = profileService.resolveLaunchProfile({
            profileId: options.profileId,
            session: { model: options.model },
            baseEnv: process.env
          })
        }
        const args = [
          ...(launch.prefixArgs || []),
          ...(profileLaunch.args || []),
          'exec', '--ephemeral', '--sandbox', 'read-only',
          '--output-schema', schemaPath,
          '-o', outputPath
        ]
        if (options.model) args.push('--model', options.model)
        args.push('-')

        const processResult = await processRunner({
          file: launch.file,
          args,
          prompt: options.prompt,
          cwd: workingDirectory,
          env: { ...process.env, ...(launch.env || {}), ...(profileLaunch.env || {}) },
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal: options.signal,
          onProgress: options.onProgress
        })
        let value
        try {
          value = JSON.parse(await readFile(outputPath, 'utf8'))
        } catch (error) {
          throw runnerError('SUMMARY_RUNNER_INVALID_JSON', 'Codex did not produce valid structured output', {
            cause: error
          })
        }
        const events = optionalJsonEvents(processResult.stdout)
        return normalizeRunnerResult({
          value,
          schema: options.schema,
          usage: usageFromEvents(events),
          rawMetadata: {
            adapterId: 'codex',
            exitCode: processResult.exitCode,
            eventCount: events.length
          }
        })
      })
    }
  }
}
